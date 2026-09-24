// Tool surface.
//
// Semantic tools keyed by accessibility refs, not raw coordinates. The model
// never sees a pixel position, so it cannot invent one; resolution from ref to
// coordinates happens in the extension against the live box model.

import type OpenAI from "openai";
import {
  call,
  emit,
  requestAnswers,
  requestApproval,
  type AskQuestion,
} from "./bridge.js";
import {
  checkGrounded,
  jevEnabled,
  judgeAction,
  judgeJobFit,
  judgeMemoryWorth,
  judgeOutcome,
  type JobFit,
  LIKELY_AT,
  rankSources,
  type Source,
  type UserContext,
} from "./jev.js";
import {
  allMemories,
  memoriesBefore,
  memoryId,
  saveMemory,
  searchMemories,
} from "./memory.js";
import { recordProgress } from "./progress.js";
import type { ApprovalMode } from "./session.js";

// Provider-neutral content parts. Ollama's OpenAI-compatible endpoint accepts
// these inside tool-result messages, which is what the vision escalation in
// `snapshot` relies on. (OpenAI's own types declare tool results as text-only,
// so agent.ts casts at the boundary.)
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ToolResult = string | ContentPart[];

// Kept in the flat JSON-Schema shape and mapped to the wire format once, at the
// bottom of this file.
export type ToolDef = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
};

/**
 * Which chat a tool call belongs to, that chat's own approval setting, and
 * the run's abort signal — every call() below passes it through so Cancel
 * interrupts whatever is in flight immediately instead of waiting out that
 * op's own timeout. `userMessages`, `answers` and `chatStartedAt` are what
 * the user has said — what form entries are checked against (see
 * groundingGate) and what Jev's judgments are made in the light of.
 * `answers` is the chat's own list: ask_user adds to it.
 */
export type ToolCtx = {
  chatId: string;
  approvalMode: ApprovalMode;
  signal: AbortSignal;
  userMessages: string[];
  answers: string[];
  chatStartedAt: string;
  /** Whether the model can take images. When it cannot, no screenshot is taken for it. */
  seesImages: boolean;
};

/** Everything the user has said in this chat: what they typed, then what they answered. */
function userSaid(ctx: ToolCtx): string[] {
  return [...ctx.userMessages, ...ctx.answers];
}

/** The backdrop for Jev's judgments: what the user said here, and every saved memory. */
async function userContext(ctx: ToolCtx): Promise<UserContext> {
  const memories = await allMemories();
  return {
    instructions: userSaid(ctx),
    memories: memories.map((m) => `${m.title}: ${m.content}`),
  };
}

export type BrowserTool = {
  def: ToolDef;
  run: (input: any, ctx: ToolCtx) => Promise<ToolResult>;
};

// In "Only submits" mode, a submit goes ahead without the prompt when Jev
// puts the chance that it is an irreversible action the user never asked for
// below this. Calibrated on the user's job task: submitting or confirming an
// application scored 0.02–0.04, and pressing Enter in a search box
// 0.04–0.07; paying, withdrawing, messaging a recruiter, accepting an offer,
// deleting a résumé, subscribing, and changing the account email scored
// 0.96–1.00. The gap is wide, so the line sits well clear of both.
const AUTO_APPROVE_BELOW = 0.2;

async function gate(kind: "click" | "submit", what: string, ctx: ToolCtx): Promise<string | null> {
  // Judged on every gated action; logged even when nothing waits on it.
  const verdict = jevEnabled
    ? judgeAction(kind, what, await userContext(ctx), ctx.chatId, ctx.signal)
    : null;

  const needed =
    ctx.approvalMode === "all" ||
    (ctx.approvalMode === "submits" && kind === "submit");
  if (!needed) return null;

  // "All actions" mode keeps asking about everything — that is what it is
  // for. A failed or unsure verdict falls through to asking, too.
  if (ctx.approvalMode === "submits" && verdict) {
    const v = await verdict;
    if (v && v.p.unsanctioned < AUTO_APPROVE_BELOW) {
      emit(
        "auto-approved",
        ctx.chatId,
        `${what} · Jev: nothing risky you did not ask for (${v.p.unsanctioned.toFixed(2)})`,
      );
      return null;
    }
  }

  emit("awaiting-approval", ctx.chatId, what);
  const outcome = await requestApproval(what, ctx.chatId, undefined, ctx.signal);
  if (outcome === "approved") return null;
  if (outcome === "denied") {
    return "User declined this action. Do not retry it; choose a different approach or ask the user what to do.";
  }
  // Nobody answered — the popup was closed, or the user walked away. This is
  // not a refusal, and must not be reported to them as one.
  return (
    "This action needs the user's approval and nobody answered the prompt " +
    "(the extension popup was most likely closed). Nothing was done and the " +
    "page is unchanged. Stop here and tell the user that this step is waiting " +
    "on their approval, naming the action, so they can reopen the popup and " +
    "ask you to continue. Do not retry it and do not attempt a workaround."
  );
}

// ── job fit ─────────────────────────────────────────────────────────────────
//
// Whether a job is worth applying to is Jev's call, made against the user's
// instructions and memories — left to itself, the model kept applying to
// roles well outside the user's experience. The model asks with
// check_job_fit; a click that starts an application asks anyway when the
// job it is on has not been checked.

// The latest verdict per chat, and the page it was made on.
const lastJobFit = new Map<string, { url: string | null; at: number; fit: JobFit }>();
// A verdict still covers an "Apply" click on the same page within this long.
const JOB_FIT_FRESH_MS = 2 * 60_000;
const JOB_PAGE_CAP = 12_000;

/** The URL of the latest snapshot — its second header line. */
function snapshotUrl(chatId: string): string | null {
  const line = (lastSnapshot.get(chatId) ?? "").split("\n")[1] ?? "";
  return line.startsWith("# ") ? line.slice(2).trim() : null;
}

/** Judge the job whose details are open, record a skip, and remember the verdict for the apply click. */
async function assessJob(
  which: string,
  ctx: ToolCtx,
): Promise<{ fit: JobFit; recorded: boolean } | null> {
  const page = await call<{ text: string }>(
    "read_page", ctx.chatId, { maxChars: JOB_PAGE_CAP }, undefined, ctx.signal,
  );
  const fit = await judgeJobFit({ which, page: page.text }, await userContext(ctx), ctx.chatId, ctx.signal);
  if (!fit) return null;
  lastJobFit.set(ctx.chatId, { url: snapshotUrl(ctx.chatId), at: Date.now(), fit });
  emit(
    "job-fit",
    ctx.chatId,
    fit.apply
      ? `APPLY (${fit.p.toFixed(2)}) — ${which}`
      : `SKIP (${(1 - fit.p).toFixed(2)}) — ${which}: ${fit.reason}`,
  );
  const recorded = fit.apply
    ? false
    : (await recordProgress(ctx.chatId, { done: [], skipped: [`${which} — ${fit.reason}`], note: "" })) !== null;
  return { fit, recorded };
}

// A click that starts a job application: "Apply now", "Easy Apply", "Quick
// apply", "Apply on company site", or a bare "Apply" the model says is for a
// job. Not "Apply filters", and not the final submit, which comes after.
const APPLY_BUTTON = /\b(easy|quick|1-click)\s*apply\b|\bapply\s+(now|here|online|for|to|on|with)\b|^apply$/i;
const APPLY_WHY = /\bappl(y|ying)\s+(to|for)\b/i;
const NOT_A_JOB = /\b(filters?|sort|coupon|promo|discount|voucher)\b/i;

