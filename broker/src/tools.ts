// Tool surface.
//
// Semantic tools keyed by accessibility refs, not raw coordinates. The model
// never sees a pixel position, so it cannot invent one; resolution from ref to
// coordinates happens in the extension against the live box model.

import type OpenAI from "openai";
import { call, emit, requestApproval } from "./bridge.js";
import { judgeAction, judgeMemoryWorth, judgeOutcome } from "./jev.js";
import { saveMemory, searchMemories } from "./memory.js";
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
 * op's own timeout.
 */
export type ToolCtx = { chatId: string; approvalMode: ApprovalMode; signal: AbortSignal };

export type BrowserTool = {
  def: ToolDef;
  run: (input: any, ctx: ToolCtx) => Promise<ToolResult>;
};

async function gate(kind: "click" | "submit", what: string, ctx: ToolCtx): Promise<string | null> {
  judgeAction(kind, what, ctx.chatId);

  const needed =
    ctx.approvalMode === "all" ||
    (ctx.approvalMode === "submits" && kind === "submit");
  if (!needed) return null;

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

const str = (description: string) => ({ type: "string" as const, description });

/**
 * Render an input-op result, calling out a tab switch loudly when one
 * happened.
 *
 * Without this the model has no evidence that a click worked: the tab it was
 * looking at is unchanged, the button is still in the next snapshot, and it
 * clicks again. Saying so in the tool result is what breaks that loop.
 */
function describeAction(what: string, r: any, ctx: ToolCtx): string {
  judgeOutcome(what, r, ctx.chatId);

  const moved = r?.followedNewTab;
  if (!moved) return JSON.stringify(r);
  emit("follow-tab", ctx.chatId, moved.url ?? `tab ${moved.tabId}`);
  return (
    `${JSON.stringify(r)}\n\n` +
    `That action opened a new tab and you are now controlling it: ` +
    `${moved.title || "(untitled)"} — ${moved.url || "(url unknown)"}\n` +
    `The action SUCCEEDED. Do not repeat it. Every ref from an earlier ` +
    `snapshot belongs to the previous tab and is stale, so take a fresh ` +
    `snapshot before doing anything else. Use list_tabs and activate_tab if ` +
    `you need to return to the old tab.`
  );
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

const snapshot: BrowserTool = {
  def: {
    name: "snapshot",
    description:
      "Capture the accessibility tree of the current tab as a list of elements " +
      "with [eN] refs. This is your primary way to see the page. Call it before " +
      "interacting and again after any action that changes the page. Refs are " +
      "invalidated by every new snapshot. If the page is icon-heavy, canvas-based, " +
      "or otherwise hard to read as text, a badged screenshot is attached " +
      "automatically and its red badge numbers match the [eN] refs.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  async run(_input, ctx) {
    const snap = await call<{
      text: string; weak: string | null; interactiveCount: number;
    }>("snapshot", ctx.chatId, {}, undefined, ctx.signal);
    emit("snapshot", ctx.chatId, `${snap.interactiveCount} interactive elements`);

    const blocks: ContentPart[] = [
      { type: "text", text: snap.text },
    ];

    // Adaptive escalation. The model systematically under-requests vision, so
    // the harness decides: icon-only UIs and canvas content are exactly where
    // an accessibility tree goes blind.
    if (snap.weak) {
      try {
        const shot = await call<{ data: string; badged: number }>("badged_screenshot", ctx.chatId, {}, undefined, ctx.signal);
        const image = jpegPart(shot.data);
        if (!image) throw new Error(EMPTY_CAPTURE);
        emit("vision", ctx.chatId, `escalated (${snap.weak}), ${shot.badged} badges`);
        blocks.push({
          type: "text",
          text:
            `The snapshot above is unreliable here (${snap.weak}). A screenshot ` +
            `follows with red badge numbers drawn on interactive elements. Badge ` +
            `N corresponds to ref "eN" — pass the ref, not the number, to tools.`,
        });
        blocks.push(image);
      } catch (err) {
        blocks.push({
          type: "text",
          text: `(vision escalation failed: ${String(err)})`,
        });
      }
    }
    return blocks;
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
    description: "Click an element by its ref from the most recent snapshot.",
    input_schema: {
      type: "object",
      properties: {
        ref: str('Element ref from the latest snapshot, e.g. "e28"'),
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
    const denied = await gate(destructive ? "submit" : "click", what, ctx);
    if (denied) return denied;
    emit("click", ctx.chatId, `${ref} — ${why}`);
    const r = await call("click", ctx.chatId, { ref }, undefined, ctx.signal);
    return describeAction(what, r, ctx);
  },
};

const type: BrowserTool = {
  def: {
    name: "type",
    description:
      "Focus a text field by ref and type into it with human-like keystroke " +
      "timing. Set submit=true to press Enter afterwards.",
    input_schema: {
      type: "object",
      properties: {
        ref: str('Text field ref, e.g. "e12"'),
        text: str("Text to type"),
        submit: { type: "boolean", description: "Press Enter after typing" },
        clear: { type: "boolean", description: "Select-all and delete existing content first" },
      },
      required: ["ref", "text"],
    },
  },
  async run({ ref, text, submit, clear }, ctx) {
    const what = submit ? `Type into ${ref} and submit: "${text}"` : `Type into ${ref}: "${text}"`;
    if (submit) {
      const denied = await gate("submit", what, ctx);
      if (denied) return denied;
    }
    emit("type", ctx.chatId, `${ref} ← "${text}"${submit ? " ⏎" : ""}`);
    const r = await call("type", ctx.chatId, { ref, text, submit, clear }, undefined, ctx.signal);
    return describeAction(what, r, ctx);
  },
};

/** Short, single-line form of possibly-long text, for the popup log. */
function preview(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `"${flat.slice(0, max)}…" (${text.length} chars)` : `"${flat}"`;
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
      "does, retry that field with `type`. Set clear=true to replace what is " +
      "already there, and submit=true to press Enter afterwards.",
    input_schema: {
      type: "object",
      properties: {
        ref: str('Text field ref, e.g. "e12"'),
        text: str("Text to paste"),
        submit: { type: "boolean", description: "Press Enter after pasting" },
        clear: { type: "boolean", description: "Select-all and delete existing content first" },
      },
      required: ["ref", "text"],
    },
  },
  async run({ ref, text, submit, clear }, ctx) {
    const what = submit
      ? `Paste into ${ref} and submit: ${preview(text, 200)}`
      : `Paste into ${ref}: ${preview(text, 200)}`;
    if (submit) {
      const denied = await gate("submit", what, ctx);
      if (denied) return denied;
    }
    emit("paste", ctx.chatId, `${ref} ⇐ ${preview(text)}${submit ? " ⏎" : ""}`);
    const r = await call("paste", ctx.chatId, { ref, text, submit, clear }, undefined, ctx.signal);
    // The read-back value is only for the verdict. Echoing a whole cover
    // letter back into the context would cost its length again for nothing.
    const { value, ...rest } = r ?? {};
    return describeAction(what, rest, ctx) + pasteVerdict(value ?? null, text);
  },
};

const hover: BrowserTool = {
  def: {
    name: "hover",
    description: "Move the pointer over an element. Use to reveal hover menus and tooltips.",
    input_schema: {
      type: "object",
      properties: { ref: str("Element ref") },
      required: ["ref"],
    },
  },
  async run({ ref }, ctx) {
    emit("hover", ctx.chatId, ref);
    return JSON.stringify(await call("hover", ctx.chatId, { ref }, undefined, ctx.signal));
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
    emit("select", ctx.chatId, `${ref} ← ${value}`);
    return JSON.stringify(await call("select_option", ctx.chatId, { ref, value }, undefined, ctx.signal));
  },
};

const pressKey: BrowserTool = {
  def: {
    name: "press_key",
    description: "Press a single non-printable key on the focused element.",
    input_schema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          enum: [
            "Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowUp",
            "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End",
            "PageDown", "PageUp",
          ],
        },
      },
      required: ["key"],
    },
  },
  async run({ key }, ctx) {
    emit("key", ctx.chatId, key);
    const r = await call("press_key", ctx.chatId, { key }, undefined, ctx.signal);
    return describeAction(`Press ${key}`, r, ctx);
  },
};

