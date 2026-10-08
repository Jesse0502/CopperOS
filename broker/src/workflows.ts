// Workflows: a task the user has done once, kept as the steps to do it again.
// Instead of explaining it a second time, or digging the old chat out of the
// history, they click it and the agent follows the steps in a fresh chat.
//
// A workflow is a name and plain text steps the user can read and edit. One
// comes from the Workflows page (typed by hand) or from a chat that went well:
// the model writes the chat up as steps (draftPrompt), the user reads and
// fixes them, and saves. Running one is just sending its steps as a task
// (the panel does that), so everything a task gets — approvals, the
// supervisor, grounding against what the user said — applies to it, and the
// steps count as the user's own words because they saved them.

import { store, type WorkflowRecord } from "./store/store.js";

export type Workflow = WorkflowRecord;

const MAX_WORKFLOWS = 50;
const NAME_CAP = 80;
const STEPS_CAP = 6000;

const ID_PATTERN = /^wf_[a-z0-9]{6,24}$/;

function newId(): string {
  return `wf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// Saves in the same millisecond would tie, and a tie has no "newest": each save
// takes a stamp later than the last this process made, so the newest sorts first.
let lastStamp = 0;
function stamp(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
}

/** Most recently changed first. */
export async function listWorkflows(userId: string): Promise<Workflow[]> {
  return (await store().listWorkflows(userId)).sort((a, b) => b.updated.localeCompare(a.updated));
}

/**
 * Saves a workflow — a new one, or `id`'s with the new words — and returns the
 * list as it now is. The words are trimmed and capped; one with no name or no
 * steps is refused with a message for the user.
 */
export async function saveWorkflow(
  userId: string,
  input: { id?: unknown; name: unknown; steps: unknown },
): Promise<Workflow[]> {
  const name = String(input.name ?? "").replace(/\s+/g, " ").trim().slice(0, NAME_CAP);
  const steps = String(input.steps ?? "").replace(/\r\n/g, "\n").trim().slice(0, STEPS_CAP);
  if (!name) throw new Error("Give the mold a name.");
  if (!steps) throw new Error("Write at least one step.");

  const existing = await store().listWorkflows(userId);
  const id = typeof input.id === "string" && ID_PATTERN.test(input.id) ? input.id : null;
  const old = id ? existing.find((w) => w.id === id) : undefined;
  // A new one that is already saved — the same steps, or the same name — is not saved twice.
  if (!old) {
    const same = (a: string) => a.toLowerCase().replace(/\s+/g, " ").trim();
    const twin = existing.find((w) => same(w.steps) === same(steps) || same(w.name) === same(name));
    if (twin) throw new Error(`That one is already saved, as “${twin.name}”.`);
  }
  if (!old && existing.length >= MAX_WORKFLOWS) {
    throw new Error(`You can keep up to ${MAX_WORKFLOWS} molds. Delete one you no longer use first.`);
  }
  const now = stamp();
  await store().putWorkflow(userId, {
    id: old?.id ?? newId(),
    name,
    steps,
    created: old?.created ?? now,
    updated: now,
  });
  return listWorkflows(userId);
}

export async function deleteWorkflow(userId: string, id: unknown): Promise<Workflow[]> {
  if (typeof id === "string" && ID_PATTERN.test(id)) await store().deleteWorkflow(userId, id);
  return listWorkflows(userId);
}

/**
 * What the model is asked to write a workflow from: the digest of a chat that
 * went well (agent.ts's chatDigest), or the request a person has just made.
 */
export function draftPrompt(digest: string, kind: "chat" | "request" = "chat"): string {
  const from =
    kind === "chat"
      ? `Below is a chat in which a browser agent did a task for the user: the user's messages, the agent's actions in order, and its replies.`
      : `Below is what a user has just asked a browser agent to do.`;
  return (
    `${from}\n\n` +
    `Write a reusable workflow, so the agent can do this task again from scratch whenever the user asks, without being told again.\n\n` +
    `Reply with JSON only, no other text: {"name": "...", "steps": ["...", "..."]}\n` +
    `- name: two to six words, what the workflow does, like "Apply to jobs on Indeed".\n` +
    `- steps: three to twelve short instructions to the agent, in order. Name the sites` +
    `${kind === "chat" ? ", and the exact controls or filters that mattered" : " the request names"}. ` +
    `Keep every preference or rule the user gave: what to include or avoid, how many, when to stop (or that it goes on until they stop it), what to ask them about first. ` +
    `${kind === "chat" ? "Leave out dead ends, retries, and anything that only worked by accident. " : ""}Where a value changes from one run to the next ` +
    `(a search term, a person, a date), say so in angle brackets, like <job title>.\n` +
    `- Do not invent ${kind === "chat" ? "steps the chat does not show" : "details the request does not give"}. Do not include passwords, card numbers or other secrets.\n\n` +
    `<${kind}>\n${digest}\n</${kind}>`
  );
}

/**
 * The model's answer as a workflow. Tolerates what models do around JSON (a
 * code fence, a line of chat before it), and falls back to the answer's own
 * lines as the steps when there is no JSON at all, so a draft is never lost.
 */
export function parseDraft(answer: string, fallbackName: string): { name: string; steps: string } {
  const text = answer.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as { name?: unknown; steps?: unknown };
      const steps = (Array.isArray(parsed.steps) ? parsed.steps : [])
        .map((s) => String(s ?? "").replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim())
        .filter(Boolean);
      if (steps.length) {
        const name = String(parsed.name ?? "").replace(/\s+/g, " ").trim() || fallbackName;
        return { name: name.slice(0, NAME_CAP), steps: steps.map((s, i) => `${i + 1}. ${s}`).join("\n") };
      }
    } catch {
      // Not JSON after all: fall through.
    }
  }
  const lines = text
    .replace(/```[a-z]*/gi, "")
    .split("\n")
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim())
    .filter(Boolean);
  return { name: fallbackName.slice(0, NAME_CAP), steps: lines.map((s, i) => `${i + 1}. ${s}`).join("\n") };
}