function startsApplication(label: string, why: string): boolean {
  if (NOT_A_JOB.test(`${label} ${why}`)) return false;
  return APPLY_BUTTON.test(label.trim()) || APPLY_WHY.test(why);
}

/**
 * The job an "Apply" button belongs to: the nearest heading above it in the
 * latest snapshot — on a job board, the title over the details. The model's
 * own description of the click is the fallback; it often just says "this job".
 */
function jobAbove(chatId: string, ref: string): string | null {
  const lines = (lastSnapshot.get(chatId) ?? "").split("\n").map((l) => l.trim());
  const at = lines.findIndex((l) => l.startsWith(`[${ref}] `));
  for (let i = at - 1; i >= Math.max(0, at - 40); i--) {
    const m = lines[i].match(/^heading "((?:[^"\\]|\\.)*)"/);
    if (m) return m[1];
  }
  return null;
}

/** Null when the application may start; otherwise why not, as the tool result. */
async function jobFitGate(ref: string, label: string, why: string, ctx: ToolCtx): Promise<string | null> {
  if (!jevEnabled) return null;
  const last = lastJobFit.get(ctx.chatId);
  const fresh =
    last && Date.now() - last.at < JOB_FIT_FRESH_MS && last.url === snapshotUrl(ctx.chatId);
  const which = jobAbove(ctx.chatId, ref) ?? (why || label);
  const fit = fresh ? last.fit : (await assessJob(which, ctx))?.fit;
  // No verdict (the check failed): the decision stays with the model.
  if (!fit || fit.apply) return null;
  return (
    `Not applying: Jev judged this job not worth applying to — ${fit.reason} ` +
    `(p(apply)=${fit.p.toFixed(2)}). It is already recorded as skipped — do not ` +
    `add it to update_progress. Move on to the next listing; do not try to ` +
    `apply to it another way.`
  );
}

// ── grounding ───────────────────────────────────────────────────────────────
//
// Nothing about the user may be entered into a page unless the user said it
// — in this chat or in a memory saved before it. Models fill a required
// field they have no answer for with something plausible (an employer's own
// office address, entered as the user's home address), so every form entry
// is checked by Jev first. Only when a key is configured; with one, a failed
// check blocks rather than lets the entry through.

// The latest snapshot per chat, so a ref can be traced back to its field's
// label and the question above it.
const lastSnapshot = new Map<string, string>();

// Clicking one of these picks an answer, the same as typing one.
const CHOICE_ROLES = new Set([
  "radio", "checkbox", "option", "menuitemradio", "menuitemcheckbox", "switch",
]);
const CONTAINER_ROLES = /^\[e\d+\] (combobox|listbox|radiogroup|group|menu)\b/;

type RefLine = { role: string; label: string; checked: boolean; field: string };

/** A ref's line in the latest snapshot, plus the lines leading up to it (the label, the question). */
function refLine(chatId: string, ref: string): RefLine | null {
  const lines = (lastSnapshot.get(chatId) ?? "").split("\n").map((l) => l.trim());
  const i = lines.findIndex((l) => l.startsWith(`[${ref}] `));
  if (i === -1) return null;
  const m = lines[i].match(/^\[e\d+\] (\S+)(?: "((?:[^"\\]|\\.)*)")?/);
  const window = lines.slice(Math.max(0, i - 6), i + 1);
  // A long option list pushes its question out of the window above; the
  // dropdown it belongs to says what it is for.
  if (!window.some((l) => CONTAINER_ROLES.test(l))) {
    for (let j = i - 7; j >= Math.max(0, i - 60); j--) {
      if (CONTAINER_ROLES.test(lines[j])) {
        window.unshift(lines[j], "…");
        break;
      }
    }
  }
  return {
    role: m?.[1] ?? "",
    label: m?.[2] ?? "",
    checked: / checked=true\b/.test(lines[i]),
    field: window.join("\n"),
  };
}

/** How a ref reads in the latest snapshot — `button "Apply now"` — or null when it is not in it. */
export function refLabel(chatId: string, ref: string): string | null {
  const line = refLine(chatId, ref);
  if (!line) return null;
  return line.label ? `${line.role} "${line.label}"` : line.role;
}

/** Null when `value` may go into `ref` (or, with no ref, the focused element); otherwise why not. */
function groundingGate(ref: string | undefined, value: string, ctx: ToolCtx): Promise<string | null> {
  const field = !ref
    ? "(the element that has keyboard focus — no ref was given)"
    : refLine(ctx.chatId, ref)?.field ?? `(${ref} is not in the latest snapshot)`;
  return checkEntry(field, value, ref ?? "focused element", ctx);
}

/**
 * Null when `value` may go into the place `field` describes; otherwise why
 * not, as the tool result. `where` names it in the popup log. Values with no
 * letters or digits say nothing and are not checked.
 */
async function checkEntry(field: string, value: string, where: string, ctx: ToolCtx): Promise<string | null> {
  if (!jevEnabled || !/[\p{L}\p{N}]/u.test(value)) return null;
  const verdict = await checkGrounded(
    { field, value },
    {
      user_messages: userSaid(ctx),
      saved_memories: (await memoriesBefore(ctx.chatStartedAt)).map((m) => `${m.title}: ${m.content}`),
    },
    ctx.chatId,
    ctx.signal,
  );
  if (verdict?.ok) return null;
  emit("blocked", ctx.chatId, `${where} ⇐ ${preview(value)} — not in your messages or memories`);
  if (!verdict) {
    return (
      `Not entered: ${JSON.stringify(value)} could not be checked against the ` +
      `user's messages and memories (the check failed). Try once more; if it ` +
      `keeps failing, stop and tell the user.`
    );
  }
  return (
    `Not entered: nothing in the user's messages or saved memories backs ` +
    `entering ${JSON.stringify(value)} here. Do not guess, and never use ` +
    `details from the page or the job ad (such as the employer's address) ` +
    `as the user's own. If the field is optional, leave it blank. If it is ` +
    `required, stop and ask the user for it — and once they answer, save it ` +
    `with remember so it is on file next time.`
  );
}

const str = (description: string) => ({ type: "string" as const, description });

/**
 * The page after an action, as the extension reports it: on the same page,
 * only what changed (refs are stable, so a changed line is the same element);
 * after a navigation or a big change, the whole page. `snapshot` is always
 * the full text, kept for refLine and jobAbove — it never goes to the model.
 */
type PageReport = {
  url?: string;
  title?: string;
  full?: boolean;
  changes?: number;
  text?: string;
  snapshot?: string;
  weak?: string | null;
  interactiveCount?: number;
  error?: string;
};

/** What an action did to the page, for the model — and the full page for lastSnapshot. */
async function pageReport(page: PageReport | undefined, ctx: ToolCtx): Promise<ContentPart[]> {
  if (!page) return [];
  if (page.error) {
    return [{ type: "text", text: `(The page could not be read afterwards: ${page.error} Take a snapshot.)` }];
  }
  if (page.snapshot) lastSnapshot.set(ctx.chatId, page.snapshot);
  if (!page.full) {
    return [{
      type: "text",
      text: page.changes
        ? `The page now — ${page.changes} change${page.changes === 1 ? "" : "s"} ` +
          `(+ appeared, ~ changed, - gone; every other ref still stands):\n${page.text}`
        : "No visible change on the page.",
    }];
  }
  emit("snapshot", ctx.chatId, `${page.interactiveCount ?? 0} interactive elements`);
  return withVision([{ type: "text", text: `The page now:\n${page.text}` }], page.weak ?? null, ctx);
}

