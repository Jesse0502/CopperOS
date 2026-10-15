// Where the MCP endpoint keeps what it must remember between requests, in one
// DynamoDB table (McpAuth) whose items expire on their own:
//
//   client#<id>         an app that registered itself (RFC 7591)
//   authreq#<id>        a sign-in under way: who asked, and the PKCE challenge
//   code#<hash>         an authorization code, spent by one token request
//   access#<hash>       an access token (the hash of it; the token itself is never kept)
//   refresh#<hash>      a refresh token
//   rate#…              request counts, for the limits in mcp-backend.ts
//   lock#…              a short hold, so two requests cannot start a task at once
//
// DynamoDB removes an expired item up to a couple of days late, so every read
// here checks the expiry itself.

import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

export type Rec = Record<string, unknown>;

export interface AuthStore {
  /** Writes an item that lasts `ttlSeconds`. */
  put(id: string, data: Rec, ttlSeconds: number): Promise<void>;
  /** The item, or null if there is none or it has expired. */
  get<T extends Rec>(id: string): Promise<(T & { expiresAt: number }) | null>;
  /** Removes the item and returns it: of any number of requests at once, one gets it. */
  take<T extends Rec>(id: string): Promise<(T & { expiresAt: number }) | null>;
  /** Adds one to a counter that lasts `ttlSeconds` from its first count, and returns the new count. */
  increment(id: string, ttlSeconds: number): Promise<number>;
  count(id: string): Promise<number>;
  /** Takes the hold if nobody has it (or theirs ran out): of any number of requests at once, one gets true. */
  lock(id: string, ttlSeconds: number): Promise<boolean>;
  release(id: string): Promise<void>;
  /** Everything kept that names this user: their tokens and sign-ins under way. */
  recordsOf(userId: string): Promise<Array<{ id: string } & Rec>>;
  deleteUser(userId: string): Promise<number>;
}

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

export function dynamoAuthStore(): AuthStore {
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const table = () => env("MCP_AUTH_TABLE");

  const live = <T extends Rec>(item: Rec | undefined) => {
    if (!item || (item.expiresAt as number) <= nowSeconds()) return null;
    return item as T & { expiresAt: number };
  };

  return {
    async put(id, data, ttlSeconds) {
      await db.send(new PutCommand({ TableName: table(), Item: { ...data, id, expiresAt: nowSeconds() + ttlSeconds } }));
    },

    async get<T extends Rec>(id: string) {
      const res = await db.send(new GetCommand({ TableName: table(), Key: { id }, ConsistentRead: true }));
      return live<T>(res.Item);
    },

    async take<T extends Rec>(id: string) {
      try {
        const res = await db.send(
          new DeleteCommand({ TableName: table(), Key: { id }, ConditionExpression: "attribute_exists(id)", ReturnValues: "ALL_OLD" }),
        );
        return live<T>(res.Attributes);
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return null;
        throw err;
      }
    },

    async increment(id, ttlSeconds) {
      const res = await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: { id },
          UpdateExpression: "ADD #n :one SET #ttl = if_not_exists(#ttl, :ttl)",
          ExpressionAttributeNames: { "#n": "n", "#ttl": "expiresAt" },
          ExpressionAttributeValues: { ":one": 1, ":ttl": nowSeconds() + ttlSeconds },
          ReturnValues: "ALL_NEW",
        }),
      );
      // A counter whose window ended but which DynamoDB has not removed yet starts again.
      if ((res.Attributes?.expiresAt as number) <= nowSeconds()) {
        await db.send(new DeleteCommand({ TableName: table(), Key: { id } }));
        return this.increment(id, ttlSeconds);
      }
      return res.Attributes?.n as number;
    },

    async count(id) {
      const res = await db.send(new GetCommand({ TableName: table(), Key: { id }, ConsistentRead: true }));
      return (live<{ n?: number }>(res.Item)?.n as number | undefined) ?? 0;
    },

    async lock(id, ttlSeconds) {
      try {
        await db.send(
          new PutCommand({
            TableName: table(),
            Item: { id, expiresAt: nowSeconds() + ttlSeconds },
            ConditionExpression: "attribute_not_exists(id) OR expiresAt <= :now",
            ExpressionAttributeValues: { ":now": nowSeconds() },
          }),
        );
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
    },

    async release(id) {
      await db.send(new DeleteCommand({ TableName: table(), Key: { id } }));
    },

    async recordsOf(userId) {
      const out: Array<{ id: string } & Rec> = [];
      let start: Record<string, unknown> | undefined;
      do {
        const res = await db.send(
          new QueryCommand({
            TableName: table(),
            IndexName: "byUser",
            KeyConditionExpression: "userId = :u",
            ExpressionAttributeValues: { ":u": userId },
            ExclusiveStartKey: start,
          }),
        );
        for (const item of res.Items ?? []) {
          if ((item.expiresAt as number) > nowSeconds()) out.push(item as { id: string } & Rec);
        }
        start = res.LastEvaluatedKey;
      } while (start);
      return out;
    },

    async deleteUser(userId) {
      let removed = 0;
      let start: Record<string, unknown> | undefined;
      do {
        const res = await db.send(
          new QueryCommand({
            TableName: table(),
            IndexName: "byUser",
            KeyConditionExpression: "userId = :u",
            ExpressionAttributeValues: { ":u": userId },
            ProjectionExpression: "id",
            ExclusiveStartKey: start,
          }),
        );
        for (const item of res.Items ?? []) {
          await db.send(new DeleteCommand({ TableName: table(), Key: { id: item.id } }));
          removed++;
        }
        start = res.LastEvaluatedKey;
      } while (start);
      return removed;
    },
  };
}
