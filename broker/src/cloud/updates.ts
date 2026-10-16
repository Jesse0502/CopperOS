// Emailing the people with an account about what is new in CopperOS (updates-email.ts): who it may go
// to, the link they use to stop it, and the sending, which is careful because it reaches everyone at once.
//
//   - Someone who unsubscribed (`emailOptOut` on their account item) is never sent one.
//   - An announcement goes to a person once: their account item keeps the ids it has been sent
//     (`newsEmailed`), marked before the email goes, so running it twice, or two runs at the same
//     time, send it once. A send that fails gives the mark back, so it can be tried again.
//   - Every email carries a signed one-click unsubscribe link (and the List-Unsubscribe headers mail
//     apps show as their own Unsubscribe button). The link is an HMAC of the person's id under the same
//     secret the stored data is sealed with, so a link cannot be made for anyone else.
//   - A dry run counts and sends nothing; the admin tool makes it the default.

import { createHmac, timingSafeEqual } from "node:crypto";
import { CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { masterKey } from "../store/sealing.js";
import { sendMail, type Mail } from "./mail.js";
import { whatsNewEmail, type WhatsNew } from "./updates-email.js";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

const accounts = (): string => {
  const name = process.env.ACCOUNTS_TABLE;
  if (!name) throw new Error("ACCOUNTS_TABLE is not set");
  return name;
};

// ── the unsubscribe link ─────────────────────────────────────────────────────

async function tokenFor(userId: string): Promise<Buffer> {
  return createHmac("sha256", await masterKey()).update(`unsubscribe\n${userId}`).digest();
}

/** Whether `token` is the one that was made for `userId`. */
export async function validUnsubscribe(userId: string, token: string): Promise<boolean> {
  if (!userId || !token) return false;
  const want = await tokenFor(userId);
  const got = Buffer.from(token, "base64url");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** This person's link: `base` is the unsubscribe function's address. */
export async function unsubscribeLink(base: string, userId: string): Promise<string> {
  return `${base.replace(/\/?$/, "/")}?u=${encodeURIComponent(userId)}&t=${(await tokenFor(userId)).toString("base64url")}`;
}

export async function optOut(userId: string): Promise<void> {
  await db.send(
    new UpdateCommand({
      TableName: accounts(),
      Key: { userId },
      UpdateExpression: "SET #o = :yes",
      ExpressionAttributeNames: { "#o": "emailOptOut" },
      ExpressionAttributeValues: { ":yes": true },
    }),
  );
}

async function stateOf(userId: string): Promise<{ optedOut: boolean; emailed: Set<string> }> {
  const res = await db.send(
    new GetCommand({
      TableName: accounts(),
      Key: { userId },
      ProjectionExpression: "#o, #n",
      ExpressionAttributeNames: { "#o": "emailOptOut", "#n": "newsEmailed" },
      ConsistentRead: true,
    }),
  );
  return { optedOut: res.Item?.emailOptOut === true, emailed: new Set<string>(res.Item?.newsEmailed ?? []) };
}

/** Marks `id` as sent to this person. False if it already was. */
async function claim(userId: string, id: string): Promise<boolean> {
  try {
    await db.send(
      new UpdateCommand({
        TableName: accounts(),
        Key: { userId },
        UpdateExpression: "ADD #n :id",
        ConditionExpression: "attribute_not_exists(#n) OR NOT contains(#n, :one)",
        ExpressionAttributeNames: { "#n": "newsEmailed" },
        ExpressionAttributeValues: { ":id": new Set([id]), ":one": id },
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

async function release(userId: string, id: string): Promise<void> {
  await db
    .send(
      new UpdateCommand({
        TableName: accounts(),
        Key: { userId },
        UpdateExpression: "DELETE #n :id",
        ExpressionAttributeNames: { "#n": "newsEmailed" },
        ExpressionAttributeValues: { ":id": new Set([id]) },
      }),
    )
    .catch(() => {});
}

// ── who ──────────────────────────────────────────────────────────────────────

export type Recipient = { userId: string; email: string };

/**
 * Everyone in the sign-in pool who can be emailed: enabled, with an address, and either confirmed with a
 * verified address or signed in with Google. Google vouches for the address of someone who signs in with
 * it, but Cognito does not copy that across: every such account reads email_verified = false (all twelve
 * in prod did on 2026-10-16), so for them the flag says nothing and is not asked.
 */
export async function listRecipients(
  poolId: string,
  cognito: Pick<CognitoIdentityProviderClient, "send"> = new CognitoIdentityProviderClient({}),
): Promise<{ recipients: Recipient[]; unusable: number }> {
  const recipients = new Map<string, Recipient>();
  let unusable = 0;
  let token: string | undefined;
  do {
    const page = await cognito.send(new ListUsersCommand({ UserPoolId: poolId, Limit: 60, PaginationToken: token }));
    for (const u of page.Users ?? []) {
      const attr = (name: string) => u.Attributes?.find((a) => a.Name === name)?.Value;
      const sub = attr("sub");
      const email = attr("email");
      const federated = u.UserStatus === "EXTERNAL_PROVIDER";
      const ok = u.Enabled !== false && (federated || (u.UserStatus === "CONFIRMED" && attr("email_verified") === "true"));
      if (!sub || !email || !ok) {
        unusable++;
        continue;
      }
      recipients.set(sub, { userId: sub, email });
    }
    token = page.PaginationToken;
  } while (token);
  return { recipients: [...recipients.values()], unusable };
}

// ── sending ──────────────────────────────────────────────────────────────────

export type Outcome = {
  recipients: number;
  /** A dry run: how many would be sent. */
  wouldSend: number;
  sent: number;
  alreadySent: number;
  optedOut: number;
  failed: number;
  errors: string[];
};

/**
 * Sends `entry` to each recipient who has not unsubscribed and has not had it. `unsubscribeBase` is the
 * unsubscribe function's address. With `dryRun` nothing is marked or sent.
 */
export async function sendWhatsNew(opts: {
  entry: WhatsNew;
  recipients: Recipient[];
  unsubscribeBase: string;
  dryRun: boolean;
  /** A pause between emails, for SES's sending rate. */
  delayMs?: number;
  send?: (mail: Mail) => Promise<void>;
}): Promise<Outcome> {
  const send = opts.send ?? sendMail;
  const out: Outcome = { recipients: opts.recipients.length, wouldSend: 0, sent: 0, alreadySent: 0, optedOut: 0, failed: 0, errors: [] };
  for (const r of opts.recipients) {
    const state = await stateOf(r.userId);
    if (state.optedOut) {
      out.optedOut++;
      continue;
    }
    if (state.emailed.has(opts.entry.id)) {
      out.alreadySent++;
      continue;
    }
    if (opts.dryRun) {
      out.wouldSend++;
      continue;
    }
    if (!(await claim(r.userId, opts.entry.id))) {
      out.alreadySent++;
      continue;
    }
    try {
      const link = await unsubscribeLink(opts.unsubscribeBase, r.userId);
      const mail = whatsNewEmail({ entry: opts.entry, unsubscribeUrl: link });
      await send({
        to: r.email,
        ...mail,
        // What mail apps use for their own Unsubscribe button; the POST form is the one-click kind.
        headers: { "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      });
      out.sent++;
    } catch (err) {
      await release(r.userId, opts.entry.id);
      out.failed++;
      if (out.errors.length < 5) out.errors.push(String((err as Error)?.message ?? err));
    }
    if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
  }
  return out;
}