/** A tool result: `head`, then the page report. Plain text unless a screenshot came with it. */
async function report(head: string, page: PageReport | undefined, ctx: ToolCtx): Promise<ToolResult> {
  const parts = await pageReport(page, ctx);
  if (parts.every((p) => p.type === "text")) {
    return [head, ...parts.map((p) => (p as { text: string }).text)].filter(Boolean).join("\n\n");
  }
  return [{ type: "text", text: head }, ...parts];
}

/** An op's result with its page report split off: `rest` is echoed as JSON, `page` rendered. */
function splitPage(r: any): { rest: Record<string, unknown>; page: PageReport | undefined } {
  const { page, ...rest } = r ?? {};
  return { rest, page };
}

/**
 * Render an input-op result, calling out a tab switch loudly when one
 * happened.
 *
 * Without this the model has no evidence that a click worked: the tab it was
 * looking at is unchanged, the button is still in the next snapshot, and it
 * clicks again. Saying so in the tool result is what breaks that loop.
 */
async function describeAction(what: string, r: any, ctx: ToolCtx, extra = ""): Promise<ToolResult> {
  const { rest, page } = splitPage(r);
  // The change list, not the whole page: enough to tell whether it worked.
  judgeOutcome(
    what,
    { ...rest, page: page && (page.full ? `now on ${page.url}` : (page.text ?? "").slice(0, 1500)) },
    ctx.chatId,
  );

  const missed = r?.newTabNotFollowed;
  if (missed) {
    return report(
      `${JSON.stringify(rest)}${extra}\n\n` +
        `The action SUCCEEDED and opened a new tab (${missed.url || "no URL yet"}), ` +
        `but that tab could not be taken over: ${missed.reason} You are still ` +
        `controlling the previous tab. Do not repeat the action — use list_tabs ` +
        `and activate_tab to try the new tab again.`,
      page,
      ctx,
    );
  }
  const moved = r?.followedNewTab;
  if (!moved) return report(`${JSON.stringify(rest)}${extra}`, page, ctx);
  emit("follow-tab", ctx.chatId, moved.url ?? `tab ${moved.tabId}`);
  return report(
    `${JSON.stringify(rest)}${extra}\n\n` +
      `That action opened a new tab and you are now controlling it: ` +
      `${moved.title || "(untitled)"} — ${moved.url || "(url unknown)"}\n` +
      `The action SUCCEEDED. Do not repeat it. Refs from the previous tab do ` +
      `not work here; the new tab's page is below. Use list_tabs and ` +
      `activate_tab if you need to return to the old tab.`,
    page,
    ctx,
  );
}

/** A navigation-style op's result: its fields as JSON, then the page. */
async function withPage(r: any, ctx: ToolCtx): Promise<ToolResult> {
  const { rest, page } = splitPage(r);
  return report(JSON.stringify(rest), page, ctx);
}

/**
 * Every capture path produces JPEG, and JPEG base64 always opens with "/9j/"
 * (the FF D8 FF marker). Anything else is an empty or failed capture — most
 * often a background tab that was not painting.
 *
 * It must not reach the model. Ollama answers an invalid image with a 400
 * that ends the whole run, and in a sticky chat the bad image would sit in
 * history and be resent, failing again, on every retry.
 */
function jpegPart(data: unknown): ContentPart | null {
  if (typeof data !== "string" || !data.startsWith("/9j/")) return null;
  return { type: "image_url", image_url: { url: `data:image/jpeg;base64,${data}` } };
}

const EMPTY_CAPTURE =
  "the capture came back empty — the tab is most likely in the background " +
  "and not painting. Use snapshot instead; it does not need the tab visible.";

// ── perception ──────────────────────────────────────────────────────────────

/**
 * Adaptive escalation. The model systematically under-requests vision, so
 * the harness decides: icon-only UIs and canvas content are exactly where an
 * accessibility tree goes blind. `blocks` hold a whole page's snapshot.
 */
async function withVision(blocks: ContentPart[], weak: string | null, ctx: ToolCtx): Promise<ContentPart[]> {
  if (!weak) return blocks;
  if (!ctx.seesImages) {
    return [...blocks, {
      type: "text",
      text:
        `(The snapshot above is unreliable here (${weak}), and this model ` +
        `cannot see screenshots. If the page is still loading, call ` +
        `wait_for_idle and snapshot again; read_page shows its text.)`,
    }];
  }
  try {
    const shot = await call<{ data: string; badged: number }>("badged_screenshot", ctx.chatId, {}, undefined, ctx.signal);
    const image = jpegPart(shot.data);
    if (!image) throw new Error(EMPTY_CAPTURE);
    emit("vision", ctx.chatId, `escalated (${weak}), ${shot.badged} badges`);
    return [
      ...blocks,
      {
        type: "text",
        text:
          `The snapshot above is unreliable here (${weak}). A screenshot ` +
          `follows with red badge numbers drawn on interactive elements. Badge ` +
          `N corresponds to ref "eN" — pass the ref, not the number, to tools.`,
      },
      image,
    ];
  } catch (err) {
    return [...blocks, { type: "text", text: `(vision escalation failed: ${String(err)})` }];
  }
}

const snapshot: BrowserTool = {
  def: {
    name: "snapshot",
    description:
      "Capture the accessibility tree of the current tab as a list of elements " +
      "with [eN] refs. This is your primary way to see the page. Call it before " +
      "interacting with a page you have not seen. You do not need it after an " +
      "action: every action's result shows what it changed, or the whole page " +
      "after a navigation. A ref stays the same until the page navigates. If " +
      "the page is icon-heavy, canvas-based, or otherwise hard to read as text, " +
      "a badged screenshot is attached automatically and its red badge numbers " +
      "match the [eN] refs.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  async run(_input, ctx) {
    const snap = await call<{
      text: string; weak: string | null; interactiveCount: number;
    }>("snapshot", ctx.chatId, {}, undefined, ctx.signal);
    emit("snapshot", ctx.chatId, `${snap.interactiveCount} interactive elements`);
    lastSnapshot.set(ctx.chatId, snap.text);
    return withVision([{ type: "text", text: snap.text }], snap.weak, ctx);
  },
};

const screenshot: BrowserTool = {
  def: {
    name: "screenshot",
    description:
      "Capture a badged screenshot of the viewport on demand. Use only when the " +
      "snapshot is genuinely insufficient — visual layout questions, charts, " +
      "images, or verifying something rendered as expected. Prefer snapshot: it " +
      "is far cheaper and gives exact element identity.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  async run(_input, ctx) {
    if (!ctx.seesImages) {
      throw new Error(
        "Screenshot not taken: the current model cannot see images. Use " +
          "snapshot to find controls, or read_page to read the page's text.",
      );
    }
    const shot = await call<{ data: string; badged: number }>("badged_screenshot", ctx.chatId, {}, undefined, ctx.signal);
    const image = jpegPart(shot.data);
    // Thrown, so it reaches the model as an ordinary tool error it can act on.
    if (!image) throw new Error(`Screenshot failed: ${EMPTY_CAPTURE}`);
    emit("screenshot", ctx.chatId, `${shot.badged} badges`);
    return [
      { type: "text", text: "Badge N corresponds to ref \"eN\"." },
      image,
    ];
  },
};

