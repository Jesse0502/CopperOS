// The hosted version's store: DynamoDB for everything small, S3 for chat
// transcripts, and a secret in Parameter Store that everything a person writes
// is encrypted under before it is stored (sealing.ts): transcripts, the titles
// and questions in the chat list, tracked tasks, memories and workflows. The LLM
// API keys users bring are sealed with the same secret (see seal). Every item is
// keyed by the user's id, so one user's data is never within reach of another's.
//
//   Accounts   userId            → currentChatId, config (keys encrypted),
//                                  plan, planUntil, credits (cloud/ledger.ts)
//   Usage      userId, week      → what was spent that week (cloud/ledger.ts)
//   Chats      userId, chatId    → summary, pending request, run
//   Memories   userId, key       → one fact; key is "<topic>/<slug>"
//   Workflows  userId, id        → one saved workflow: name and steps
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
import type { PendingRequest } from "../bridge.js";
import type { LLMConfig } from "../config.js";
import type { TaskState } from "../progress.js";
import type { Session } from "../session.js";
import * as sealing from "./sealing.js";
import { summarize, type ChatSummary, type MemoryRecord, type Store, type WorkflowRecord } from "./store.js";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});

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
  workflows: () => env("WORKFLOWS_TABLE"),
  usage: () => env("USAGE_TABLE"),
  bucket: () => env("TRANSCRIPTS_BUCKET"),
};

// Users' API keys are sealed with AES-256-GCM under the 32-byte secret kept as a
// SecureString in Parameter Store, which is free; a KMS key was $1 a month per
// stage. The user's id and the provider are bound in as associated data, as
// KMS's encryption context bound them, so a sealed key copied to another user or
// provider will not open. The same secret, derived per account, encrypts
// everything else (sealing.ts), which is where it is created from.
const SEALED = "gcm:";

const userKeysKey = sealing.masterKey;

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
export type Run = {
  task: string | null;
  startedAt: number;
  until: number;
  usedMs: number;
  /** The person cancelled while the task was between two Lambdas, so nothing was there to hear it. */
  cancelled?: boolean;
};

/** A chat's item as the Chats table keeps it. */
export type ChatItem = Partial<ChatSummary> & {
  chatId: string;
  pending?: PendingRequest;
  run?: Run;
  /** The title as stored: sealed. `title` is what it opens to, and is only there on an item read back. */
  titleEnc?: string;
};

// A pending request keeps its id, chat and kind in the clear — the table's own
// conditions look at the id — and what it says (the question, the action to
// approve) sealed.
type StoredPending = Pick<PendingRequest, "id" | "chatId" | "kind"> & { sealed: string };

async function sealPending(userId: string, p: PendingRequest): Promise<StoredPending> {
  const { id, chatId, kind, ...said } = p;
  return { id, chatId, kind, sealed: await sealing.sealJson(said, userId, `pending:${chatId}`) };
}

async function openPending(userId: string, p: PendingRequest | StoredPending): Promise<PendingRequest> {
  const stored = p as Partial<StoredPending> & PendingRequest;
  if (!stored.sealed) return p as PendingRequest; // from before sealing
  const said = JSON.parse(await sealing.unseal(stored.sealed, userId, `pending:${stored.chatId}`));
  return { id: stored.id, chatId: stored.chatId, kind: stored.kind, ...said } as PendingRequest;
}

/** A chat's item as it reads back: the title and the pending request opened. */
async function openItem(userId: string, item: ChatItem): Promise<ChatItem> {
  const { titleEnc, ...rest } = item;
  const opened: ChatItem = { ...rest };
  if (titleEnc) opened.title = await sealing.unseal(titleEnc, userId, `title:${item.chatId}`);
  if (item.pending) opened.pending = await openPending(userId, item.pending);
  return opened;
}

/** Whether a chat is taken: running, or paused waiting on the person. */
export function busy(chat: ChatItem | null | undefined, now = Date.now()): boolean {
  return Boolean(chat?.pending || (chat?.run && chat.run.until > now));
}

// A run that never ends — its Lambda died — stops blocking the chat after
// this. Longer than the Lambda's 15-minute limit; a long task renews it each
// time it is handed to a new Lambda.
const RUN_LEASE_MS = 16 * 60_000;

// Every key a user brings is sealed the same way: their model provider's, and their own Jev's.
const PROVIDERS_WITH_KEYS = ["openai", "openrouter", "jev"] as const;

export class CloudStore implements Store {
  private transcriptKey(userId: string, chatId: string): string {
    return `chats/${userId}/${chatId}.json`;
  }

