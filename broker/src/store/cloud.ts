// The hosted version's store: DynamoDB for everything small, S3 for chat
// transcripts, and a sealing key in Parameter Store for the LLM API keys users
// bring (see seal). Every item is keyed
// by the user's id, so one user's data is never within reach of another's.
//
//   Accounts   userId            → currentChatId, config (keys encrypted)
//   Chats      userId, chatId    → summary, pending request, run
//   Memories   userId, key       → one fact; key is "<topic>/<slug>"
//   Tasks      userId, chatId    → a tracked task's state
//   S3         chats/<userId>/<chatId>.json → the transcript
//
// A chat's `run` says a task is under way: set by the relay when it starts
// or resumes one, cleared by the agent when it ends. It is how two requests
// for the same chat can never both start it (see claimRun).

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { PendingRequest } from "../bridge.js";
import type { LLMConfig } from "../config.js";
import type { TaskState } from "../progress.js";
import type { Session } from "../session.js";
import { summarize, type ChatSummary, type MemoryRecord, type Store } from "./store.js";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});
const ssm = new SSMClient({});

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const T = {
  accounts: () => env("ACCOUNTS_TABLE"),
  chats: () => env("CHATS_TABLE"),
  memories: () => env("MEMORIES_TABLE"),
  tasks: () => env("TASKS_TABLE"),
  bucket: () => env("TRANSCRIPTS_BUCKET"),
  userKeys: () => env("USER_KEYS_PARAM"),
};

// Users' API keys are sealed with AES-256-GCM under a 32-byte key kept as a
// SecureString in Parameter Store, which is free; a KMS key was $1 a month
// per stage. The user's id and the provider are bound in as associated data,
// as KMS's encryption context bound them, so a sealed key copied to another
// user or provider will not open. Create the key once per stage:
//   aws ssm put-parameter --name /copperos/<stage>/user-keys-secret --type SecureString --value "$(openssl rand -base64 32)"
const SEALED = "gcm:";
let sealingKey: Promise<Buffer> | null = null;

function userKeysKey(): Promise<Buffer> {
  if (!sealingKey) {
    sealingKey = ssm
      .send(new GetParameterCommand({ Name: T.userKeys(), WithDecryption: true }))
      .then((res) => {
        const key = Buffer.from(res.Parameter?.Value ?? "", "base64");
        if (key.length !== 32) throw new Error(`${T.userKeys()} must hold 32 random bytes, base64`);
        return key;
      });
    // A failed fetch is tried again on the next call, not remembered.
    sealingKey.catch(() => (sealingKey = null));
  }
  return sealingKey;
}

function boundTo(userId: string, provider: string): Buffer {
  return Buffer.from(`${userId}\n${provider}`, "utf8");
}

export async function seal(plain: string, userId: string, provider: string): Promise<string> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await userKeysKey(), iv);
  cipher.setAAD(boundTo(userId, provider));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return SEALED + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