const readPage: BrowserTool = {
  def: {
    name: "read_page",
    description:
      "Extract the readable text of the page as markdown-ish prose. Use for " +
      "reading and summarizing content, not for finding elements to click.",
    input_schema: {
      type: "object",
      properties: {
        maxChars: { type: "integer", description: "Cap on returned characters (default 12000)" },
      },
      required: [],
    },
  },
  async run({ maxChars }, ctx) {
    const r = await call<{ text: string }>("read_page", ctx.chatId, { maxChars }, undefined, ctx.signal);
    emit("read", ctx.chatId, `${r.text.length} chars`);
    return r.text || "(no readable text found)";
  },
};

// ── interaction ─────────────────────────────────────────────────────────────

const click: BrowserTool = {
  def: {
    name: "click",
    description:
      "Click an element by its ref. The result shows what the click changed on " +
      "the page, or the whole page if it navigated.",
    input_schema: {
      type: "object",
      properties: {
        ref: str('Element ref, e.g. "e28"'),
        why: str("What you expect this click to do. Shown to the user."),
        destructive: {
          type: "boolean",
          description:
            "Set true for anything hard to undo: purchasing, sending, posting, " +
            "deleting, or confirming an irreversible change. Triggers user approval.",
        },
      },
      required: ["ref", "why"],
    },
  },
  async run({ ref, why, destructive }, ctx) {
    const what = `Click ${ref} — ${why}`;
    // Ticking a box or picking an option answers a question as much as
    // typing does. Unticking one takes an answer back, so it is not checked.
    const target = refLine(ctx.chatId, ref);
    if (startsApplication(target?.label ?? "", String(why ?? ""))) {
      const skip = await jobFitGate(ref, target?.label ?? "", String(why ?? ""), ctx);
      if (skip) return skip;
    }
    if (target && CHOICE_ROLES.has(target.role) && !target.checked) {
      const blocked = await groundingGate(ref, target.label, ctx);
      if (blocked) return blocked;
    }
    const denied = await gate(destructive ? "submit" : "click", what, ctx);
    if (denied) return denied;
    emit("click", ctx.chatId, `${ref} — ${why}`);
    const r = await call("click", ctx.chatId, { ref }, undefined, ctx.signal);
    return describeAction(what, r, ctx);
  },
};

/** A ref from the model, or undefined for "whatever has focus". */
function optionalRef(ref: unknown): string | undefined {
  return typeof ref === "string" && ref.trim() ? ref.trim() : undefined;
}

const type: BrowserTool = {
  def: {
    name: "type",
    description:
      "Type into a text field key by key. Pass ref to click the field first: " +
      "whatever it already holds is deleted, so it ends up holding exactly " +
      "your text. Omit ref to type into whatever already has keyboard focus, " +
      "at the caret, keeping what is there. Set submit=true to press Enter " +
      "afterwards.",
    input_schema: {
      type: "object",
      properties: {
        ref: str('Text field ref, e.g. "e12". Omit to type into the focused element.'),
        text: str("Text to type"),
        submit: { type: "boolean", description: "Press Enter after typing" },
      },
      required: ["text"],
    },
  },
  async run({ ref: rawRef, text, submit }, ctx) {
    const ref = optionalRef(rawRef);
    const where = ref ?? "the focused element";
    const what = submit ? `Type into ${where} and submit: "${text}"` : `Type into ${where}: "${text}"`;
    const blocked = await groundingGate(ref, String(text ?? ""), ctx);
    if (blocked) return blocked;
    if (submit) {
      const denied = await gate("submit", what, ctx);
      if (denied) return denied;
    }
    emit("type", ctx.chatId, `${where} ← "${text}"${submit ? " ⏎" : ""}`);
    const r = await call("type", ctx.chatId, { ref, text, submit }, undefined, ctx.signal);
    const { leftover, ...rest } = r ?? {};
    return describeAction(what, rest, ctx, leftoverNote(leftover));
  },
};

/** Short, single-line form of possibly-long text, for the popup log. */
function preview(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `"${flat.slice(0, max)}…" (${text.length} chars)` : `"${flat}"`;
}

/**
 * The field's old content, when some of it could not be deleted before the
 * new text went in — the result then holds both.
 */
function leftoverNote(leftover: unknown): string {
  if (typeof leftover !== "string" || !leftover) return "";
  return (
    `\n\nThe field's old content could not all be deleted first: it still held ` +
    `${JSON.stringify(leftover.slice(0, 200))} when your text went in, so it ` +
    `now holds both. Select it with press_key Mod+a, press Backspace, and fill ` +
    `the field again.`
  );
}

/**
 * Did the field actually take the pasted text?
 *
 * Pasting fails silently on some fields — ones that only listen for key
 * events, or that reject input they did not format themselves — and nothing
 * else in the tool result would show it. Compared on letters and digits only,
 * so a masked input that turns 5551234567 into (555) 123-4567 still counts as
 * accepted.
 */
function pasteVerdict(value: string | null, text: string): string {
  // Rich-text editors and password fields do not expose a value to read.
  if (value === null) return "";
  const norm = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const want = norm(text);
  const got = norm(value);
  if (!want || got.includes(want)) return "";
  if (!got) {
    return (
      "\n\nThe field is still EMPTY after pasting: it ignores pasted text. " +
      "Fill it with `type` instead."
    );
  }
  return (
    `\n\nThe field now reads ${JSON.stringify(value.slice(0, 200))}, which does ` +
    `not contain what you pasted. A length limit may have cut it short, or the ` +
    `field rejected the formatting. Check it, and use \`type\` if it is wrong.`
  );
}

const paste: BrowserTool = {
  def: {
    name: "paste",
    description:
      "Put text into a field by ref all at once, the way pasting does, instead of " +
      "typing it key by key. Prefer this when filling in forms: names, emails, " +
      "addresses, short answers, cover letters and any long text. It is fast " +
      "and exact. Use `type` instead for fields that respond to each keystroke: " +
      "search boxes that show suggestions as you type, codes split into one box " +
      "per character, and masked inputs such as phone numbers, dates and card " +
      "numbers. The result says if the field did not accept the text; when it " +
      "does, retry that field with `type`. With a ref, whatever the field " +
      "already holds is deleted first, so it ends up holding exactly your " +
      "text. Omit ref to paste into whatever already has keyboard focus, at " +
      "the caret. Set submit=true to press Enter afterwards.",
    input_schema: {
      type: "object",
      properties: {
        ref: str('Text field ref, e.g. "e12". Omit to paste into the focused element.'),
        text: str("Text to paste"),
        submit: { type: "boolean", description: "Press Enter after pasting" },
      },
      required: ["text"],
    },
  },
  async run({ ref: rawRef, text, submit }, ctx) {
    const ref = optionalRef(rawRef);
    const where = ref ?? "the focused element";
    const what = submit
      ? `Paste into ${where} and submit: ${preview(text, 200)}`
      : `Paste into ${where}: ${preview(text, 200)}`;
    const blocked = await groundingGate(ref, String(text ?? ""), ctx);
    if (blocked) return blocked;
    if (submit) {
      const denied = await gate("submit", what, ctx);
      if (denied) return denied;
    }
    emit("paste", ctx.chatId, `${where} ⇐ ${preview(text)}${submit ? " ⏎" : ""}`);
    const r = await call("paste", ctx.chatId, { ref, text, submit }, undefined, ctx.signal);
    // The read-back value is only for the verdict. Echoing a whole cover
    // letter back into the context would cost its length again for nothing.
    const { value, leftover, ...rest } = r ?? {};
    return describeAction(
      what,
      rest,
      ctx,
      leftoverNote(leftover) || pasteVerdict(value ?? null, text),
    );
  },
};