const scroll: BrowserTool = {
  def: {
    name: "scroll",
    description:
      "Scroll the page. Snapshots only cover loaded content, so scroll to reveal " +
      "more and then take a fresh snapshot.",
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
    return JSON.stringify(await call("scroll", ctx.chatId, { direction, amount }, undefined, ctx.signal));
  },
};

// ── navigation ──────────────────────────────────────────────────────────────

const navigate: BrowserTool = {
  def: {
    name: "navigate",
    description: "Navigate the current tab to an http(s) URL and wait for it to settle.",
    input_schema: {
      type: "object",
      properties: { url: str("Absolute http(s) URL") },
      required: ["url"],
    },
  },
  async run({ url }, ctx) {
    emit("navigate", ctx.chatId, url);
    return JSON.stringify(await call("navigate", ctx.chatId, { url }, 40_000, ctx.signal));
  },
};

const goBack: BrowserTool = {
  def: {
    name: "go_back",
    description: "Go back one entry in the tab's history.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  async run(_input, ctx) {
    emit("back", ctx.chatId, "");
    return JSON.stringify(await call("go_back", ctx.chatId, {}, undefined, ctx.signal));
  },
};

const waitForIdle: BrowserTool = {
  def: {
    name: "wait_for_idle",
    description:
      "Wait for network activity to settle. Use after an action that triggers " +
      "loading but does not navigate, before taking a snapshot.",
    input_schema: {
      type: "object",
      properties: {
        timeoutMs: { type: "integer", description: "Max wait in ms (default 15000)" },
      },
      required: [],
    },
  },
  async run({ timeoutMs }, ctx) {
    emit("wait", ctx.chatId, "for idle");
    return JSON.stringify(await call("wait_for_idle", ctx.chatId, { timeoutMs }, 40_000, ctx.signal));
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
      "opens in the background and is not brought to the front; you still see " +
      "it normally through snapshot.",
    input_schema: {
      type: "object",
      properties: { url: str("Absolute http(s) URL") },
      required: ["url"],
    },
  },
  async run({ url }, ctx) {
    emit("open-tab", ctx.chatId, url);
    return JSON.stringify(await call("open_tab", ctx.chatId, { url }, 40_000, ctx.signal));
  },
};