/** The key `sealed` holds, or null if it was sealed by the KMS key this replaced and cannot be opened. */
export async function open(sealed: string, userId: string, provider: string): Promise<string | null> {
  if (!sealed.startsWith(SEALED)) return null;
  const raw = Buffer.from(sealed.slice(SEALED.length), "base64");
  const decipher = createDecipheriv("aes-256-gcm", await userKeysKey(), raw.subarray(0, 12));
  decipher.setAAD(boundTo(userId, provider));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

/**
 * A task under way in a chat. `until` is when a run nobody ended counts as
 * dead; `usedMs` is the task's active time before this run started (its
 * earlier runs, split by pauses), against its time limit.
 */
export type Run = { task: string | null; startedAt: number; until: number; usedMs: number };

/** A chat's item as the Chats table keeps it. */
export type ChatItem = Partial<ChatSummary> & { chatId: string; pending?: PendingRequest; run?: Run };

/** Whether a chat is taken: running, or paused waiting on the person. */
export function busy(chat: ChatItem | null | undefined, now = Date.now()): boolean {
  return Boolean(chat?.pending || (chat?.run && chat.run.until > now));
}

// A run that never ends — its Lambda died — stops blocking the chat after
// this. Longer than the Lambda's 15-minute limit.
const RUN_LEASE_MS = 16 * 60_000;

const PROVIDERS_WITH_KEYS = ["openai", "openrouter"] as const;

export class CloudStore implements Store {
  private transcriptKey(userId: string, chatId: string): string {
    return `chats/${userId}/${chatId}.json`;
  }

  async loadChat(userId: string, chatId: string): Promise<unknown | null> {
    try {
      const res = await s3.send(
        new GetObjectCommand({ Bucket: T.bucket(), Key: this.transcriptKey(userId, chatId) }),
      );
      return JSON.parse(await res.Body!.transformToString());
    } catch (err) {
      if (err instanceof NoSuchKey) return null;
      throw err;
    }
  }

  async saveChat(userId: string, chat: Session): Promise<void> {
    await s3.send(
      new PutObjectCommand({
        Bucket: T.bucket(),
        Key: this.transcriptKey(userId, chat.id),
        Body: JSON.stringify(chat),
        ContentType: "application/json",
      }),
    );
    // The summary and any pending request, leaving `run` to whoever owns it.
    const { title, taskCount, createdAt, updatedAt, pending } = summarize(chat);
    await db.send(
      new UpdateCommand({
        TableName: T.chats(),
        Key: { userId, chatId: chat.id },
        UpdateExpression:
          "SET #title = :title, #count = :count, #created = :created, #updated = :updated" +
          (pending ? ", #pending = :pending" : " REMOVE #pending"),
        ExpressionAttributeNames: {
          "#title": "title",
          "#count": "taskCount",
          "#created": "createdAt",
          "#updated": "updatedAt",
          "#pending": "pending",
        },
        ExpressionAttributeValues: {
          ":title": title,
          ":count": taskCount,
          ":created": createdAt,
          ":updated": updatedAt,
          ...(pending ? { ":pending": pending } : {}),
        },
      }),
    );
  }

  async listChats(userId: string): Promise<ChatSummary[]> {
    return (await this.chatItems(userId))
      .filter((c) => c.createdAt)
      .map((c) => ({
        id: c.chatId,
        createdAt: c.createdAt!,
        updatedAt: c.updatedAt ?? c.createdAt!,
        title: c.title ?? "(empty chat)",
        taskCount: c.taskCount ?? 0,
        ...(c.pending ? { pending: c.pending } : {}),
      }));
  }

  /** Every chat's item, with its run — what the relay needs to tell which are busy. */
  async chatItems(userId: string): Promise<ChatItem[]> {
    const items: ChatItem[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const res = await db.send(
        new QueryCommand({
          TableName: T.chats(),
          KeyConditionExpression: "userId = :u",
          ExpressionAttributeValues: { ":u": userId },
          ExclusiveStartKey: start,
        }),
      );
      items.push(...((res.Items ?? []) as ChatItem[]));
      start = res.LastEvaluatedKey;
    } while (start);
    return items;
  }

  async chatItem(userId: string, chatId: string): Promise<ChatItem | null> {
    const res = await db.send(new GetCommand({ TableName: T.chats(), Key: { userId, chatId } }));
    return (res.Item as ChatItem | undefined) ?? null;
  }

  /**
   * Mark a chat as running a task, unless it already is — atomically, so two
   * requests at once cannot both start it. `resuming` names the request a
   * paused task is waiting on: only that one can take it, and it is cleared.
   * Returns false if the chat was not free to take.
   */
  async claimRun(
    userId: string,
    chatId: string,
    task: string | null,
    resuming?: string,
    usedMs = 0,
  ): Promise<boolean> {
    const now = Date.now();
    try {
      await db.send(
        new UpdateCommand({
          TableName: T.chats(),
          Key: { userId, chatId },
          UpdateExpression: resuming ? "SET #run = :run REMOVE #pending" : "SET #run = :run",
          ConditionExpression: resuming
            ? "#pending.#id = :rid"
            : "attribute_not_exists(#pending) AND (attribute_not_exists(#run) OR #run.#until < :now)",
          ExpressionAttributeNames: {
            "#run": "run",
            "#pending": "pending",
            ...(resuming ? { "#id": "id" } : { "#until": "until" }),
          },
          ExpressionAttributeValues: {
            ":run": { task, startedAt: now, until: now + RUN_LEASE_MS, usedMs } satisfies Run,
            ...(resuming ? { ":rid": resuming } : { ":now": now }),
          },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  /**
   * Take a paused task's request away — for a cancel — so nothing can resume
   * it. False if the chat was not waiting on anything.
   */
  async claimPending(userId: string, chatId: string): Promise<boolean> {
    try {
      await db.send(
        new UpdateCommand({
          TableName: T.chats(),
          Key: { userId, chatId },
          UpdateExpression: "REMOVE #pending, #run",
          ConditionExpression: "attribute_exists(#pending)",
          ExpressionAttributeNames: { "#pending": "pending", "#run": "run" },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  /**
   * The agent is done with the chat. A task that paused keeps its run's text
   * (the panel shows it as the task waiting on you) but no longer holds the
   * chat through the run: its pending request does.
   */
  async endRun(userId: string, chatId: string, paused: boolean, usedMs = 0): Promise<void> {
    await db.send(
      new UpdateCommand({
        TableName: T.chats(),
        Key: { userId, chatId },
        UpdateExpression: paused ? "SET #run.#until = :zero, #run.#used = :used" : "REMOVE #run",
        // Never brings back a chat that was deleted meanwhile.
        ConditionExpression: "attribute_exists(#run)",
        ExpressionAttributeNames: { "#run": "run", ...(paused ? { "#until": "until", "#used": "usedMs" } : {}) },
        ...(paused ? { ExpressionAttributeValues: { ":zero": 0, ":used": usedMs } } : {}),
      }),
    ).catch((err) => {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
    });
  }

  async getCurrentChat(userId: string): Promise<string | null> {
    const res = await db.send(
      new GetCommand({
        TableName: T.accounts(),
        Key: { userId },
        ProjectionExpression: "#c",
        ExpressionAttributeNames: { "#c": "currentChatId" },
      }),
    );
    return (res.Item?.currentChatId as string | undefined) ?? null;
  }

  async setCurrentChat(userId: string, chatId: string): Promise<void> {
    await db.send(
      new UpdateCommand({
        TableName: T.accounts(),
        Key: { userId },
        UpdateExpression: "SET #c = :c",
        ExpressionAttributeNames: { "#c": "currentChatId" },
        ExpressionAttributeValues: { ":c": chatId },
      }),
    );
  }

  async listMemories(userId: string): Promise<MemoryRecord[]> {
    const res = await db.send(
      new QueryCommand({
        TableName: T.memories(),
        KeyConditionExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": userId },
      }),
    );
    return (res.Items ?? []).map(toMemory);
  }

  async getMemory(userId: string, topic: string, slug: string): Promise<MemoryRecord | null> {
    const res = await db.send(
      new GetCommand({ TableName: T.memories(), Key: { userId, key: `${topic}/${slug}` } }),
    );
    return res.Item ? toMemory(res.Item) : null;
  }

  async putMemory(userId: string, memory: MemoryRecord): Promise<void> {
    await db.send(
      new PutCommand({
        TableName: T.memories(),
        Item: { userId, key: `${memory.topic}/${memory.slug}`, ...memory },
      }),
    );
  }

  async deleteMemory(userId: string, topic: string, slug: string): Promise<void> {
    await db.send(new DeleteCommand({ TableName: T.memories(), Key: { userId, key: `${topic}/${slug}` } }));
  }

  async loadTask(userId: string, chatId: string): Promise<TaskState | null> {
    const res = await db.send(new GetCommand({ TableName: T.tasks(), Key: { userId, chatId } }));
    return (res.Item?.state as TaskState | undefined) ?? null;
  }

  async saveTask(userId: string, chatId: string, task: TaskState): Promise<void> {
    await db.send(new PutCommand({ TableName: T.tasks(), Item: { userId, chatId, state: task } }));
  }

  /** The user's settings, with their API keys decrypted for this call only. */
  async loadConfig(userId: string): Promise<unknown | null> {
    const res = await db.send(
      new GetCommand({
        TableName: T.accounts(),
        Key: { userId },
        ProjectionExpression: "#config",
        ExpressionAttributeNames: { "#config": "config" },
      }),
    );
    const stored = res.Item?.config as Record<string, any> | undefined;
    if (!stored) return null;
    const config = structuredClone(stored);
    for (const p of PROVIDERS_WITH_KEYS) {
      const cipher = config[p]?.apiKeyCipher;
      if (!cipher) continue;
      delete config[p].apiKeyCipher;
      const key = await open(cipher, userId, p);
      // Saved under the old KMS key: as if never saved, so Settings asks again.
      if (key === null) {
        console.warn(`[store] ${p} key for ${userId} predates the sealing key; it must be entered again`);
        continue;
      }
      config[p].apiKey = key;
    }
    return config;
  }

  /** Saved with each API key encrypted under the user's id — never in plain text. */
  async saveConfig(userId: string, config: LLMConfig): Promise<void> {
    const stored: Record<string, any> = structuredClone(config);
    for (const p of PROVIDERS_WITH_KEYS) {
      const key = stored[p]?.apiKey;
      delete stored[p].apiKey;
      if (!key) continue;
      stored[p].apiKeyCipher = await seal(key, userId, p);
    }
    await db.send(
      new UpdateCommand({
        TableName: T.accounts(),
        Key: { userId },
        UpdateExpression: "SET #config = :c",
        ExpressionAttributeNames: { "#config": "config" },
        ExpressionAttributeValues: { ":c": stored },
      }),
    );
  }
}

/**
 * Everything kept for a user: chats and their transcripts, tracked tasks,
 * memories and settings. For "Delete my account" — there is no undo.
 */
export async function deleteUserData(userId: string): Promise<{ items: number; transcripts: number }> {
  let items = 0;
  for (const [table, sortKey] of [
    [T.chats(), "chatId"],
    [T.tasks(), "chatId"],
    [T.memories(), "key"],
  ] as const) {
    let start: Record<string, unknown> | undefined;
    do {
      const res = await db.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "userId = :u",
          ExpressionAttributeValues: { ":u": userId },
          ProjectionExpression: "userId, #k",
          ExpressionAttributeNames: { "#k": sortKey },
          ExclusiveStartKey: start,
        }),
      );
      for (const item of res.Items ?? []) {
        await db.send(new DeleteCommand({ TableName: table, Key: { userId, [sortKey]: item[sortKey] } }));
        items++;
      }
      start = res.LastEvaluatedKey;
    } while (start);
  }
  await db.send(new DeleteCommand({ TableName: T.accounts(), Key: { userId } }));

  let transcripts = 0;
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: T.bucket(), Prefix: `chats/${userId}/`, ContinuationToken: token }),
    );
    const keys = (res.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (keys.length) {
      await s3.send(new DeleteObjectsCommand({ Bucket: T.bucket(), Delete: { Objects: keys } }));
      transcripts += keys.length;
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return { items, transcripts };
}

function toMemory(item: Record<string, any>): MemoryRecord {
  return {
    topic: item.topic,
    slug: item.slug,
    title: item.title,
    created: item.created,
    updated: item.updated,
    content: item.content,
  };
}