const hover: BrowserTool = {
  def: {
    name: "hover",
    description:
      "Move the pointer over an element. Use to reveal hover menus and tooltips; " +
      "the result shows what appeared.",
    input_schema: {
      type: "object",
      properties: { ref: str("Element ref") },
      required: ["ref"],
    },
  },
  async run({ ref }, ctx) {
    emit("hover", ctx.chatId, ref);
    return withPage(await call("hover", ctx.chatId, { ref }, undefined, ctx.signal), ctx);
  },
};

const selectOption: BrowserTool = {
  def: {
    name: "select_option",
    description: "Choose a value in a native <select> dropdown.",
    input_schema: {
      type: "object",
      properties: {
        ref: str("Select element ref"),
        value: str("Visible label of the option to choose"),
      },
      required: ["ref", "value"],
    },
  },
  async run({ ref, value }, ctx) {
    const blocked = await groundingGate(ref, String(value ?? ""), ctx);
    if (blocked) return blocked;
    emit("select", ctx.chatId, `${ref} ← ${value}`);
    return withPage(await call("select_option", ctx.chatId, { ref, value }, undefined, ctx.signal), ctx);
  },
};

const pressKey: BrowserTool = {
  def: {
    name: "press_key",
    description:
      "Press a key or keyboard shortcut on whatever has focus. A named key — " +
      "Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp/Down/Left/Right, " +
      "Home, End, PageUp, PageDown, F1–F12 — or a single character, with " +
      'optional modifiers: "Shift+Tab", "Mod+z" (Mod is ⌘ on Mac, Ctrl ' +
      'elsewhere), "Alt+Enter", "Mod+b", "Control+Home". Copy, cut and paste ' +
      "shortcuts are refused: they would use the user's own clipboard.",
    input_schema: {
      type: "object",
      properties: {
        key: str('Key or combo, e.g. "Enter", "Shift+Tab", "Mod+z"'),
        repeat: { type: "integer", description: "Press it this many times, e.g. ArrowDown 5 times (default 1, at most 50)" },
      },
      required: ["key"],
    },
  },
  async run({ key, repeat }, ctx) {
    const times = Number(repeat) > 1 ? ` ×${Math.min(Math.floor(Number(repeat)), 50)}` : "";
    emit("key", ctx.chatId, `${key}${times}`);
    const r = await call("press_key", ctx.chatId, { key, repeat }, undefined, ctx.signal);
    return describeAction(`Press ${key}${times}`, r, ctx);
  },
};

const scroll: BrowserTool = {
  def: {
    name: "scroll",
    description:
      "Scroll the page. Snapshots only cover loaded content, so scroll to load " +
      "more of a long list or feed; the result shows what appeared.",
    input_schema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"] },
        amount: { type: "integer", description: "Pixels to scroll (default 600)" },
      },
      required: ["direction"],
    },
  },
  async run({ direction, amount }, ctx) {
    emit("scroll", ctx.chatId, `${direction} ${amount ?? 600}px`);
    return withPage(await call("scroll", ctx.chatId, { direction, amount }, undefined, ctx.signal), ctx);
  },
};

// ── Google Sheets ───────────────────────────────────────────────────────────
//
// Sheets draws its grid on a canvas, so no cell is ever in a snapshot and no
// ref points at one. These reach the cells another way (see the extension's
// sheets.js): the sheet's own CSV export to read, the Name box to move, and
// keystrokes to write — a whole block per call instead of several steps per
// cell.

const MAX_SHEET_CELLS = 400;

/** rows as a grid of strings, or null when it is not a list of lists. Models sometimes send JSON as a string. */
function cellRows(v: unknown): string[][] | null {
  let rows = v;
  if (typeof rows === "string") {
    try {
      rows = JSON.parse(rows);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(rows) || rows.length === 0 || !rows.every(Array.isArray)) return null;
  return rows.map((r: unknown[]) => r.map((c) => (c === null || c === undefined ? "" : String(c))));
}

const sheetRead: BrowserTool = {
  def: {
    name: "sheet_read",
    description:
      "Read cells from the Google Sheet open in the current tab, as a table " +
      "with column letters and row numbers. Sheets draws its grid on a canvas, " +
      "so cells never appear in a snapshot — this is how to see them. Omit " +
      "range to read from A1 to the last filled cell (at most 100 rows and 26 columns).",
    input_schema: {
      type: "object",
      properties: {
        range: str('A1 range, e.g. "A1:F50" or "Sheet2!A1:C10". Omit to read from A1.'),
      },
      required: [],
    },
  },
  async run({ range }, ctx) {
    const r = await call<{ text: string }>(
      "sheet_read", ctx.chatId, { range: optionalRef(range) }, 60_000, ctx.signal,
    );
    emit("read", ctx.chatId, `sheet ${optionalRef(range) ?? "from A1"}`);
    return r.text;
  },
};

type Mismatch = { cell: string; wrote: string; shows: string };

const sheetWrite: BrowserTool = {
  def: {
    name: "sheet_write",
    description:
      "Enter a block of values into the Google Sheet open in the current tab — " +
      "one call for a whole table, never one call per cell. rows is a list of " +
      "rows, each a list of cell values, filled rightwards and downwards from " +
      "start. A value starting with = goes in as a formula. An empty string " +
      "leaves that cell as it is (to clear cells, sheet_select them and " +
      "press_key Delete). Afterwards the block is read back, and any cell that " +
      `does not show what was written is listed. At most ${MAX_SHEET_CELLS} cells per call.`,
    input_schema: {
      type: "object",
      properties: {
        start: str('Top-left cell of the block, e.g. "A1" or "Sheet2!B3"'),
        rows: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
          description: 'The values, row by row, e.g. [["Name", "Price"], ["Apple", "1.20"]]',
        },
      },
      required: ["start", "rows"],
    },
  },
  async run({ start, rows }, ctx) {
    const grid = cellRows(rows);
    if (!grid) {
      return 'Pass rows as a list of rows, each a list of cell values, e.g. rows: [["Name", "Price"], ["Apple", "1.20"]].';
    }
    const cells = grid.reduce((n, r) => n + r.length, 0);
    if (cells > MAX_SHEET_CELLS) {
      return (
        `That is ${cells} cells; sheet_write takes at most ${MAX_SHEET_CELLS} per call. ` +
        `Split it into blocks of rows and write each block with its own start cell.`
      );
    }
    const at = String(start ?? "").trim();
    const filled = grid.reduce((n, r) => n + r.filter((c) => c !== "").length, 0);
    const what = `Write ${filled} cell${filled === 1 ? "" : "s"} into the sheet at ${at}`;
    // One check for the whole block, not one per cell: a table of prices
    // says nothing about the user and passes; a column of personal details
    // gets the same scrutiny a form field would.
    const blocked = await checkEntry(
      `Google Sheet cells starting at ${at} (tab-separated, one line per row)`,
      grid.map((r) => r.join("\t")).join("\n").slice(0, 4000),
      `sheet ${at}`,
      ctx,
    );
    if (blocked) return blocked;
    const denied = await gate("click", what, ctx);
    if (denied) return denied;

    emit("sheet", ctx.chatId, `${at} ⇐ ${grid.length} row${grid.length === 1 ? "" : "s"}, ${filled} cells`);
    const r = await call<any>(
      "sheet_write", ctx.chatId, { start: at, rows: grid },
      Math.min(20_000 + cells * 400, 300_000), ctx.signal,
    );
    const { written, range, verified, mismatches, verifyError } = r ?? {};
    let head = `Wrote ${written} cell${written === 1 ? "" : "s"} in ${range}.`;
    if (verified) {
      head += " Read back: every cell shows what was written.";
    } else if (verifyError) {
      head += ` They could not be read back to check (${verifyError}) — use sheet_read to check them.`;
    } else if ((mismatches as Mismatch[] | undefined)?.length) {
      head +=
        `\n\nRead back, these cells do not show what was written:\n` +
        (mismatches as Mismatch[])
          .map((m) => `${m.cell}: wrote ${JSON.stringify(m.wrote)}, the sheet shows ${JSON.stringify(m.shows)}`)
          .join("\n") +
        `\nSheets may have reformatted a value (a date, a number) — fine if it ` +
        `means the same — or autocompleted it from the column. Rewrite any that are wrong.`;
    }
    return report(head, splitPage(r).page, ctx);
  },
};

