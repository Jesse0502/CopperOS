// "Send a suggestion" from the extension's Settings: one message, emailed to
// the CopperOS inbox. It is a public URL, since people running CopperOS on
// their own computer have no sign-in; someone signed in to the hosted one
// sends their token, and their email becomes the reply-to. Each address can
// send a few an hour, and all of them together a few hundred a day.

import { CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";

const TEXT_CAP = 4000;
const PER_ADDRESS_PER_HOUR = 5;
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

/** The signed-in person's email, from a valid access token; null for anyone else. */
async function senderEmail(authorization: string | undefined): Promise<string | null> {
  const token = authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return null;
  try {
    const { sub } = await verifier.verify(token);
    const found = await cognito.send(
      new ListUsersCommand({ UserPoolId: process.env.USER_POOL_ID, Filter: `sub = "${sub.replace(/"/g, "")}"`, Limit: 1 }),
    );
    return found.Users?.[0]?.Attributes?.find((a) => a.Name === "email")?.Value ?? null;
  } catch {
    return null;
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (event.requestContext.http.method !== "POST") return reply(405, { error: "POST only" });
  let body: { text?: unknown; version?: unknown; backend?: unknown };
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString() : event.body ?? "";
    body = JSON.parse(raw);
  } catch {
    return reply(400, { error: "Not JSON." });
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!/[\p{L}\p{N}]/u.test(text)) return reply(400, { error: "Write a suggestion first." });
  if (text.length > TEXT_CAP) return reply(400, { error: `Keep it under ${TEXT_CAP} characters.` });

  const ip = event.requestContext.http.sourceIp;
  const hour = Math.floor(Date.now() / 3_600_000);
  const day = Math.floor(Date.now() / 86_400_000);
  if (
    !(await within(`feedback#${ip}#${hour}`, PER_ADDRESS_PER_HOUR, 3600)) ||
    !(await within(`feedback#all#${day}`, ALL_PER_DAY, 86_400))
  ) {
    return reply(429, { error: "That's a lot of suggestions at once — try again in a while." });
  }

  const email = await senderEmail(event.headers.authorization);
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
          Subject: { Data: `Suggestion: ${firstLine}${text.length > firstLine.length ? "…" : ""}` },
          Body: {
            Text: {
              Data:
                `${text}\n\n— \n` +
                `From: ${email ?? "someone not signed in"}\n` +
                `CopperOS ${version}, running on ${backend}\n` +
                `Sent ${new Date().toISOString()}`,
            },
          },
        },
      },
    }),
  );
  console.log(`[feedback] sent ${text.length} chars from ${email ? "a signed-in user" : "someone not signed in"}`);
  return reply(200, { ok: true });
}
