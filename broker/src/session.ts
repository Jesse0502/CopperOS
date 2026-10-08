// Chat transcripts.
//
// A task is a turn in an ongoing conversation, not a fresh start: follow-ups
// like "now open the second result" only work if the previous turns are still
// there. The broker owns this because it owns the message history — the
// extension's storage.session is for UI state and dies with the browser.
// Where transcripts are kept is the store's business (store/store.ts).

import type OpenAI from "openai";
import type { PendingRequest } from "./bridge.js";
import { store, type ChatSummary } from "./store/store.js";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** "all": every click and submit gated. "submits": only destructive actions. "none": never asked. */
export type ApprovalMode = "all" | "submits" | "none";

const DEFAULT_APPROVAL_MODE: ApprovalMode =
  (process.env.APPROVAL_MODE as ApprovalMode | undefined) ?? "submits";

// Whether a new chat's tasks get supervisor check-ins (see supervisor.ts).
// Off unless the user turns it on in the chat, or SUPERVISOR=on.
const DEFAULT_SUPERVISOR = process.env.SUPERVISOR === "on";

/**
 * A task stopped to wait for the person — an approval or a question form.
 * The transcript keeps the tool call that asked, unanswered; `loop` is where
 * the agent loop stood, so the answer carries it on as if it never stopped.
 */
export type Paused = {
  request: PendingRequest;
  /** The tool call waiting on the answer. */
  callId: string;
  /** When it paused. */
  at: string;
  loop: {
    round: number;
    /** Steps taken in this round so far. */
    step: number;
    /** Steps taken in the whole turn so far. */
    steps: number;
    stalls: number;
    /** progressMark at the start of this round, or false for an untracked turn. */
    markBefore: string | false;
    tracked: boolean;
    watch: { strikes: number; trail: string[] } | null;
    jobTask: boolean;
    finalText: string;
    /** Active time spent on the task before it paused, against its time limit. */
    timeUsedMs: number;
  };
};

export type Session = {
  id: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  /** The user's prompts, oldest first — a readable index of the transcript. */
  tasks: string[];
  /**
   * Answers the user gave to ask_user forms, as "question — answer". Kept
   * beside `tasks` because they count as much as anything the user typed
   * when form entries are checked against what the user said.
   */
  answers: string[];
  /** Full history minus the system prompt, which is a frozen constant. */
  messages: Msg[];
  /**
   * Per-chat settings — each agent is independent, so these are not global.
   * `supervisor` turns on check-ins for the chat's tracked tasks.
   */
  settings: { approvalMode: ApprovalMode; supervisor: boolean };
  /**
   * The person has been asked whether to keep a repeating task as a mold (once
   * a chat is enough), or the chat is running a saved mold, which is never
   * offered to be saved again.
   */
  workflowOffered?: boolean;
  /** The chat is helping the person make a mold, until one is shown to them (propose_mold). */
  molding?: boolean;
  /** Set while the chat's task is waiting on the person. */
  paused?: Paused;
  /**
   * Set when a long task's run ended only because its Lambda was about to be
   * cut off, not because the task was done or out of time: where the loop
   * stood, so the next Lambda carries it on (Agent.continueSlice).
   */
  slice?: { loop: Paused["loop"] };
};

export type SessionSummary = ChatSummary;

function newId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

export function blank(model: string): Session {
  const now = new Date().toISOString();
  return {
    id: newId(), createdAt: now, updatedAt: now, model, tasks: [], answers: [], messages: [],
    settings: { approvalMode: DEFAULT_APPROVAL_MODE, supervisor: DEFAULT_SUPERVISOR },
  };
}

/**
 * Screenshots are never worth keeping: they are megabytes of base64, and their
 * badge numbers refer to refs that stopped existing the moment the page moved.
 * Also how agent.ts makes a request fit for a model that cannot take images,
 * with its own `note` in place of each one.
 */
