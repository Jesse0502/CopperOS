// Look at, and change, what a hosted user has: their plan, their credits, and
// what they have spent. Payments (Stripe) set a plan and add credits by
// themselves; this is for a gift, a correction, or a plan given by hand, and
// calls the same functions (billing.ts and ledger.ts).
//
//   AWS_PROFILE=jassydev npm run admin -- show   <email|id>
//   AWS_PROFILE=jassydev npm run admin -- grant  <email|id> <credits>      credits, as people see them (100 a dollar); negative takes some back
//   AWS_PROFILE=jassydev npm run admin -- plan   <email|id> <ore|ingot|facet|foundry> [days]
//   AWS_PROFILE=jassydev npm run admin -- report [week]                    everyone's spend, biggest first, and the free pool
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
process.env.USER_KEYS_PARAM ??= `/copperos/${stage}/user-keys-secret`;
process.env.AWS_REGION ??= "us-east-1";

// Loaded after the environment above is set: the ledger reads it as it runs.
const { dynamoLedger, loadLimits, loadRuntime } = await import("./ledger.js");
const { encryptUserData } = await import("../store/cloud.js");

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito = new CognitoIdentityProviderClient({});

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const money = (usd: number) => `$${usd.toFixed(usd < 1 ? 4 : 2)}`;

/** The user id (Cognito `sub`) behind an email, or the id itself. */
async function resolve(who: string | undefined): Promise<string> {
  if (!who) return fail("Say whose: an email or a user id.");
  if (!who.includes("@")) return who;
  let poolId: string | undefined;
  let token: string | undefined;
  do {
    const page = await cognito.send(new ListUserPoolsCommand({ MaxResults: 60, NextToken: token }));
    poolId = page.UserPools?.find((p) => p.Name === `copperos-${stage}-users`)?.Id;
    token = poolId ? undefined : page.NextToken;
  } while (token);
  if (!poolId) return fail(`No sign-in pool named copperos-${stage}-users. Is STAGE right?`);
  const found = await cognito.send(
    new ListUsersCommand({ UserPoolId: poolId, Filter: `email = "${who.replace(/"/g, "")}"`, Limit: 10 }),
  );
  const ids = (found.Users ?? []).map((u) => u.Attributes?.find((a) => a.Name === "sub")?.Value).filter(Boolean) as string[];
  if (ids.length === 0) return fail(`Nobody has signed in as ${who}.`);
  if (ids.length > 1) return fail(`${who} has ${ids.length} sign-ins; pass one of these ids instead:\n  ${ids.join("\n  ")}`);
  return ids[0];
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
    fail("Commands: show, grant, plan, report, encrypt. See the top of broker/src/cloud/admin.ts.");
}