const sheetSelect: BrowserTool = {
  def: {
    name: "sheet_select",
    description:
      "Select a cell or range in the Google Sheet open in the current tab, " +
      'through its Name box — e.g. "A1:D1" or "Sheet2!B3". Toolbar buttons, ' +
      "menu items and press_key shortcuts then apply to the selection: Delete " +
      "clears it, Mod+b bolds it, Mod+z undoes the last change.",
    input_schema: {
      type: "object",
      properties: { range: str('Cell or range, e.g. "B3", "A1:D1", "Sheet2!A1:C10"') },
      required: ["range"],
    },
  },
  async run({ range }, ctx) {
    emit("sheet", ctx.chatId, `select ${range}`);
    const r = await call("sheet_select", ctx.chatId, { range }, undefined, ctx.signal);
    return describeAction(`Select ${range} in the sheet`, r, ctx);
  },
};

// ── navigation ──────────────────────────────────────────────────────────────

const navigate: BrowserTool = {
  def: {
    name: "navigate",
    description:
      "Navigate the current tab to an http(s) URL and wait for it to settle. " +
      "The result includes the new page.",
    input_schema: {
      type: "object",
      properties: { url: str("Absolute http(s) URL") },
      required: ["url"],
    },
  },
  async run({ url }, ctx) {
    emit("navigate", ctx.chatId, url);
    // Getting off a restricted start page, the server's response, and the
    // load itself each have their own bound in the extension; this covers
    // them end to end.
    return withPage(await call("navigate", ctx.chatId, { url }, 60_000, ctx.signal), ctx);
  },
};

const goBack: BrowserTool = {
  def: {
    name: "go_back",
    description: "Go back one entry in the tab's history. The result includes the page.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  async run(_input, ctx) {
    emit("back", ctx.chatId, "");
    return withPage(await call("go_back", ctx.chatId, {}, undefined, ctx.signal), ctx);
  },
};

const waitForIdle: BrowserTool = {
  def: {
    name: "wait_for_idle",
    description:
      "Wait for the page to finish loading and its data requests to settle. " +
      "Actions already wait for the page to settle before they return, so use " +
      "this only when a result shows the page still loading. Returns as soon " +
      "as the page is settled, with what changed meanwhile. If it times out, " +
      "carry on anyway: the page is usually usable.",
    input_schema: {
      type: "object",
      properties: {
        timeoutMs: { type: "integer", description: "Max wait in ms (default 10000, at most 30000)" },
      },
      required: [],
    },
  },
  async run({ timeoutMs }, ctx) {
    const ms = Math.min(Math.max(Number(timeoutMs) || 10_000, 1_000), 30_000);
    emit("wait", ctx.chatId, "for idle");
    // The extension answers by `ms` even when the page never settles. The
    // broker's own deadline sits past that, plus room to attach first, so it
    // hears that answer instead of timing out on its own.
    return withPage(
      await call("wait_for_idle", ctx.chatId, { timeoutMs: ms }, ms + 25_000, ctx.signal),
      ctx,
    );
  },
};

const listTabs: BrowserTool = {
  def: {
    name: "list_tabs",
    description:
      "List open tabs with their ids, titles, and URLs. openedByYou marks tabs you " +
      "opened, which are the only ones close_tab accepts; controlling marks the tab " +
      "you are driving.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  async run(_input, ctx) {
    return JSON.stringify(await call("list_tabs", ctx.chatId, {}, undefined, ctx.signal), null, 1);
  },
};

const openTab: BrowserTool = {
  def: {
    name: "open_tab",
    description:
      "Open a URL in a new tab and make it the tab you are controlling. The tab " +
      "opens in the background and is not brought to the front; the result " +
      "includes its page.",
    input_schema: {
      type: "object",
      properties: { url: str("Absolute http(s) URL") },
      required: ["url"],
    },
  },
  async run({ url }, ctx) {
    emit("open-tab", ctx.chatId, url);
    return withPage(await call("open_tab", ctx.chatId, { url }, 40_000, ctx.signal), ctx);
  },
};

const activateTab: BrowserTool = {
  def: {
    name: "activate_tab",
    description:
      "Switch to an existing tab by id and control it from now on. This changes " +
      "which tab you drive, not which tab the user is looking at — it does not " +
      "raise the tab or its window. The result includes its page.",
    input_schema: {
      type: "object",
      properties: { tabId: { type: "integer", description: "Tab id from list_tabs" } },
      required: ["tabId"],
    },
  },
  async run({ tabId }, ctx) {
    emit("activate-tab", ctx.chatId, String(tabId));
    return withPage(await call("activate_tab", ctx.chatId, { tabId }, undefined, ctx.signal), ctx);
  },
};

const closeTab: BrowserTool = {
  def: {
    name: "close_tab",
    description:
      "Close a tab you opened once you are finished with it: an application you " +
      "have submitted, a page you have read. Keep tabs open that you will come " +
      "back to, like a list of results you are working through. Only tabs you " +
      "opened can be closed — list_tabs marks them openedByYou; the user's own " +
      "tabs are refused. Omit tabId to close the tab you are controlling, and " +
      "control returns to the tab you were using before it.",
    input_schema: {
      type: "object",
      properties: {
        tabId: {
          type: "integer",
          description: "Tab id from list_tabs. Defaults to the tab you are controlling.",
        },
      },
      required: [],
    },
  },
  async run({ tabId }, ctx) {
    emit("close-tab", ctx.chatId, tabId ? `tab ${tabId}` : "current tab");
    const r = await call<any>("close_tab", ctx.chatId, { tabId }, undefined, ctx.signal);
    if (!("nowControlling" in (r ?? {}))) return `Closed tab ${r?.closed}.`;
    const now = r.nowControlling;
    return now
      ? `Closed tab ${r.closed}. You are now controlling ${now.title || "(untitled)"} — ` +
          `${now.url || "(url unknown)"}. Refs from earlier snapshots are stale, so ` +
          `take a snapshot before acting.`
      : `Closed tab ${r.closed}. You are not controlling any tab now: use list_tabs, ` +
          `then activate_tab or open_tab, before acting.`;
  },
};

// ── memory ──────────────────────────────────────────────────────────────────

