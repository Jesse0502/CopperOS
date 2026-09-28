// Where everything the broker keeps lives, per user: chat transcripts, which
// chat was last open, saved memories, task progress and LLM settings.
//
// Only raw reads and writes live behind this interface. What the data means
// — sanitizing a transcript, ranking memories, briefing a fresh round — stays
// in session.ts, memory.ts, progress.ts and config.ts, which both the local
// broker and the cloud share. The local broker uses files and one user,
// LOCAL_USER (store/fs.ts); the cloud will use DynamoDB and S3.

import type { PendingRequest } from "../bridge.js";
import type { LLMConfig } from "../config.js";
import type { TaskState } from "../progress.js";
import type { Session } from "../session.js";

/** The only user of a local broker. */
export const LOCAL_USER = "local";

/** One saved memory, as the store keeps it. */
export type MemoryRecord = {
  topic: string;
  slug: string;
  title: string;
  created: string;
  updated: string;
  content: string;
};

/** What the chat list shows for one chat, without loading its transcript. */
export type ChatSummary = {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** The first prompt in the chat, for display — "(empty chat)" if never used. */
  title: string;
  taskCount: number;
  /** What the chat's task is waiting on the person for, if it is paused. */
  pending?: PendingRequest;
};

export function summarize(
  chat: Pick<Session, "id" | "createdAt" | "updatedAt" | "tasks" | "paused">,
): ChatSummary {
  const tasks = chat.tasks ?? [];
  return {
    id: chat.id,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    title: tasks[0] ?? "(empty chat)",
    taskCount: tasks.length,
    ...(chat.paused ? { pending: chat.paused.request } : {}),
  };
}

export interface Store {
  /** A chat as it was saved, not yet checked — null if there is none by that id. */
  loadChat(userId: string, chatId: string): Promise<unknown | null>;
  saveChat(userId: string, chat: Session): Promise<void>;
  /** Every saved chat, in no particular order, skipping any that cannot be read. */
  listChats(userId: string): Promise<ChatSummary[]>;
  /** The chat to resume on a cold start, or null if none was ever opened. */
  getCurrentChat(userId: string): Promise<string | null>;
  setCurrentChat(userId: string, chatId: string): Promise<void>;

  /** Every saved memory, skipping any that cannot be read. */
  listMemories(userId: string): Promise<MemoryRecord[]>;
  getMemory(userId: string, topic: string, slug: string): Promise<MemoryRecord | null>;
  putMemory(userId: string, memory: MemoryRecord): Promise<void>;

  loadTask(userId: string, chatId: string): Promise<TaskState | null>;
  saveTask(userId: string, chatId: string, task: TaskState): Promise<void>;

  /** The user's saved LLM settings as they were written, or null if never saved. */
  loadConfig(userId: string): Promise<unknown | null>;
  saveConfig(userId: string, config: LLMConfig): Promise<void>;
}

let active: Store | null = null;

/** Set once at startup, by whichever entry point is running. */
export function useStore(store: Store): void {
  active = store;
}

export function store(): Store {
  if (!active) throw new Error("no store configured — call useStore() at startup");
  return active;
}