const activateTab: BrowserTool = {
  def: {
    name: "activate_tab",
    description:
      "Switch to an existing tab by id and control it from now on. This changes " +
      "which tab you drive, not which tab the user is looking at — it does not " +
      "raise the tab or its window.",
    input_schema: {
      type: "object",
      properties: { tabId: { type: "integer", description: "Tab id from list_tabs" } },
      required: ["tabId"],
    },
  },
  async run({ tabId }, ctx) {
    emit("activate-tab", ctx.chatId, String(tabId));
    return JSON.stringify(await call("activate_tab", ctx.chatId, { tabId }, undefined, ctx.signal));
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
      "chat. Never store passwords or other secrets.",
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
    judgeMemoryWorth(topic, title, content, ctx.chatId);
    const meta = await saveMemory(topic, title, content);
    emit("remember", ctx.chatId, `${meta.topic}/${meta.slug}`);
    return `Saved to ${meta.topic}/${meta.slug}.md`;
  },
};

const searchMemory: BrowserTool = {
  def: {
    name: "search_memory",
    description:
      "Search facts saved earlier with remember, across all past chats. Call " +
      "this before a task that could reuse something you already know about " +
      "the user — filling a form, personalizing a choice, resuming a " +
      "recurring task.",
    input_schema: {
      type: "object",
      properties: { query: str("What to look for, in plain words") },
      required: ["query"],
    },
  },
  async run({ query }, ctx) {
    const { verdict, results } = await searchMemories(query, ctx.chatId);
    emit("recall", ctx.chatId, `${results.length} match(es)`);
    if (results.length === 0) {
      return verdict ? `${verdict}\n\nNo saved memories matched.` : "No saved memories matched.";
    }
    const body = results.map((r) => `[${r.topic}/${r.slug}] ${r.title}\n${r.content}`).join("\n\n");
    return verdict ? `${verdict}\n\n${body}` : body;
  },
};

export const TOOLS: BrowserTool[] = [
  snapshot, screenshot, readPage,
  click, type, paste, hover, selectOption, pressKey, scroll,
  navigate, goBack, waitForIdle,
  listTabs, openTab, activateTab, closeTab,
  remember, searchMemory,
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