export function stripImages(
  messages: Msg[],
  note = "(screenshot not kept in the transcript)",
): Msg[] {
  return messages.map((m) => {
    if (m.role !== "tool" || typeof m.content === "string") return m;
    const parts = m.content as unknown as Array<
      { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
    >;
    if (!parts.some((p) => p.type === "image_url")) return m;
    const kept = parts.filter((p) => p.type === "text");
    kept.push({ type: "text", text: note });
    return { ...m, content: kept as unknown as typeof m.content };
  });
}

/**
 * Make a transcript safe to send. A run that died mid-tool-call leaves an
 * assistant message whose tool_calls have no results, which the API rejects
 * outright — so drop orphaned tool results and cut back to the last point
 * where nothing was left pending. `keepOpenTail` is for a paused task: its
 * last tool calls are unanswered on purpose, and resuming answers them.
 */
export function sanitize(messages: Msg[], keepOpenTail = false): Msg[] {
  if (keepOpenTail) {
    const i = messages.findLastIndex((m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0);
    if (i !== -1) {
      const calls = messages[i] as Extract<Msg, { role: "assistant" }>;
      const ids = new Set(calls.tool_calls!.map((c) => c.id));
      const results = messages
        .slice(i + 1)
        .filter((m) => m.role === "tool" && ids.has(m.tool_call_id));
      return [...sanitize(messages.slice(0, i)), calls, ...results];
    }
  }

  const open = new Set<string>();
  const kept: Msg[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      if (!open.has(m.tool_call_id)) continue; // result with no matching call
      open.delete(m.tool_call_id);
      kept.push(m);
      continue;
    }
    if (m.role === "assistant") {
      for (const c of m.tool_calls ?? []) open.add(c.id);
    }
    kept.push(m);
  }

  const pending = new Set<string>();
  let safe = 0;
  kept.forEach((m, i) => {
    if (m.role === "assistant") for (const c of m.tool_calls ?? []) pending.add(c.id);
    if (m.role === "tool") pending.delete(m.tool_call_id);
    if (pending.size === 0) safe = i + 1;
  });
  return kept.slice(0, safe);
}

export async function save(userId: string, session: Session): Promise<void> {
  const payload: Session = {
    ...session,
    updatedAt: new Date().toISOString(),
    messages: stripImages(session.messages),
  };
  await store().saveChat(userId, payload);
  await store().setCurrentChat(userId, session.id);
}

/** A chat that was never saved: a new one, or one that is gone. Any other load failure is not this. */
export class ChatNotFound extends Error {}

async function loadById(userId: string, id: string, model: string): Promise<Session> {
  const raw = (await store().loadChat(userId, id)) as Session | null;
  if (!raw) throw new ChatNotFound(`no saved chat ${id}`);
  return {
    ...blank(model),
    ...raw,
    model,
    messages: sanitize(raw.messages ?? [], Boolean(raw.paused)),
    tasks: raw.tasks ?? [],
    answers: raw.answers ?? [],
    settings: {
      approvalMode: raw.settings?.approvalMode ?? DEFAULT_APPROVAL_MODE,
      supervisor: raw.settings?.supervisor ?? DEFAULT_SUPERVISOR,
    },
  };
}

/** The chat last opened, or a fresh one if there is nothing usable. */
export async function loadCurrent(userId: string, model: string): Promise<Session> {
  try {
    const id = await store().getCurrentChat(userId);
    return id ? await loadById(userId, id, model) : blank(model);
  } catch {
    // Unreadable storage, or a chat that has gone. Either way, start clean.
    return blank(model);
  }
}

/** Load a specific past chat by id, to resume it as the active session. */
export function loadSession(userId: string, id: string, model: string): Promise<Session> {
  return loadById(userId, id, model);
}

/**
 * Make an already-saved chat the one to resume, without rewriting it — used
 * when switching to a past chat, so its updatedAt (last real activity) is not
 * bumped just from being opened.
 */
export function setCurrent(userId: string, id: string): Promise<void> {
  return store().setCurrentChat(userId, id);
}

/** Every saved chat, newest activity first. */
export async function listSessions(userId: string): Promise<SessionSummary[]> {
  const summaries = await store().listChats(userId);
  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return summaries;
}
