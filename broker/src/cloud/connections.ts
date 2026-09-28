// Who is connected to the socket, and reaching them. Three kinds of record
// share the connections table:
//   extension  a user's browser; any number per user
//   worker     a running task's agent Lambda, for its chat
//   grant      a one-time pass a worker connects with (see createGrant)
// Records expire on their own (TTL) in case a disconnect is never seen.

import { randomUUID } from "node:crypto";
import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const socket = new ApiGatewayManagementApiClient({ endpoint: process.env.SOCKET_CALLBACK_URL });
const TABLE = () => {
  const name = process.env.CONNECTIONS_TABLE;
  if (!name) throw new Error("CONNECTIONS_TABLE is not set");
  return name;
};

export type Kind = "extension" | "worker";

export type Connection = {
  connectionId: string;
  userId: string;
  kind: Kind;
  /** A worker's chat. */
  chatId?: string;
  connectedAt: number;
  expiresAt: number;
};

// API Gateway closes a WebSocket after 2 hours regardless, so a record older
// than that is one whose disconnect was missed.
const CONNECTION_TTL_S = 3 * 60 * 60;
// A worker connects within seconds of being started; a pass lasts minutes.
const GRANT_TTL_S = 5 * 60;

const nowS = () => Math.floor(Date.now() / 1000);

export async function recordConnection(
  connectionId: string,
  userId: string,
  kind: Kind,
  chatId?: string,
): Promise<void> {
  const now = nowS();
  await db.send(
    new PutCommand({
      TableName: TABLE(),
      Item: { connectionId, userId, kind, chatId, connectedAt: now, expiresAt: now + CONNECTION_TTL_S },
    }),
  );
}

export async function forgetConnection(connectionId: string): Promise<void> {
  await db.send(new DeleteCommand({ TableName: TABLE(), Key: { connectionId } }));
}

export async function getConnection(connectionId: string): Promise<Connection | null> {
  const res = await db.send(new GetCommand({ TableName: TABLE(), Key: { connectionId } }));
  const item = res.Item as (Connection & { kind: string }) | undefined;
  return item && (item.kind === "extension" || item.kind === "worker") ? item : null;
}

async function connectionsOf(userId: string): Promise<Connection[]> {
  const res = await db.send(
    new QueryCommand({
      TableName: TABLE(),
      IndexName: "byUser",
      KeyConditionExpression: "userId = :u",
      ExpressionAttributeValues: { ":u": userId },
    }),
  );
  const now = nowS();
  return ((res.Items ?? []) as Connection[]).filter((c) => c.expiresAt > now);
}

/** A user's browsers, the most recently connected first. */
export async function extensionsOf(userId: string): Promise<Connection[]> {
  return (await connectionsOf(userId))
    .filter((c) => c.kind === "extension")
    .sort((a, b) => b.connectedAt - a.connectedAt);
}

/** A user's running tasks' agents — for one chat, when given. */
export async function workersOf(userId: string, chatId?: string): Promise<Connection[]> {
  return (await connectionsOf(userId)).filter(
    (c) => c.kind === "worker" && (chatId === undefined || c.chatId === chatId),
  );
}

/** Send one message to one connection. False if it has gone, and its record with it. */
export async function post(connectionId: string, message: unknown): Promise<boolean> {
  try {
    await socket.send(
      new PostToConnectionCommand({ ConnectionId: connectionId, Data: JSON.stringify(message) }),
    );
    return true;
  } catch (err) {
    if (!(err instanceof GoneException)) throw err;
    await forgetConnection(connectionId).catch(() => {});
    return false;
  }
}

/** Send to every one of a user's browsers — what agent events and chat updates go to. */
export async function postToExtensions(userId: string, message: unknown): Promise<void> {
  await Promise.all((await extensionsOf(userId)).map((c) => post(c.connectionId, message)));
}

/**
 * A one-time pass for the agent Lambda a task is starting, so it can join
 * the socket as that task's worker. It never leaves the backend.
 */
export async function createGrant(userId: string, chatId: string): Promise<string> {
  const token = randomUUID();
  await db.send(
    new PutCommand({
      TableName: TABLE(),
      Item: { connectionId: `grant#${token}`, userId, chatId, kind: "grant", expiresAt: nowS() + GRANT_TTL_S },
    }),
  );
  return token;
}

/** Spend a pass: whose task it is for, or null if it is unknown, used or stale. */
export async function useGrant(token: string): Promise<{ userId: string; chatId: string } | null> {
  const res = await db
    .send(
      new DeleteCommand({
        TableName: TABLE(),
        Key: { connectionId: `grant#${token}` },
        ConditionExpression: "attribute_exists(connectionId)",
        ReturnValues: "ALL_OLD",
      }),
    )
    .catch(() => null);
  const grant = res?.Attributes as { userId: string; chatId: string; kind: string; expiresAt: number } | undefined;
  if (!grant || grant.kind !== "grant" || grant.expiresAt <= nowS()) return null;
  return { userId: grant.userId, chatId: grant.chatId };
}