  async loadChat(userId: string, chatId: string): Promise<unknown | null> {
    try {
      const res = await s3.send(
        new GetObjectCommand({ Bucket: T.bucket(), Key: this.transcriptKey(userId, chatId) }),
      );
      const body = await res.Body!.transformToString();
      // A transcript from before sealing is plain JSON.
      return JSON.parse(sealing.isSealed(body) ? await sealing.unseal(body, userId, `transcript:${chatId}`) : body);
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
        Body: await sealing.seal(JSON.stringify(chat), userId, `transcript:${chat.id}`),
        ContentType: "application/octet-stream",
      }),
    );
    // The summary and any pending request, leaving `run` to whoever owns it.
    const { title, taskCount, createdAt, updatedAt, pending } = summarize(chat);
    await db.send(
      new UpdateCommand({
        TableName: T.chats(),
        Key: { userId, chatId: chat.id },
        // The plain `title` of an older item goes as the sealed one comes.
        UpdateExpression:
          "SET #titleEnc = :title, #count = :count, #created = :created, #updated = :updated" +
          (pending ? ", #pending = :pending REMOVE #title" : " REMOVE #title, #pending"),
        ExpressionAttributeNames: {
          "#title": "title",
          "#titleEnc": "titleEnc",
          "#count": "taskCount",
          "#created": "createdAt",
          "#updated": "updatedAt",
          "#pending": "pending",
        },
        ExpressionAttributeValues: {
          ":title": await sealing.seal(title, userId, `title:${chat.id}`),
          ":count": taskCount,
          ":created": createdAt,
          ":updated": updatedAt,
          ...(pending ? { ":pending": await sealPending(userId, pending) } : {}),
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
      for (const item of (res.Items ?? []) as ChatItem[]) items.push(await openItem(userId, item));
      start = res.LastEvaluatedKey;
    } while (start);
    return items;
  }

  async chatItem(userId: string, chatId: string): Promise<ChatItem | null> {
    const res = await db.send(new GetCommand({ TableName: T.chats(), Key: { userId, chatId } }));
    return res.Item ? openItem(userId, res.Item as ChatItem) : null;
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
   * A long task's Lambda is handing it to the next: renew the run so the chat
   * stays taken through the gap, and record the working time so far. False if
   * the run is gone or was cancelled meanwhile — the task is not carried on.
   */
  async extendRun(userId: string, chatId: string, usedMs: number): Promise<boolean> {
    return this.touchRun(userId, chatId, usedMs);
  }

  /** The next Lambda's first act: is the task still wanted? Renews the run as well. */
  async continueRun(userId: string, chatId: string): Promise<boolean> {
    return this.touchRun(userId, chatId, null);
  }

  private async touchRun(userId: string, chatId: string, usedMs: number | null): Promise<boolean> {
    try {
      await db.send(
        new UpdateCommand({
          TableName: T.chats(),
          Key: { userId, chatId },
          UpdateExpression: usedMs === null ? "SET #run.#until = :until" : "SET #run.#until = :until, #run.#used = :used",
          ConditionExpression: "attribute_exists(#run) AND attribute_not_exists(#run.#cancelled)",
          ExpressionAttributeNames: {
            "#run": "run",
            "#until": "until",
            "#cancelled": "cancelled",
            ...(usedMs === null ? {} : { "#used": "usedMs" }),
          },
          ExpressionAttributeValues: { ":until": Date.now() + RUN_LEASE_MS, ...(usedMs === null ? {} : { ":used": usedMs }) },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  /**
   * Cancel was pressed: note it on the run, for a task that is between two
   * Lambdas and has no worker to tell. A running worker hears it directly.
   */
  async markCancelled(userId: string, chatId: string): Promise<void> {
    await db
      .send(
        new UpdateCommand({
          TableName: T.chats(),
          Key: { userId, chatId },
          UpdateExpression: "SET #run.#cancelled = :yes",
          ConditionExpression: "attribute_exists(#run)",
          ExpressionAttributeNames: { "#run": "run", "#cancelled": "cancelled" },
          ExpressionAttributeValues: { ":yes": true },
        }),
      )
      .catch((err) => {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
      });
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
    return Promise.all((res.Items ?? []).map((i) => toMemory(userId, i)));
  }

  async getMemory(userId: string, topic: string, slug: string): Promise<MemoryRecord | null> {
    const res = await db.send(
      new GetCommand({ TableName: T.memories(), Key: { userId, key: `${topic}/${slug}` } }),
    );
    return res.Item ? toMemory(userId, res.Item) : null;
  }

  /**
   * What a memory says is sealed; the topic and slug that make its key, and its
   * dates, are not (the key is how the table finds it).
   */
  async putMemory(userId: string, memory: MemoryRecord): Promise<void> {
    const key = `${memory.topic}/${memory.slug}`;
    const { title, content, ...rest } = memory;
    await db.send(
      new PutCommand({
        TableName: T.memories(),
        Item: {
          userId,
          key,
          ...rest,
          titleEnc: await sealing.seal(title, userId, `memory-title:${key}`),
          contentEnc: await sealing.seal(content, userId, `memory-content:${key}`),
        },
      }),
    );
  }

  async deleteMemory(userId: string, topic: string, slug: string): Promise<void> {
    await db.send(new DeleteCommand({ TableName: T.memories(), Key: { userId, key: `${topic}/${slug}` } }));
  }

  async listWorkflows(userId: string): Promise<WorkflowRecord[]> {
    const res = await db.send(
      new QueryCommand({
        TableName: T.workflows(),
        KeyConditionExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": userId },
      }),
    );
    return Promise.all(
      (res.Items ?? []).map(async (i) => ({
        id: i.id as string,
        name: (await sealing.textOf(i.nameEnc ?? i.name, userId, `workflow-name:${i.id}`)) ?? "",
        steps: (await sealing.textOf(i.stepsEnc ?? i.steps, userId, `workflow-steps:${i.id}`)) ?? "",
        created: (i.created as string | undefined) ?? "",
        updated: (i.updated as string | undefined) ?? "",
      })),
    );
  }

  async putWorkflow(userId: string, workflow: WorkflowRecord): Promise<void> {
    const { name, steps, ...rest } = workflow;
    await db.send(
      new PutCommand({
        TableName: T.workflows(),
        Item: {
          userId,
          ...rest,
          nameEnc: await sealing.seal(name, userId, `workflow-name:${workflow.id}`),
          stepsEnc: await sealing.seal(steps, userId, `workflow-steps:${workflow.id}`),
        },
      }),
    );
  }

  async deleteWorkflow(userId: string, id: string): Promise<void> {
    await db.send(new DeleteCommand({ TableName: T.workflows(), Key: { userId, id } }));
  }

  async loadTask(userId: string, chatId: string): Promise<TaskState | null> {
    const res = await db.send(new GetCommand({ TableName: T.tasks(), Key: { userId, chatId } }));
    if (res.Item?.stateEnc) return JSON.parse(await sealing.unseal(res.Item.stateEnc, userId, `task:${chatId}`)) as TaskState;
    // From before sealing.
    return (res.Item?.state as TaskState | undefined) ?? null;
  }

  async saveTask(userId: string, chatId: string, task: TaskState): Promise<void> {
    await db.send(
      new PutCommand({
        TableName: T.tasks(),
        Item: { userId, chatId, stateEnc: await sealing.sealJson(task, userId, `task:${chatId}`) },
      }),
    );
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
      if (!stored[p]) continue;
      const key = stored[p].apiKey;
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
 * Encrypts what was saved for a user before saving was encrypted: every chat's
 * transcript and listing, tracked tasks, memories and workflows are read and
 * written back sealed. Safe to run again, and on a user whose data is already
 * sealed. A chat with a task running is left for next time, not written under it.
 */
export async function encryptUserData(
  userId: string,
): Promise<{ chats: number; busy: number; tasks: number; memories: number; workflows: number }> {
  const cloud = new CloudStore();
  const done = { chats: 0, busy: 0, tasks: 0, memories: 0, workflows: 0 };
  for (const item of await cloud.chatItems(userId)) {
    // Only a task actually running holds the transcript; one waiting on the person does not.
    if (item.run && item.run.until > Date.now()) {
      done.busy++;
      continue;
    }
    const chat = (await cloud.loadChat(userId, item.chatId)) as Session | null;
    if (!chat) continue;
    await cloud.saveChat(userId, chat);
    done.chats++;
  }
  let start: Record<string, unknown> | undefined;
  do {
    const res = await db.send(
      new QueryCommand({
        TableName: T.tasks(),
        KeyConditionExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": userId },
        ProjectionExpression: "chatId",
        ExclusiveStartKey: start,
      }),
    );
    for (const { chatId } of res.Items ?? []) {
      const task = await cloud.loadTask(userId, chatId);
      if (task) {
        await cloud.saveTask(userId, chatId, task);
        done.tasks++;
      }
    }
    start = res.LastEvaluatedKey;
  } while (start);
  for (const memory of await cloud.listMemories(userId)) {
    await cloud.putMemory(userId, memory);
    done.memories++;
  }
  for (const workflow of await cloud.listWorkflows(userId)) {
    await cloud.putWorkflow(userId, workflow);
    done.workflows++;
  }
  return done;
}

/**
 * Everything kept for a user: chats and their transcripts, tracked tasks,
 * memories, workflows, settings, usage, and the plan and credits on their account. For
 * "Delete my account" — there is no undo.
 */
export async function deleteUserData(userId: string): Promise<{ items: number; transcripts: number }> {
  let items = 0;
  // The account's link from its Stripe customer back to it goes too. Stripe keeps its own payment records.
  const customer = (
    await db.send(
      new GetCommand({ TableName: T.accounts(), Key: { userId }, ProjectionExpression: "stripeCustomerId" }),
    )
  ).Item?.stripeCustomerId as string | undefined;
  if (customer) await db.send(new DeleteCommand({ TableName: T.accounts(), Key: { userId: `stripe#${customer}` } }));
  for (const [table, sortKey] of [
    [T.chats(), "chatId"],
    [T.tasks(), "chatId"],
    [T.memories(), "key"],
    [T.workflows(), "id"],
    [T.usage(), "week"],
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

async function toMemory(userId: string, item: Record<string, any>): Promise<MemoryRecord> {
  const key = `${item.topic}/${item.slug}`;
  return {
    topic: item.topic,
    slug: item.slug,
    title: (await sealing.textOf(item.titleEnc ?? item.title, userId, `memory-title:${key}`)) ?? "",
    created: item.created,
    updated: item.updated,
    content: (await sealing.textOf(item.contentEnc ?? item.content, userId, `memory-content:${key}`)) ?? "",
  };
}
