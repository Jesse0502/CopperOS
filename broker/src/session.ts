// Disk-backed chat transcripts.
//
// A task is a turn in an ongoing conversation, not a fresh start: follow-ups
// like "now open the second result" only work if the previous turns are still
// there. The broker owns this because it owns the message history — the
// extension's storage.session is for UI state and dies with the browser.
//
// Layout, under STORAGE_DIR (default <repo>/storage):
//   sessions/<id>.json   one transcript per chat
//   current.json         which one to resume on startup

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type OpenAI from "openai";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const ROOT =
  process.env.STORAGE_DIR ?? path.resolve(import.meta.dirname, "../../storage");
const SESSIONS = path.join(ROOT, "sessions");
const CURRENT = path.join(ROOT, "current.json");

/** "all": every click and submit gated. "submits": only destructive actions. "none": never asked. */
export type ApprovalMode = "all" | "submits" | "none";

const DEFAULT_APPROVAL_MODE: ApprovalMode =
  (process.env.APPROVAL_MODE as ApprovalMode | undefined) ?? "submits";

export type Session = {
  id: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  /** The user's prompts, oldest first — a readable index of the transcript. */
  tasks: string[];
  /** Full history minus the system prompt, which is a frozen constant. */
  messages: Msg[];
  /** Per-chat settings — each agent is independent, so these are not global. */
  settings: { approvalMode: ApprovalMode };
};

export const storageDir = ROOT;

export type SessionSummary = {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** The first prompt in the chat, for display — "(empty chat)" if never used. */
  title: string;
  taskCount: number;
};

function newId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

export function blank(model: string): Session {
  const now = new Date().toISOString();
  return {
    id: newId(), createdAt: now, updatedAt: now, model, tasks: [], messages: [],
    settings: { approvalMode: DEFAULT_APPROVAL_MODE },
  };
}

/**
 * Screenshots are never worth keeping: they are megabytes of base64, and their
 * badge numbers refer to refs that stopped existing the moment the page moved.
 */
function stripImages(messages: Msg[]): Msg[] {
  return messages.map((m) => {
    if (m.role !== "tool" || typeof m.content === "string") return m;
    const parts = m.content as unknown as Array<
      { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
    >;
    if (!parts.some((p) => p.type === "image_url")) return m;
    const kept = parts.filter((p) => p.type === "text");
    kept.push({ type: "text", text: "(screenshot not kept in the transcript)" });
    return { ...m, content: kept as unknown as typeof m.content };
  });
}

/**
 * Make a transcript safe to send. A run that died mid-tool-call leaves an
 * assistant message whose tool_calls have no results, which the API rejects
 * outright — so drop orphaned tool results and cut back to the last point
 * where nothing was left pending.
 */
export function sanitize(messages: Msg[]): Msg[] {
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

export async function save(session: Session): Promise<void> {
  await mkdir(SESSIONS, { recursive: true });
  const payload: Session = {
    ...session,
    updatedAt: new Date().toISOString(),
    messages: stripImages(session.messages),
  };
  const file = path.join(SESSIONS, `${session.id}.json`);
  // Write-then-rename: a crash mid-write leaves the previous transcript intact
  // rather than a truncated one that fails to parse on the next start.
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await rename(tmp, file);

  const ctmp = `${CURRENT}.tmp`;
  await writeFile(ctmp, JSON.stringify({ id: session.id }, null, 2), "utf8");
  await rename(ctmp, CURRENT);
}

async function loadById(id: string, model: string): Promise<Session> {
  const raw = JSON.parse(
    await readFile(path.join(SESSIONS, `${id}.json`), "utf8"),
  ) as Session;
  return {
    ...blank(model),
    ...raw,
    model,
    messages: sanitize(raw.messages ?? []),
    tasks: raw.tasks ?? [],
    settings: { approvalMode: raw.settings?.approvalMode ?? DEFAULT_APPROVAL_MODE },
  };
}

/** The session named by current.json, or a fresh one if there is nothing usable. */
export async function loadCurrent(model: string): Promise<Session> {
  try {
    const { id } = JSON.parse(await readFile(CURRENT, "utf8")) as { id: string };
    return await loadById(id, model);
  } catch {
    // No storage yet, or it is unreadable. Either way, start clean.
    return blank(model);
  }
}

/** Load a specific past chat by id, to resume it as the active session. */
export function loadSession(id: string, model: string): Promise<Session> {
  return loadById(id, model);
}

/**
 * Point current.json at an already-saved session without rewriting it — used
 * when switching to a past chat, so its updatedAt (last real activity) is not
 * bumped just from being opened.
 */
export async function setCurrent(id: string): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  const ctmp = `${CURRENT}.tmp`;
  await writeFile(ctmp, JSON.stringify({ id }, null, 2), "utf8");
  await rename(ctmp, CURRENT);
}

/** Every saved chat, newest activity first. */
export async function listSessions(): Promise<SessionSummary[]> {
  let files: string[];
  try {
    files = await readdir(SESSIONS);
  } catch {
    return [];
  }
  const summaries: SessionSummary[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(await readFile(path.join(SESSIONS, f), "utf8")) as Session;
      const tasks = raw.tasks ?? [];
      summaries.push({
        id: raw.id,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        title: tasks[0] ?? "(empty chat)",
        taskCount: tasks.length,
      });
    } catch {
      // Skip a corrupt or mid-write file rather than failing the whole list.
    }
  }
  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return summaries;
}
