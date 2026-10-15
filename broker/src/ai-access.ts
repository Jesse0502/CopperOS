// What a connected AI is allowed to do to a chat, and how a chat is shown to it —
// the parts the local task API (task-api.ts) and the hosted MCP endpoint
// (cloud/mcp-backend.ts) must agree on.

import type { PendingRequest } from "./bridge.js";
import type { ApprovalMode } from "./session.js";
import type { Workflow } from "./workflows.js";

/** How much each approval mode asks about: a higher number asks more. */
export const STRICTNESS: Record<string, number> = { all: 2, submits: 1, none: 0 };

/**
 * Whether a change makes CopperOS ask for less: a mode that asks about fewer
 * actions, or the supervisor switched off. Asking for more is never one.
 */
export function isLoosening(
  now: { approvalMode: ApprovalMode; supervisor: boolean },
  patch: { approvalMode?: string; supervisor?: boolean },
): boolean {
  return (
    (patch.approvalMode !== undefined && STRICTNESS[patch.approvalMode] < STRICTNESS[now.approvalMode]) ||
    (patch.supervisor === false && now.supervisor)
  );
}

/** A settings change as a caller sent it, checked: the words to send back if it is not one. */
export function settingsProblem(patch: { approvalMode?: unknown; supervisor?: unknown }): string | null {
  if (patch.approvalMode !== undefined && (typeof patch.approvalMode !== "string" || !(patch.approvalMode in STRICTNESS))) {
    return "approvalMode must be all, submits or none";
  }
  if (patch.supervisor !== undefined && typeof patch.supervisor !== "boolean") return "supervisor must be true or false";
  if (patch.approvalMode === undefined && patch.supervisor === undefined) return "nothing to change";
  return null;
}

/** What the panel's Run on a mold sends, so a mold behaves the same from either. */
export function moldPrompt(m: Workflow, details: string): string {
  return (
    `Mold: ${m.name}\n\n` +
    `Follow these steps, in order. Tell me when it is done, or which step you could not do and why.\n\n${m.steps}` +
    (details ? `\n\nFor this run: ${details}` : "")
  );
}

export const TURN_CAP = 6000;
export const cap = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}… (cut)` : text);

/** The conversation as turns; each turn's supervisor rules ride on the message the person sent. */
export function turnsOf(events: { event: string; text: string }[]) {
  const turns: { from: "you" | "copper"; text: string; rules?: string }[] = [];
  for (const e of events) {
    if (e.event === "start") turns.push({ from: "you", text: cap(e.text, TURN_CAP) });
    else if (e.event === "rules") {
      const last = turns.at(-1);
      if (last) last.rules = e.text;
    } else if (e.event === "say") turns.push({ from: "copper", text: cap(e.text, TURN_CAP) });
  }
  return turns;
}

/** What a paused task is waiting on the person for, as one piece of text. */
export function waitingOf(p: PendingRequest): { kind: "approval" | "questions"; text: string } {
  return p.kind === "approval"
    ? { kind: "approval", text: p.text }
    : { kind: "questions", text: [p.ask.intro, ...p.ask.questions.map((q, i) => `${i + 1}. ${q.question}`)].filter(Boolean).join("\n") };
}
