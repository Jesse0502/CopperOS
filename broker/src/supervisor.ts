// Check-ins on a tracked task while it runs.
//
// Left alone for long, the model drifts from what it was asked: it tries
// another way of doing the task, starts on something nobody asked for, or
// reports work it never did. In the user's Sheets run it started over in a
// fresh round, set conditional-format rules to "None" row after row instead
// of colouring them, recorded ten rows as coloured, and when asked to verify
// spent the whole turn rewriting those rules. So every few steps agent.ts
// stops the model to ask what it is doing (checkInPrompt), Jev compares that
// and what it actually did (the trail describeAction builds) with the user's
// instructions, and the model is told to carry on or how it went wrong
// (feedback). The texts the model sees live here; the loop is in agent.ts.

import type { Drift } from "./jev.js";
import type { TaskState } from "./progress.js";
import type { ToolResult } from "./tools.js";

const CHECK_IN_PREFIX = "[Supervisor check-in";
const FEEDBACK_PREFIX = "[Supervisor:";

/** Whether a transcript message is a check-in question, which the next assistant message answers. */
export function isCheckIn(text: string): boolean {
  return text.startsWith(CHECK_IN_PREFIX);
}

/** Whether a transcript message is a check-in or its feedback — notes to the model, not the user's words. */
export function isSupervisorNote(text: string): boolean {
  return isCheckIn(text) || text.startsWith(FEEDBACK_PREFIX);
}

/**
 * The check-in question. It restates the instructions word for word: after
 * dozens of steps they sit far back in the context, and this puts them next
 * to what the model reads last.
 */
export function checkInPrompt(task: TaskState, step: number): string {
  return (
    `${CHECK_IN_PREFIX} after step ${step}. Answer in words only — no tool calls.\n\n` +
    `The user's instructions for this task, word for word:\n` +
    `<instructions>\n${task.instructions}\n</instructions>\n\n` +
    (task.followUps.length
      ? `<later_instructions>\n${task.followUps.map((s) => `- ${s}`).join("\n")}\n</later_instructions>\n\n`
      : "") +
    `In three to five sentences: What are you doing right now, and how — ` +
    `which page, controls and steps? How does that follow the instructions ` +
    `above? What have you finished since your last check-in (or since the ` +
    `task began, if this is the first) — only what the page confirmed? What ` +
    `will you do next?]`
  );
}

const DRIFTS: Record<Drift, { what: string; fix: string }> = {
  off_task: {
    what: "working on something the instructions did not ask for",
    fix: "Drop it and go back to the next part of the task they describe.",
  },
  method: {
    what: "doing the task a different way than the instructions ask",
    fix:
      "Go back to doing it the way they ask — the site, the feature and the " +
      "result they name — even if another way looks easier.",
  },
  stuck: {
    what: "repeating the same steps without getting any further",
    fix:
      "Stop repeating what has not worked. Take a fresh snapshot and try one " +
      "other control that reaches the same result; if that fails too, record " +
      "this part as skipped with update_progress, with the reason, and move " +
      "on — or stop and tell the user what is blocking you.",
  },
  overclaims: {
    what: "reporting work the actions on the page do not show",
    fix:
      "Say something is done, and record it with update_progress, only once " +
      "the page shows it succeeded. Check the page before you report anything " +
      "as finished.",
  },
};

/** What is wrong, for the user: "doing the task a different way than the instructions ask". */
export function driftSummary(drift: Drift): string {
  return DRIFTS[drift].what;
}

/** The answer to a check-in: carry on, or what is wrong and how to get back. Null drift with no verdict means Jev could not say. */
export function feedback(drift: Drift | null, judged: boolean): string {
  if (!judged) return `${FEEDBACK_PREFIX} carry on with the instructions above.]`;
  if (!drift) {
    return (
      `${FEEDBACK_PREFIX} on course — carry on. Record anything finished or ` +
      `skipped that is not recorded yet with update_progress.]`
    );
  }
  const d = DRIFTS[drift];
  return (
    `${FEEDBACK_PREFIX} you are off course — ${d.what}. ${d.fix} Follow the ` +
    `instructions in the check-in above as written. If the way they ask for ` +
    `does not work, try another control that reaches the same result; never ` +
    `switch to a different site, feature or outcome the user did not ask for. ` +
    `If nothing works, say so and stop.]`
  );
}

