// Look at, and change, what a hosted user has: their plan, their credits, and
// what they have spent. Payments (Stripe) set a plan and add credits by
// themselves; this is for a gift, a correction, or a plan given by hand, and
// calls the same functions (billing.ts and ledger.ts).
//
//   AWS_PROFILE=jassydev npm run admin -- show   <email|id>
//   AWS_PROFILE=jassydev npm run admin -- grant  <email|id> <credits>      credits, as people see them (100 a dollar); negative takes some back
//   AWS_PROFILE=jassydev npm run admin -- plan   <email|id> <ore|ingot|facet|foundry> [days]
//   AWS_PROFILE=jassydev npm run admin -- report [week]                    everyone's spend, biggest first, and the free pool
//   AWS_PROFILE=jassydev npm run admin -- ai      <email|id>                AI apps (Claude and others) connected to the account over MCP
//   AWS_PROFILE=jassydev npm run admin -- ai-revoke <email|id>              cuts all of them off; they have to be signed in again
//   AWS_PROFILE=jassydev npm run admin -- welcome <email>                  sends the welcome email to that address now (to see it, or to send it again)
//   npm run admin -- welcome-html > welcome.html                           the welcome email as a page to open in a browser; sends nothing
//   npm run admin -- whats-new-html <id> > whats-new.html                 the what's-new email for an announcement (draft or live); sends nothing
//   AWS_PROFILE=jassydev npm run admin -- whats-new <id> --test <email>    sends it to that one address now
//   AWS_PROFILE=jassydev npm run admin -- whats-new <id> --all             counts who it would go to, sends nothing
//   AWS_PROFILE=jassydev npm run admin -- whats-new <id> --all --yes       sends it to everyone who has not unsubscribed or had it
//       <id> is an entry in website/announcements.json; --all needs it published (announce.py publish), and
//       UNSUBSCRIBE_URL=$(aws cloudformation describe-stacks --stack-name CopperOS-<stage> \
//         --query "Stacks[0].Outputs[?OutputKey=='UnsubscribeUrl'].OutputValue" --output text)
//   AWS_PROFILE=jassydev npm run admin -- encrypt <email|id|all>          encrypts what was saved before saving was encrypted
//       needs TRANSCRIPTS_BUCKET=$(aws cloudformation describe-stacks --stack-name CopperOS-<stage> \
//         --query "Stacks[0].Outputs[?OutputKey=='TranscriptsBucket'].OutputValue" --output text)
//
// STAGE picks the deployment (default prod). An email is looked up in the
// sign-in pool; if it matches more than one sign-in, pass the id instead.