const remember: BrowserTool = {
  def: {
    name: "remember",
    description:
      "Save a durable fact about the user for future chats — preferences, " +
      "account or profile details you were told or filled into a form, " +
      "recurring tasks. Not for one-off task state that only matters in this " +
      "chat, and not for answers to ask_user (those are saved for you). " +
      "Never store passwords or other secrets. Jev decides whether it is " +
      "worth keeping.",
    input_schema: {
      type: "object",
      properties: {
        topic: str(
          'Slash-separated topic path, e.g. "user/career" or "user/preferences". ' +
            "Reuse an existing topic when it fits.",
        ),
        title: str('Short title for this fact, e.g. "Current job title"'),
        content: str("The fact itself, in a sentence or two."),
      },
      required: ["topic", "title", "content"],
    },
  },
  async run({ topic, title, content }, ctx) {
    const verdict = await judgeMemoryWorth({ title, content }, await userContext(ctx), ctx.chatId, ctx.signal);
    if (verdict && !verdict.worth) {
      return (
        `Not saved: Jev judged this not worth keeping across chats ` +
        `(${verdict.p.toFixed(2)}) — it looks like one-off task state, or it is ` +
        `already on file. Carry on.`
      );
    }
    const meta = await saveMemory(topic, title, content);
    emit("remember", ctx.chatId, `${meta.topic}/${meta.slug}`);
    return `Saved to ${meta.topic}/${meta.slug}.md`;
  },
};

const searchMemory: BrowserTool = {
  def: {
    name: "search_memory",
    description:
      "Look something up in what you know about the user from past chats. " +
      "Say what you need in plain words (\"their expected salary\", \"can I " +
      "tick the privacy consent box\"). Every saved memory is ranked for you " +
      "and the likeliest ones come back first; read them in that order. For " +
      "a whole form, use find_answers instead.",
    input_schema: {
      type: "object",
      properties: { query: str("What you need to know, in plain words") },
      required: ["query"],
    },
  },
  async run({ query }, ctx) {
    const { note, results, inConversation } = await searchMemories(
      String(query ?? ""),
      userSaid(ctx),
      ctx.chatId,
      ctx.signal,
    );
    emit("recall", ctx.chatId, `${results.length} match(es)`);
    const said =
      inConversation !== undefined && inConversation >= LIKELY_AT
        ? `The user's own messages in this chat likely answer it too (${inConversation.toFixed(2)}).\n\n`
        : "";
    if (results.length === 0) return note ? `${said}${note}` : "No saved memories yet.";
    const body = results
      .map((r) => `[${r.topic}/${r.slug}]${r.p === undefined ? "" : ` (${r.p.toFixed(2)})`} ${r.title}\n${r.content}`)
      .join("\n\n");
    return `${said}${note}\n\n${body}`;
  },
};

// ── forms ───────────────────────────────────────────────────────────────────

const MAX_FIELDS = 60;
const CONVERSATION_CAP = 8000;

const findAnswers: BrowserTool = {
  def: {
    name: "find_answers",
    description:
      "Before filling a form, pass every field on it in page order — its " +
      "label or question, with the choices if it has them. For each field " +
      "you get where the answer is: the user's own messages, or the saved " +
      "memories likeliest to hold it, best first — or nothing on file, which " +
      "means skip it and ask the user later instead of guessing. One call " +
      "covers the whole form.",
    input_schema: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: { type: "string" },
          description:
            'Each field as the page puts it, e.g. "First name", "Location ' +
            'preference (Remote / NYC / SF Bay Area)", "I agree to the privacy notice"',
        },
      },
      required: ["fields"],
    },
  },
  async run({ fields }, ctx) {
    const list = strings(fields).slice(0, MAX_FIELDS);
    if (list.length === 0) return "Pass the form's fields, e.g. fields: [\"First name\", \"Email\"].";

    // Only memories from before this chat, and the user's own words — the
    // same things groundingGate accepts, so a field this points to a source
    // for can actually be filled.
    const memories = await memoriesBefore(ctx.chatStartedAt);
    const saidText = userSaid(ctx).join("\n\n");
    const sources: Source[] = [
      {
        id: "conversation",
        text:
          "What the user has said in this chat: " +
          (saidText.length > CONVERSATION_CAP ? `${saidText.slice(0, CONVERSATION_CAP)}…` : saidText),
      },
      ...memories.map((m) => ({ id: memoryId(m), text: `Saved memory — ${m.title}: ${m.content}` })),
    ];
    const ranked = await rankSources(
      list.map((f) => `the answer to the form field "${f}"`),
      sources,
      ctx.chatId,
      ctx.signal,
    );
    if (!ranked) {
      return (
        "Could not rank where the answers are right now (Jev unavailable). " +
        "Use search_memory for the fields you are unsure of."
      );
    }

    const byId = new Map(memories.map((m) => [memoryId(m), m]));
    const cited: string[] = [];
    let found = 0;
    const lines = list.map((field, i) => {
      const likely = ranked[i].filter((r) => r.p >= LIKELY_AT).slice(0, 2);
      if (likely.length === 0) return `${i + 1}. ${field} — nothing on file: skip it for now, ask the user later`;
      found++;
      const where = likely.map((r) => {
        if (r.id === "conversation") return `the user's messages (${r.p.toFixed(2)})`;
        if (!cited.includes(r.id)) cited.push(r.id);
        return `[m${cited.indexOf(r.id) + 1}] (${r.p.toFixed(2)})`;
      });
      return `${i + 1}. ${field} — ${where.join(", ")}`;
    });
    emit("lookup", ctx.chatId, `${found} of ${list.length} fields have an answer on file`);
    const memo = cited.map((id, i) => {
      const m = byId.get(id)!;
      return `[m${i + 1}] ${m.title}: ${m.content}`;
    });
    return (
      `Where each field's answer is — ${found} of ${list.length} have one on file:\n` +
      lines.join("\n") +
      (memo.length ? `\n\nMemories referred to:\n${memo.join("\n")}` : "") +
      `\n\nFill the fields that have an answer, in order, and skip the rest. ` +
      `Then ask the user for everything still missing in one ask_user call.`
    );
  },
};

const MAX_QUESTIONS = 12;
const MAX_OPTIONS = 12;

