// What a person controls about the AI apps connected to their account (Settings → MCP):
// the apps themselves, which they can cut off, and one switch. Off, an app can read, start and
// stop tasks, and raise approvals. On, it can also lower approvals, turn the supervisor off and
// add memories and molds (mcp-backend.ts), which CopperOS reads as the person's own words.
// The switch lives on the account; the apps are the tokens in the McpAuth table.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { REFRESH_TTL_S } from "./mcp-oauth.js";
import type { AuthStore } from "./mcp-store.js";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

const accounts = (): string => {
  const name = process.env.ACCOUNTS_TABLE;
  if (!name) throw new Error("ACCOUNTS_TABLE is not set");
  return name;
};

/** Whether this person lets connected AI apps lower approvals, switch the supervisor off and add memories and molds. */
export async function aiLoosening(userId: string): Promise<boolean> {
  const res = await db.send(
    new GetCommand({
      TableName: accounts(),
      Key: { userId },
      ProjectionExpression: "#a",
      ExpressionAttributeNames: { "#a": "aiLoosening" },
      ConsistentRead: true,
    }),
  );
  return res.Item?.aiLoosening === true;
}

export async function setAiLoosening(userId: string, on: boolean): Promise<void> {
  await db.send(
    new UpdateCommand({
      TableName: accounts(),
      Key: { userId },
      UpdateExpression: "SET #a = :on",
      ExpressionAttributeNames: { "#a": "aiLoosening" },
      ExpressionAttributeValues: { ":on": on },
    }),
  );
}

/** One connected app, for the Settings list. */
export type AiApp = {
  id: string;
  name: string;
  /** When it last signed in or renewed its sign-in, epoch ms: an app in use renews every hour. */
  lastActive: number;
};

/** The apps holding a sign-in for this account, most recently active first. */
export async function aiApps(userId: string, auth: AuthStore): Promise<AiApp[]> {
  const last = new Map<string, number>();
  for (const r of await auth.recordsOf(userId)) {
    if (!String(r.id).startsWith("refresh#") || typeof r.clientId !== "string") continue;
    const at = Number(r.expiresAt) * 1000 - REFRESH_TTL_S * 1000;
    last.set(r.clientId, Math.max(last.get(r.clientId) ?? 0, at));
  }
  const apps: AiApp[] = [];
  for (const [id, lastActive] of last) {
    const client = await auth.get<{ name?: string }>(`client#${id}`);
    apps.push({ id, name: client?.name ?? "An AI app", lastActive });
  }
  return apps.sort((a, b) => b.lastActive - a.lastActive);
}

/** Cuts one app off: every token it holds for this account. It has to be signed in again. */
export async function revokeAiApp(userId: string, clientId: string, auth: AuthStore): Promise<number> {
  let removed = 0;
  for (const r of await auth.recordsOf(userId)) {
    if (r.clientId !== clientId || !/^(access|refresh)#/.test(String(r.id))) continue;
    if (await auth.take(String(r.id))) removed++;
  }
  return removed;
}
