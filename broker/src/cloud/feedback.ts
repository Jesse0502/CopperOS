// "Send a suggestion" from the extension's Settings: one message, emailed to
// the CopperOS inbox. It is a public URL, since people running CopperOS on
// their own computer have no sign-in; someone signed in to the hosted one
// sends their token, and their email becomes the reply-to. People not signed
// in get tighter limits per address and a shared daily cap, the same text
// twice in a day is only emailed once, and a suggestion needs a few words.

import { createHash } from "node:crypto";
import { CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { isBlocked } from "./blocked.js";

const TEXT_CAP = 4000;
const MIN_WORDS = 2;
const MIN_LETTERS = 8;
const SIGNED_IN_PER_HOUR = 10;
const ANON_PER_ADDRESS_PER_HOUR = 2;
const ANON_PER_ADDRESS_PER_DAY = 5;
const ANON_ALL_PER_DAY = 30;
const ALL_PER_DAY = 300;

const ses = new SESv2Client({});
const cognito = new CognitoIdentityProviderClient({});
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID!,
  clientId: process.env.CLIENT_ID!,
  tokenUse: "access",
});

const reply = (statusCode: number, body: object): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * Counts one more send against `key` in the connections table (its TTL
 * clears old counts); false once past `limit`.
 */
async function within(key: string, limit: number, seconds: number): Promise<boolean> {
  const { Attributes } = await db.send(
    new UpdateCommand({
      TableName: process.env.CONNECTIONS_TABLE,
      Key: { connectionId: key },
      UpdateExpression: "ADD sent :one SET expiresAt = if_not_exists(expiresAt, :ttl)",
      ExpressionAttributeValues: { ":one": 1, ":ttl": Math.floor(Date.now() / 1000) + seconds },
      ReturnValues: "UPDATED_NEW",
    }),
  );
  return Number(Attributes?.sent ?? 0) <= limit;
}

/** The signed-in person, from a valid access token; null for anyone else. */
async function signedIn(authorization: string | undefined): Promise<{ sub: string; email: string } | null> {
  const token = authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return null;
  try {
    const { sub } = await verifier.verify(token);
    const found = await cognito.send(
      new ListUsersCommand({ UserPoolId: process.env.USER_POOL_ID, Filter: `sub = "${sub.replace(/"/g, "")}"`, Limit: 1 }),
    );
    const email = found.Users?.[0]?.Attributes?.find((a) => a.Name === "email")?.Value;
    return email ? { sub, email } : null;
  } catch {
    return null;
  }
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (event.requestContext.http.method !== "POST") return reply(405, { error: "POST only" });
  if (isBlocked(event.requestContext.http.sourceIp)) return reply(403, { error: "Not allowed." });
  let body: { text?: unknown; version?: unknown; backend?: unknown };
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString() : event.body ?? "";
    body = JSON.parse(raw);
  } catch {
    return reply(400, { error: "Not JSON." });
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return reply(400, { error: "Write a suggestion first." });
  const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const letters = text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  if (words < MIN_WORDS || letters < MIN_LETTERS) {
    console.log(`[feedback] refused (too short) · ${text.length} chars`);
    return reply(400, { error: "Say a little more — a few words at least." });
  }
  if (text.length > TEXT_CAP) return reply(400, { error: `Keep it under ${TEXT_CAP} characters.` });

  const person = await signedIn(event.headers.authorization);
  const email = person?.email ?? null;
  const ip = event.requestContext.http.sourceIp;
  // A short tag for the sender, so repeats from one source show in the inbox and logs without the address itself.
  const who = person ? `user#${person.sub}` : `ip#${hash(ip).slice(0, 16)}`;
  const tag = hash(who).slice(0, 8);
  const hour = Math.floor(Date.now() / 3_600_000);
  const day = Math.floor(Date.now() / 86_400_000);
  const allowed = person
    ? (await within(`feedback#${who}#h${hour}`, SIGNED_IN_PER_HOUR, 3600)) &&
      (await within(`feedback#all#${day}`, ALL_PER_DAY, 86_400))
    : (await within(`feedback#${who}#h${hour}`, ANON_PER_ADDRESS_PER_HOUR, 3600)) &&
      (await within(`feedback#${who}#d${day}`, ANON_PER_ADDRESS_PER_DAY, 86_400)) &&
      (await within(`feedback#anon#${day}`, ANON_ALL_PER_DAY, 86_400)) &&
      (await within(`feedback#all#${day}`, ALL_PER_DAY, 86_400));
  if (!allowed) {
    console.log(`[feedback] refused (limit) from ${person ? "a signed-in user" : "someone not signed in"} · sender ${tag}`);
    return reply(429, { error: "That's a lot of suggestions at once — try again in a while." });
  }

  // The same text from the same sender within a day: say it went, email it once.
  const same = hash(text.toLowerCase().replace(/\s+/g, " ")).slice(0, 32);
  if (!(await within(`feedback#${who}#same#${same}`, 1, 86_400))) {
    console.log(`[feedback] repeat not emailed · sender ${tag}`);
    return reply(200, { ok: true });
  }

  const version = typeof body.version === "string" ? body.version.slice(0, 20) : "?";
  const backend = body.backend === "cloud" ? "the cloud" : "their own computer";
  const firstLine = text.split("\n")[0].slice(0, 60);
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: `CopperOS <${process.env.FROM_ADDRESS}>`,
      Destination: { ToAddresses: [process.env.FEEDBACK_TO!] },
      ...(email ? { ReplyToAddresses: [email] } : {}),
      Content: {
        Simple: {
          Subject: { Data: `Suggestion${email ? "" : " (not signed in)"}: ${firstLine}${text.length > firstLine.length ? "…" : ""}` },
          Body: {
            Text: {
              Data:
                `${text}\n\n— \n` +
                `From: ${email ?? "someone not signed in"} · sender ${tag}\n` +
                `CopperOS ${version}, running on ${backend}\n` +
                `Sent ${new Date().toISOString()}`,
            },
          },
        },
      },
    }),
  );
  console.log(`[feedback] sent ${text.length} chars from ${email ? "a signed-in user" : "someone not signed in"} · sender ${tag}`);
  return reply(200, { ok: true });
}