import {
  CognitoIdentityProviderClient,
  ListUserPoolsCommand,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { readFileSync } from "node:fs";
import path from "node:path";
import { creditsOf, MICROS_PER_CREDIT, monthOf, toUsd, usageSummary, weekOf, type PlanId } from "./billing.js";

const stage = process.env.STAGE ?? "prod";
process.env.STAGE = stage;
process.env.ACCOUNTS_TABLE ??= `copperos-${stage}-accounts`;
process.env.USAGE_TABLE ??= `copperos-${stage}-usage`;
process.env.LIMITS_PARAM ??= `/copperos/${stage}/limits`;
process.env.RUNTIME_PARAM ??= `/copperos/${stage}/runtime`;
// What `encrypt` reads and writes. The bucket's name is made by CloudFormation: the
// stack prints it as TranscriptsBucket (see the comment at the top).
process.env.CHATS_TABLE ??= `copperos-${stage}-chats`;
process.env.TASKS_TABLE ??= `copperos-${stage}-tasks`;
process.env.MEMORIES_TABLE ??= `copperos-${stage}-memories`;
process.env.WORKFLOWS_TABLE ??= `copperos-${stage}-workflows`;
process.env.MCP_AUTH_TABLE ??= `copperos-${stage}-mcpauth`;
process.env.FROM_ADDRESS ??= "no-reply@copper.jassydev.com";
process.env.USER_KEYS_PARAM ??= `/copperos/${stage}/user-keys-secret`;
process.env.AWS_REGION ??= "us-east-1";

// Loaded after the environment above is set: the ledger reads it as it runs.
const { dynamoLedger, loadLimits, loadRuntime } = await import("./ledger.js");
const { encryptUserData } = await import("../store/cloud.js");
const { dynamoAuthStore } = await import("./mcp-store.js");
const { sendWelcome } = await import("./welcome.js");
const { welcomeEmail } = await import("./welcome-email.js");
const { whatsNewEmail } = await import("./updates-email.js");
const { listRecipients, sendWhatsNew, unsubscribeLink } = await import("./updates.js");
const { sendMail } = await import("./mail.js");

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito = new CognitoIdentityProviderClient({});

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const money = (usd: number) => `$${usd.toFixed(usd < 1 ? 4 : 2)}`;

/** The sign-in pool's id. */
async function poolId(): Promise<string> {
  let id: string | undefined;
  let token: string | undefined;
  do {
    const page = await cognito.send(new ListUserPoolsCommand({ MaxResults: 60, NextToken: token }));
    id = page.UserPools?.find((p) => p.Name === `copperos-${stage}-users`)?.Id;
    token = id ? undefined : page.NextToken;
  } while (token);
  return id ?? fail(`No sign-in pool named copperos-${stage}-users. Is STAGE right?`);
}

/** The user id (Cognito `sub`) behind an email, or the id itself. */
async function resolve(who: string | undefined): Promise<string> {
  if (!who) return fail("Say whose: an email or a user id.");
  if (!who.includes("@")) return who;
  const found = await cognito.send(
    new ListUsersCommand({ UserPoolId: await poolId(), Filter: `email = "${who.replace(/"/g, "")}"`, Limit: 10 }),
  );
  const ids = (found.Users ?? []).map((u) => u.Attributes?.find((a) => a.Name === "sub")?.Value).filter(Boolean) as string[];
  if (ids.length === 0) return fail(`Nobody has signed in as ${who}.`);
  if (ids.length > 1) return fail(`${who} has ${ids.length} sign-ins; pass one of these ids instead:\n  ${ids.join("\n  ")}`);
  return ids[0];
}

/** An announcement from the website's files: the live list first, then the drafts. */
function announcement(id: string | undefined): { entry: import("./updates-email.js").WhatsNew; live: boolean } {
  if (!id) return fail("Say which announcement: its id (python3 website/announce.py list).");
  const dir = process.env.WEBSITE_DIR ?? path.resolve(import.meta.dirname, "../../../website");
  for (const [file, live] of [["announcements.json", true], ["announcements.draft.json", false]] as const) {
    let list: Array<Record<string, unknown>> = [];
    try {
      list = JSON.parse(readFileSync(path.join(dir, file), "utf8")).announcements ?? [];
    } catch {
      continue;
    }
    const hit = list.find((a) => a.id === id);
    if (hit) return { entry: hit as unknown as import("./updates-email.js").WhatsNew, live };
  }
  return fail(`No announcement "${id}" in ${dir}. See: python3 website/announce.py list`);
}

function unsubscribeBase(): string {
  return (
    process.env.UNSUBSCRIBE_URL ||
    fail(
      "Set UNSUBSCRIBE_URL to the stack's UnsubscribeUrl output:\n" +
        `  export UNSUBSCRIBE_URL=$(aws cloudformation describe-stacks --stack-name CopperOS-${stage} --query "Stacks[0].Outputs[?OutputKey=='UnsubscribeUrl'].OutputValue" --output text)`,
    )
  );
}

async function show(userId: string): Promise<void> {
  const s = await usageSummary(userId, dynamoLedger, loadLimits, Date.now(), loadRuntime);
  console.log(`user      ${userId}`);
  console.log(`plan      ${s.planName}${s.planUntil ? ` until ${new Date(s.planUntil).toISOString().slice(0, 10)}` : ""}`);
  console.log(
    `this ${s.period} ${money(s.spentUsd)} of ${money(s.allowanceUsd)}, ${s.leftPct}% left (resets ${new Date(s.resetsAt).toISOString().slice(0, 10)}); ` +
      `${s.tokens.input + s.tokens.output} tokens (${s.tokens.input} in, ${s.tokens.output} out, ${s.tokens.cached} cached)`,
  );
  console.log(`credits   ${s.credits} (${money(s.creditsUsd)} of model use)`);
  if (s.runtime) {
    const r = s.runtime;
    const task = r.taskMinutes === null ? "no limit on a task" : `a task runs up to ${r.taskMinutes / 60} h`;
    const week = r.weeklyHours === null ? "no weekly cap" : `${r.usedHours} of ${r.weeklyHours} h used this week`;
    console.log(`running   ${task}; ${week}`);
  }
  if (s.poolFull) console.log(`free pool is spent: Ore is stopped until ${new Date(s.poolResetsAt).toISOString().slice(0, 10)}`);
  const weeks = await db.send(
    new QueryCommand({
      TableName: process.env.USAGE_TABLE,
      KeyConditionExpression: "userId = :u",
      ExpressionAttributeValues: { ":u": userId },
      ScanIndexForward: false,
      Limit: 8,
    }),
  );
  console.log("\nweek        spent      calls   input tokens  cached     output");
  for (const w of weeks.Items ?? []) {
    console.log(
      `${w.week}  ${money(toUsd(w.spent ?? 0)).padEnd(9)}  ${String(w.calls ?? 0).padEnd(6)}  ` +
        `${String(w.inTokens ?? 0).padEnd(12)}  ${String(w.cachedTokens ?? 0).padEnd(9)}  ${w.outTokens ?? 0}`,
    );
  }
}

async function report(week: string): Promise<void> {
  const rows: Array<{ userId: string; spent: number; calls: number }> = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await db.send(
      new ScanCommand({
        TableName: process.env.USAGE_TABLE,
        FilterExpression: "#w = :w",
        ExpressionAttributeNames: { "#w": "week" },
        ExpressionAttributeValues: { ":w": week },
        ExclusiveStartKey: start,
      }),
    );
    for (const i of res.Items ?? []) rows.push({ userId: i.userId, spent: i.spent ?? 0, calls: i.calls ?? 0 });
    start = res.LastEvaluatedKey;
  } while (start);
  rows.sort((a, b) => b.spent - a.spent);
  const total = rows.reduce((n, r) => n + r.spent, 0);
  console.log(`week ${week}: ${rows.length} users, ${money(toUsd(total))} in all, ${money(toUsd(total / Math.max(1, rows.length)))} each on average`);
  for (const r of rows.slice(0, 15)) console.log(`  ${r.userId}  ${money(toUsd(r.spent)).padEnd(9)}  ${r.calls} calls`);
  // What the free plan has cost everyone this month, against the ceiling that stops it.
  const month = monthOf(Date.now());
  const pool = await dynamoLedger.poolSpent(month.id);
  const ceiling = (await loadLimits()).freePool;
  console.log(
    `\nfree pool ${month.id}: ${money(toUsd(pool))} of ${money(ceiling)} (${Math.round((toUsd(pool) / ceiling) * 100)}%)` +
      (toUsd(pool) >= ceiling ? " — spent, Ore is stopped until the month turns" : ""),
  );
}

