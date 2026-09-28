// The state of a chat's current task — "apply to 10 jobs" — kept outside the
// transcript, so a task can be carried across rounds that each start from a
// fresh context. The model writes to it with update_progress (tools.ts); the
// agent loop (agent.ts) reads it to brief each fresh round and to ask Jev
// whether the task is finished. Only kept when Jev is configured, since
// nothing reads it otherwise. One per chat, kept by the store
// (store/store.ts); a new task replaces it.

import { store } from "./store/store.js";

export type TaskState = {
  /** The message that started the task, verbatim — its conditions carry into every fresh round. */
  instructions: string;
  /** Later messages that resumed or adjusted it ("continue", "only Melbourne from now on"). */
  followUps: string[];
  done: string[];
  /** Each with the reason it was skipped. */
  skipped: string[];
  /** Where things stand and what is next, as of the model's last update. */
  note: string;
  /** The model's final message from the most recent round, or its answer to the check-in that ended it. */
  lastReport: string;
  /**
   * Why a check-in ended the last round, when it found the model off course
   * — for the next round's brief. Empty (or missing, in older files) when
   * nothing went wrong.
   */
  supervisor?: string;
  /** Rules the user set for the supervisor before sending the task, if any. */
  rules?: string;
  status: "active" | "done" | "needs_user";
  /** Why the loop last stopped, or that it is still going — for whoever opens this file. */
  lastCheck: string;
  rounds: number;
  createdAt: string;
  updatedAt: string;
};

export function newTask(instructions: string): TaskState {
  const now = new Date().toISOString();
  return {
    instructions,
    followUps: [],
    done: [],
    skipped: [],
    note: "",
    lastReport: "",
    status: "active",
    lastCheck: "",
    rounds: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** The chat's current task, or null if it has none (or it is unreadable). */
export async function loadTask(userId: string, chatId: string): Promise<TaskState | null> {
  try {
    return await store().loadTask(userId, chatId);
  } catch {
    return null;
  }
}

export async function saveTask(userId: string, chatId: string, task: TaskState): Promise<void> {
  await store().saveTask(userId, chatId, { ...task, updatedAt: new Date().toISOString() });
}

function sameItem(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return norm(a) === norm(b);
}

/** Add only the items not already in `into` — models tend to resend the whole list rather than just what is new. */
function addNew(into: string[], items: string[]): void {
  for (const item of items) {
    if (!into.some((have) => sameItem(have, item))) into.push(item);
  }
}

/** Merge in what the model reports. Null when the chat has no task on record. */
export async function recordProgress(
  userId: string,
  chatId: string,
  update: { done: string[]; skipped: string[]; note: string },
): Promise<TaskState | null> {
  const task = await loadTask(userId, chatId);
  if (!task) return null;
  addNew(task.done, update.done);
  addNew(task.skipped, update.skipped);
  if (update.note) task.note = update.note;
  await saveTask(userId, chatId, task);
  return task;
}

/** Changes whenever the model records anything — how agent.ts spots a round that got nowhere. */
export function progressMark(task: TaskState): string {
  return `${task.done.length}|${task.skipped.length}|${task.note}`;
}

const BRIEF_PREFIX = "[Fresh round ";
const REPORT_CAP = 1500;

/** Whether a transcript message is a fresh round's brief rather than something the user typed. */
export function isBrief(text: string): boolean {
  return text.startsWith(BRIEF_PREFIX);
}

function list(items: string[]): string {
  return items.length ? items.map((s) => `- ${s}`).join("\n") : "(none)";
}

/**
 * The opening message of a fresh round. Earlier rounds' messages are not
 * sent, so this has to carry everything: the original instructions word for
 * word, anything the user added since, and what is already done.
 */
export function brief(task: TaskState): string {
  const report =
    task.lastReport.length > REPORT_CAP
      ? `${task.lastReport.slice(0, REPORT_CAP)}…`
      : task.lastReport;
  return (
    `${BRIEF_PREFIX}${task.rounds + 1} of an ongoing task. Earlier rounds' ` +
    `messages were cleared to save context — everything you need is below.\n\n` +
    `<instructions>\n${task.instructions}\n</instructions>\n\n` +
    (task.followUps.length
      ? `<later_instructions>\n${list(task.followUps)}\n</later_instructions>\n\n`
      : "") +
    (task.rules ? `<supervisor_rules>\n${task.rules}\n</supervisor_rules>\n\n` : "") +
    `<progress>\nDone (${task.done.length}):\n${list(task.done)}\n\n` +
    `Skipped (${task.skipped.length}):\n${list(task.skipped)}\n\n` +
    `Note: ${task.note || "(none)"}\n</progress>\n\n` +
    `<last_report>\n${report || "(none)"}\n</last_report>\n\n` +
    (task.supervisor ? `<supervisor>\n${task.supervisor}\n</supervisor>\n\n` : "") +
    `Pick up where the last round stopped. Do not redo anything listed as ` +
    `done or skipped. If the last report says how the work was being done ` +
    `and no supervisor note says otherwise, keep doing it that way rather ` +
    `than finding a new one. The browser may have moved on, so take a fresh ` +
    `snapshot first. Keep recording each finished or skipped item with ` +
    `update_progress.]`
  );
}