const askUser: BrowserTool = {
  def: {
    name: "ask_user",
    description:
      "Ask the user for information you need and do not have. They see a " +
      "short form in the side panel — one question at a time, your suggested " +
      "options to pick from, and always a box to type their own answer. First " +
      "do everything you can without it, then ask for everything still " +
      "missing in ONE call; do not also list the questions in your reply. " +
      "Their answers count as things they told you, and the lasting ones are " +
      "saved to memory for you (Jev decides which).",
    input_schema: {
      type: "object",
      properties: {
        intro: str('One line on why you are asking, e.g. "To finish the Underdog.io application"'),
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question: str('The question, e.g. "Which personal email should applications use?"'),
              options: {
                type: "array",
                items: { type: "string" },
                description:
                  "Likely answers to pick from, when the answer is a choice — e.g. the " +
                  "form's own options. Leave empty for free text.",
              },
              multiple: { type: "boolean", description: "True if more than one option may be picked" },
              title: str('A short name for the fact, used if it is saved to memory, e.g. "Personal email"'),
            },
            required: ["question"],
          },
        },
      },
      required: ["questions"],
    },
  },
  async run({ intro, questions }, ctx) {
    const qs = (Array.isArray(questions) ? questions : [])
      .filter((q: any) => q && typeof q.question === "string" && q.question.trim())
      .slice(0, MAX_QUESTIONS)
      .map((q: any) => ({
        question: q.question.trim() as string,
        options: strings(q.options).slice(0, MAX_OPTIONS),
        multiple: Boolean(q.multiple),
        title: typeof q.title === "string" && q.title.trim() ? q.title.trim() : q.question.trim().slice(0, 60),
      }));
    if (qs.length === 0) return 'Pass at least one question, e.g. questions: [{"question": "…"}].';

    emit("ask", ctx.chatId, `${qs.length} question${qs.length === 1 ? "" : "s"} for you`);
    const outcome = await requestAnswers(
      {
        intro: typeof intro === "string" ? intro.trim() : "",
        questions: qs.map(({ question, options, multiple }): AskQuestion => ({ question, options, multiple })),
      },
      ctx.chatId,
      undefined,
      ctx.signal,
    );
    if (outcome === "unanswered") {
      return (
        "The user has not answered yet (the panel may be closed). Stop here: say " +
        "you are waiting on their answers and that they can answer in the side panel."
      );
    }
    if (outcome === "dismissed") {
      return (
        "The user closed the questions without answering. Do not ask them again. " +
        "Finish what you can without them, and say what is still missing."
      );
    }

    const context = await userContext(ctx);
    const lines = await Promise.all(
      qs.map(async (q, i) => {
        const answer = outcome.answers[i] ?? null;
        if (answer === null) return `${i + 1}. ${q.question} → (skipped)`;
        ctx.answers.push(`${q.question} — ${answer}`);
        if (!jevEnabled) return `${i + 1}. ${q.question} → ${answer}`;
        const verdict = await judgeMemoryWorth({ question: q.question, answer }, context, ctx.chatId, ctx.signal);
        if (!verdict) {
          return `${i + 1}. ${q.question} → ${answer}  (not saved: the check failed — remember it yourself if it is a lasting fact)`;
        }
        if (!verdict.worth) return `${i + 1}. ${q.question} → ${answer}  (not saved: only about this task)`;
        const meta = await saveMemory("user/answers", q.title, `Asked "${q.question}" — answered: ${answer}`);
        emit("remember", ctx.chatId, `${meta.topic}/${meta.slug}`);
        return `${i + 1}. ${q.question} → ${answer}  (saved to memory: ${meta.topic}/${meta.slug})`;
      }),
    );
    const answered = outcome.answers.filter((a) => a !== null).length;
    const saved = lines.filter((l) => l.includes("(saved to memory")).length;
    emit(
      "answered",
      ctx.chatId,
      `${answered} answered · ${qs.length - answered} skipped · ${saved} saved to memory`,
    );
    return (
      `The user answered:\n${lines.join("\n")}\n\n` +
      `These count as things the user told you — enter them as given, and do ` +
      `not ask again for the skipped ones.`
    );
  },
};

const checkJobFit: BrowserTool = {
  def: {
    name: "check_job_fit",
    description:
      "Decide whether a job is worth applying to. Jev makes the call against " +
      "the user's instructions and saved memories, reading the job's details " +
      "off the current page — so open them first. Call it before applying to " +
      "any job. APPLY means apply. SKIP means move on to the next listing " +
      "without second-guessing it; the skip and its reason are recorded for you.",
    input_schema: {
      type: "object",
      properties: {
        job: str('Which job, as the page names it, e.g. "Junior AI Engineer — Relevance AI"'),
      },
      required: ["job"],
    },
  },
  async run({ job }, ctx) {
    if (!jevEnabled) {
      return "Job checks need Jev, which is not configured — judge the fit yourself against the user's instructions.";
    }
    const which = String(job ?? "").trim() || "the job whose details are open";
    const result = await assessJob(which, ctx);
    if (!result) return "The job check failed — judge the fit yourself against the user's instructions.";
    const { fit, recorded } = result;
    return fit.apply
      ? `APPLY (${fit.p.toFixed(2)}): ${which} fits the user. Go ahead and apply.`
      : `SKIP (${(1 - fit.p).toFixed(2)}): ${which} — ${fit.reason}. ` +
          (recorded
            ? "It is already recorded as skipped, with that reason — do not add it to update_progress. "
            : "") +
          "Move on to the next listing.";
  },
};

// ── progress ────────────────────────────────────────────────────────────────

/** Models sometimes send one string where an array was asked for. */
function strings(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter((s) => s.trim());
  return typeof v === "string" && v.trim() ? [v] : [];
}

const updateProgress: BrowserTool = {
  def: {
    name: "update_progress",
    description:
      "Record progress on the current task, outside the conversation. Call " +
      "it each time you finish or skip one part of a multi-part task (e.g. " +
      "each job applied to), and before you stop. Record a part as done only " +
      "after a snapshot showed it succeeded — a confirmation page or message, " +
      "not just the click. If the task continues in a fresh context, what " +
      "you recorded here is all you will know about what was already done.",
    input_schema: {
      type: "object",
      properties: {
        done: {
          type: "array",
          items: { type: "string" },
          description:
            "Parts finished, each specific enough never to redo it, e.g. " +
            '"Software Engineer — Canva, Sydney — submitted". Ones already ' +
            "recorded are ignored, so resending the full list is fine.",
        },
        skipped: {
          type: "array",
          items: { type: "string" },
          description:
            "Parts passed over, each with the reason. Ones already recorded are ignored. " +
            "Jobs check_job_fit said to skip are recorded for you — leave them out.",
        },
        note: str("Where things stand now and what is next. Replaces the previous note."),
      },
      required: [],
    },
  },
  async run({ done, skipped, note }, ctx) {
    const task = await recordProgress(ctx.chatId, {
      done: strings(done),
      skipped: strings(skipped),
      note: typeof note === "string" ? note.trim() : "",
    });
    if (!task) return "No task is being tracked in this chat, so nothing was recorded — carry on.";
    const counts = `${task.done.length} done, ${task.skipped.length} skipped`;
    emit("progress", ctx.chatId, counts);
    return `Recorded. So far: ${counts}.`;
  },
};

export const TOOLS: BrowserTool[] = [
  snapshot, screenshot, readPage,
  click, type, paste, hover, selectOption, pressKey, scroll,
  sheetRead, sheetWrite, sheetSelect,
  navigate, goBack, waitForIdle,
  listTabs, openTab, activateTab, closeTab,
  remember, searchMemory, findAnswers, askUser,
  checkJobFit, updateProgress,
];

export const TOOL_DEFS: OpenAI.Chat.Completions.ChatCompletionTool[] = TOOLS.map(
  (t) => ({
    type: "function",
    function: {
      name: t.def.name,
      description: t.def.description,
      parameters: t.def.input_schema,
    },
  }),
);
export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.def.name, t]));

/**
 * Why a call cannot run as sent: required arguments it left out or left
 * blank, or null when it has them all. A tool describes its action from its
 * arguments — "Click e106 — <why>" — and that description is what the user
 * approves and Jev judges, so a missing one reaches both as "undefined".
 * Refused before the tool runs, the model sends the call again instead.
 */
export function missingArgs(def: ToolDef, input: unknown): string | null {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const missing = def.input_schema.required.filter((name) => {
    const v = args[name];
    if (v === undefined || v === null) return true;
    // Empty text is a real value: pasting "" into a field empties it.
    return typeof v === "string" && !v.trim() && name !== "text";
  });
  if (!missing.length) return null;
  const names =
    missing.length > 1
      ? `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}`
      : missing[0];
  const lines = missing.map((name) => {
    const about = (def.input_schema.properties[name] as { description?: string })?.description;
    return `- ${name}${about ? `: ${about}` : ""}`;
  });
  return (
    `${def.name} was not run: it needs ${names}, and this call ` +
    `left ${missing.length > 1 ? "them" : "it"} out or empty.\n${lines.join("\n")}\n` +
    `Send the ${def.name} call again with ${missing.length > 1 ? "them" : "it"} filled in.`
  );
}