/** Every account: the ids in the Accounts table, not the items that only point at one (Stripe links, purchase claims). */
async function everyone(): Promise<string[]> {
  const ids: string[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await db.send(
      new ScanCommand({ TableName: process.env.ACCOUNTS_TABLE, ProjectionExpression: "userId", ExclusiveStartKey: start }),
    );
    for (const i of res.Items ?? []) if (!/^(stripe|claim)#/.test(i.userId)) ids.push(i.userId);
    start = res.LastEvaluatedKey;
  } while (start);
  return ids;
}

const [command, who, arg, days] = process.argv.slice(2);
switch (command) {
  case "show":
    await show(await resolve(who));
    break;
  case "grant": {
    const credits = Number(arg);
    if (!Number.isInteger(credits) || credits === 0) fail("Say how many credits: grant <email|id> <credits>");
    const userId = await resolve(who);
    const balance = await dynamoLedger.addCredits(userId, credits * MICROS_PER_CREDIT);
    console.log(`${credits > 0 ? "Added" : "Took"} ${Math.abs(credits)} credits. Credits now ${creditsOf(balance)}.`);
    break;
  }
  case "plan": {
    if (arg !== "ore" && arg !== "ingot" && arg !== "facet" && arg !== "foundry") fail("Say the plan: plan <email|id> <ore|ingot|facet|foundry> [days]");
    const userId = await resolve(who);
    const until = days ? Date.now() + Number(days) * 24 * 60 * 60 * 1000 : undefined;
    if (days && !Number.isFinite(until)) fail("days must be a number");
    // A plan given by hand counts its month from today.
    await dynamoLedger.setPlan(userId, arg as PlanId, until, arg === "ore" ? undefined : Date.now());
    console.log(`Plan set to ${arg}${until ? ` until ${new Date(until).toISOString().slice(0, 10)}` : ""}.`);
    break;
  }
  case "report":
    await report(who ?? weekOf(Date.now()).id);
    break;
  case "welcome": {
    if (!who?.includes("@")) fail("Say where to send it: welcome <email>");
    await sendWelcome(who!);
    console.log(`Sent the welcome email to ${who}.`);
    break;
  }
  case "whats-new-html": {
    const { entry } = announcement(who);
    // A link to nowhere: this is for looking at.
    console.log(whatsNewEmail({ entry, unsubscribeUrl: "https://copper.jassydev.com/" }).html);
    break;
  }
  case "whats-new": {
    const { entry, live } = announcement(who);
    if (arg === "--test") {
      const to = days;
      if (!to?.includes("@")) fail("Say where to send it: whats-new <id> --test <email>");
      const link = await unsubscribeLink(unsubscribeBase(), "preview");
      await sendMail({ to: to!, ...whatsNewEmail({ entry, unsubscribeUrl: link }), headers: { "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
      console.log(`Sent "${entry.title}" to ${to}. Its Unsubscribe link is a test one: it changes nothing.`);
      break;
    }
    if (arg !== "--all") fail("Say who: whats-new <id> --test <email>   or   whats-new <id> --all [--yes]");
    // What goes to everyone is what was published, not a draft.
    if (!live) fail(`"${entry.id}" is still a draft. Publish it first (python3 website/announce.py publish ${entry.id}, then ./deploy.sh), then run this again.`);
    const yes = process.argv.includes("--yes");
    const { recipients, unusable } = await listRecipients(await poolId());
    const out = await sendWhatsNew({ entry, recipients, unsubscribeBase: unsubscribeBase(), dryRun: !yes, delayMs: 100 });
    console.log(`"${entry.title}" (${entry.id})`);
    console.log(`${out.recipients} people can be emailed${unusable ? `, ${unusable} sign-ins cannot (not confirmed, disabled, or an unverified address)` : ""}.`);
    console.log(`${out.optedOut} unsubscribed, ${out.alreadySent} already had it.`);
    if (!yes) {
      console.log(`${out.wouldSend} would be sent it. Nothing was sent. To send: add --yes`);
    } else {
      console.log(`${out.sent} sent${out.failed ? `, ${out.failed} failed: ${out.errors.join("; ")}` : ""}.${out.failed ? " Run it again to retry the failed ones." : ""}`);
    }
    break;
  }
  case "welcome-html":
    console.log(welcomeEmail({ support: process.env.REPLY_TO ?? "hello@jassydev.com" }).html);
    break;
  case "ai": {
    const userId = await resolve(who);
    const auth = dynamoAuthStore();
    const apps = new Map<string, { access: number; refresh: number; until: number }>();
    for (const r of await auth.recordsOf(userId)) {
      const id = String(r.id);
      const kind = id.startsWith("access#") ? "access" : id.startsWith("refresh#") ? "refresh" : null;
      if (!kind || typeof r.clientId !== "string") continue;
      const app = apps.get(r.clientId) ?? { access: 0, refresh: 0, until: 0 };
      app[kind]++;
      app.until = Math.max(app.until, Number(r.expiresAt) * 1000);
      apps.set(r.clientId, app);
    }
    if (!apps.size) console.log("No AI apps are connected.");
    for (const [clientId, a] of apps) {
      const name = (await auth.get<{ name?: string }>(`client#${clientId}`))?.name ?? "(unknown app)";
      console.log(`${name}  ${clientId}  ${a.refresh} refresh, ${a.access} access tokens; can reconnect until ${new Date(a.until).toISOString().slice(0, 10)}`);
    }
    break;
  }
  case "ai-revoke": {
    const removed = await dynamoAuthStore().deleteUser(await resolve(who));
    console.log(`Removed ${removed} record${removed === 1 ? "" : "s"}. Connected AI apps are signed out.`);
    break;
  }
  case "encrypt": {
    if (!who) fail("Say whose: encrypt <email|id|all>");
    if (!process.env.TRANSCRIPTS_BUCKET) fail("Set TRANSCRIPTS_BUCKET to the stack's TranscriptsBucket output (see the top of broker/src/cloud/admin.ts).");
    const ids = who === "all" ? await everyone() : [await resolve(who)];
    for (const id of ids) {
      const d = await encryptUserData(id);
      console.log(
        `${id}  ${d.chats} chats, ${d.tasks} tasks, ${d.memories} memories, ${d.workflows} workflows` +
          (d.busy ? `, ${d.busy} chats busy (run it again later)` : ""),
      );
    }
    console.log(`Encrypted ${ids.length} account${ids.length === 1 ? "" : "s"}.`);
    break;
  }
  default:
    fail("Commands: show, grant, plan, report, ai, ai-revoke, welcome, welcome-html, whats-new, whats-new-html, encrypt. See the top of broker/src/cloud/admin.ts.");
}