/** For the brief of a round that follows a check-in that found the last one off course. */
export function briefNote(drift: Drift): string {
  const d = DRIFTS[drift];
  return (
    `At its last check-in, the supervisor found the last round ${d.what}. ${d.fix} ` +
    `Follow the instructions above as written, not the way the last round went about it.`
  );
}

// ── the action trail ────────────────────────────────────────────────────────
//
// What Jev judges the model on besides its own word: each call with its
// target and arguments, and how the page answered. A bare "click e104" says
// nothing, so a ref is named from the snapshot the model acted on — "click
// button "None"" followed by "Rule updated" is what gave the Sheets run away.

/** How many of the latest actions a check-in shows Jev. */
export const TRAIL_LENGTH = 20;

const SHOWN_CHANGES = 6;
const CHANGE_LINE_CAP = 90;
const OUTCOME_CAP = 320;

function clip(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

// Said by describeAction in the call itself, or not worth Jev's attention.
const UNSHOWN_ARGS = new Set(["ref", "why", "destructive"]);

/** How the page answered a call, in a line: an error, the page it landed on, or the first few changes. */
function outcome(out: ToolResult | Error): string {
  if (out instanceof Error) return clip(`Error: ${out.message}`, 200);
  const text =
    typeof out === "string"
      ? out
      : out.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n");
  if (text.startsWith("Error:")) return clip(text.split("\n")[0], 200);

  const lines = text.split("\n");
  // A short result like {"typed":7,"submitted":false} says something; a
  // click's coordinates do not.
  const head =
    lines[0].startsWith("{") && lines[0].length < 80 && !/"(clickedAt|hoveredAt)"/.test(lines[0])
      ? `${lines[0]} `
      : "";

  const page = lines.indexOf("The page now:");
  if (page !== -1) return clip(`${head}page: ${(lines[page + 1] ?? "").replace(/^# /, "")}`, 200);
  // A snapshot or read_page result is the page itself, title first.
  if (lines[0].startsWith("# ")) return clip(`page: ${lines[0].slice(2)}`, 200);
  if (/No visible change on the page/.test(text)) return `${head}no visible change`;

  const changes = text.match(/The page now — \d+ changes?[^\n]*\n([\s\S]*)/);
  if (changes) {
    const shown = changes[1]
      .split("\n")
      .filter((l) => /^[+~-] /.test(l) && /"|\[e\d+\]/.test(l) && l.length <= CHANGE_LINE_CAP)
      .slice(0, SHOWN_CHANGES);
    return clip(`${head}${shown.join(" · ")}`, OUTCOME_CAP);
  }
  return clip(head || lines[0], 200);
}

/**
 * One call in the trail, e.g.
 *   click button "None" — "Apply orange" → + StaticText "Rule updated" · …
 * `label` is how the call's ref read in the snapshot it was made against.
 */
export function describeAction(
  name: string,
  input: unknown,
  label: string | null,
  out: ToolResult | Error,
): string {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const ref = typeof args.ref === "string" ? args.ref : null;
  const shown = Object.entries(args)
    .filter(([k]) => !UNSHOWN_ARGS.has(k))
    .map(([k, v]) => `${k}=${clip(JSON.stringify(v) ?? "", 80)}`);
  const why = typeof args.why === "string" && args.why.trim() ? ` — "${clip(args.why, 100)}"` : "";
  const call = [name, ref && (label ?? ref), ...shown].filter(Boolean).join(" ");
  return `${clip(`${call}${why}`, 220)} → ${outcome(out)}`;
}
