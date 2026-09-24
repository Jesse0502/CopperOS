// The agent loop.
//
// Talks to whichever provider Settings currently points at (Ollama, OpenAI or
// OpenRouter) through the OpenAI chat-completions API — Ollama via its
// OpenAI-compatible endpoint (/v1) rather than the native /api/chat. The
// compat layer gives real tool_call ids, so parallel tool calls pair up
// unambiguously, and it accepts image content blocks inside tool-result
// messages — which the vision escalation in tools.ts depends on.

import { setTimeout as sleep } from "node:timers/promises";
import OpenAI from "openai";
import { emit } from "./bridge.js";
import {
  missingArgs,
  refLabel,
  TOOL_DEFS,
  TOOL_BY_NAME,
  type ToolCtx,
  type ToolResult,
  type ContentPart,
} from "./tools.js";
import {
  acceptsImages,
  getConfig,
  OPENROUTER_BASE,
  openrouterContextTokens,
  type LLMConfig,
} from "./config.js";
import {
  classifyIntent,
  jevEnabled,
  judgeCompletion,
  superviseTask,
  type EarlierTurn,
  type Intent,
} from "./jev.js";
import {
  brief,
  isBrief,
  loadTask,
  newTask,
  progressMark,
  saveTask,
  type TaskState,
} from "./progress.js";
import {
  briefNote,
  checkInPrompt,
  describeAction,
  driftSummary,
  feedback,
  isCheckIn,
  isSupervisorNote,
  TRAIL_LENGTH,
} from "./supervisor.js";
import {
  blank,
  listSessions,
  loadCurrent,
  loadSession,
  save,
  storageDir,
  stripImages,
  type ApprovalMode,
  type Session,
  type SessionSummary,
} from "./session.js";

const MAX_STEPS = 60;

// A tracked task (see progress.ts) keeps getting fresh rounds while Jev says
// there is more to do — up to this many per message from the user, and only
// while rounds keep recording progress.
const MAX_ROUNDS = Number(process.env.TASK_MAX_ROUNDS ?? 15);
const MAX_STALLED_ROUNDS = 2;
// Below this, a "keep going" verdict stops instead: an unsure continue costs
// a whole extra round of the main model, an unsure stop only costs the user
// typing "continue".
const KEEP_GOING_MIN_CONFIDENCE = 0.7;

// Every this many steps of a tracked task, the model stops to say what it is
// doing and Jev checks that, and what it actually did, against the user's
// instructions (see supervisor.ts). 0 turns check-ins off.
const CHECK_IN_EVERY = Number(process.env.CHECK_IN_EVERY ?? 10);
// A round whose context has grown past this many tokens hands over to a
// fresh round at its next check-in, however well it is going — the models
// this runs on lose track of their instructions as context piles up. The
// "check again and verify" turn that went off course in the user's Sheets
// run started with ~45k tokens of earlier chat behind it.
const FRESH_CONTEXT_TOKENS = Number(process.env.FRESH_CONTEXT_TOKENS ?? 25_000);
// Off course at this many check-ins in a row stops the task for the user to
// steer. Before that, odd strikes get a correction and even ones a fresh
// round with the correction in its brief. Any on-course verdict resets it.
const MAX_STRIKES = 4;
// The model's check-in answer as Jev sees it.
const CHECK_IN_REPORT_CAP = 1500;

const MAX_OUTPUT_TOKENS = 16000;

type Effort = "high" | "none";

// The fields each provider wants for the output cap and reasoning effort.
// Ollama ignores unknown top-level fields, so num_ctx rides along in the
// request body the same way the native API takes it under `options`.
// OpenRouter takes `max_tokens` for every model but `max_completion_tokens`
// only for some, and its own `reasoning` object for every model.
type Knobs = {
  max_completion_tokens?: number;
  max_tokens?: number;
  reasoning_effort?: Effort;
  reasoning?: { effort: Effort };
  options?: { num_ctx: number };
};

/** Cheap, never throws — just labels which model a chat was/is using. */
function activeLabel(cfg: LLMConfig): string {
  return `${cfg.provider}:${cfg[cfg.provider].model}`;
}

/** Provider + model + a ready OpenAI-compatible client, resolved from the current settings. */
function resolveActive(cfg: LLMConfig) {
  if (cfg.provider === "openai") {
    if (!cfg.openai.apiKey) {
      throw new Error(
        "No OpenAI API key set. Add one in Settings, or switch the provider back to Ollama.",
      );
    }
    return {
      label: `openai:${cfg.openai.model}`,
      model: cfg.openai.model,
      client: new OpenAI({ apiKey: cfg.openai.apiKey }),
      knobs: (effort: Effort): Knobs => ({
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        reasoning_effort: effort,
      }),
    };
  }
  if (cfg.provider === "openrouter") {
    if (!cfg.openrouter.apiKey) {
      throw new Error(
        "No OpenRouter API key set. Add one in Settings or as OPENROUTER_API_KEY in broker/.env.",
      );
    }
    return {
      label: `openrouter:${cfg.openrouter.model}`,
      model: cfg.openrouter.model,
      client: new OpenAI({
        baseURL: OPENROUTER_BASE,
        apiKey: cfg.openrouter.apiKey,
        // Names the app in the user's OpenRouter activity log.
        defaultHeaders: { "X-Title": "CopperOS" },
      }),
      knobs: (effort: Effort): Knobs => ({
        max_tokens: MAX_OUTPUT_TOKENS,
        reasoning: { effort },
      }),
    };
  }
  return {
    label: `ollama:${cfg.ollama.model}`,
    model: cfg.ollama.model,
    client: new OpenAI({
      baseURL: `${cfg.ollama.host.replace(/\/$/, "")}/v1`,
      // Ollama does not check this, but the SDK refuses to construct without it.
      apiKey: process.env.OLLAMA_API_KEY ?? "ollama",
    }),
    knobs: (effort: Effort): Knobs => ({
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      reasoning_effort: effort,
      options: { num_ctx: cfg.ollama.numCtx },
    }),
  };
}

// The chat is sticky, so it grows without bound unless something caps it.
// Roughly 4 chars per token, and leave room for the reply and the tools.
async function historyBudgetChars(cfg: LLMConfig): Promise<number> {
  if (process.env.HISTORY_BUDGET_CHARS)
    return Number(process.env.HISTORY_BUDGET_CHARS);
  if (cfg.provider === "ollama") return Math.floor(cfg.ollama.numCtx * 4 * 0.6);
  // OpenAI's hosted context windows are generous and not user-configured here.
  // OpenRouter's range from a few thousand tokens up, so a small one lowers
  // the cap.
  const tokens =
    cfg.provider === "openrouter"
      ? await openrouterContextTokens(cfg.openrouter.model)
      : null;
  return Math.min(400_000, tokens ? Math.floor(tokens * 4 * 0.6) : 400_000);
}

// How many recent tool-result messages keep their full payload. Older ones get
// their images and long snapshot text stripped — see pruneHistory — but only
// once PRUNE_EVERY more have piled up, then all at once. Pruning rewrites an
// earlier message, and everything after a rewrite misses the provider's
// prefix cache; in batches, that happens every few steps instead of every one.
const KEEP_FULL = 3;
const PRUNE_EVERY = 4;
const STALE_TEXT_CAP = 600;

// Frozen prefix: this string must not vary between requests, or Ollama's
// prefix KV cache misses on every turn. Nothing dynamic goes in here.
const SYSTEM = `You are CopperOS, a prompt-driven browser agent. The user gives you a task in plain language and you carry it out by directly operating a real browser tab — in their own profile, with their existing logins — clicking, typing, navigating, and reading pages the way a person would, not through a site's API.

You're built for multi-step browsing work: filling out and submitting forms, researching across pages and tabs, comparing options, signing up for or configuring services, and similar tasks that live inside a browser. You are not a general-purpose chatbot — if a request has nothing to do with operating the browser, say so rather than trying to answer it from general knowledge.

<perception>
You see pages through \`snapshot\`, which returns the accessibility tree as lines like:
  [e12] textbox "Search" value=""
  [e28] button "Sign in"
The [eN] tokens are refs. Pass them to interaction tools. A ref names the same element for as long as that element is on the page, across snapshots; after a navigation, the old page's refs stop working.

A snapshot covers the whole page, not just what is on screen, and every field and button on it gets a ref. You never need to scroll to find a field, and clicking or typing into one brings it into view.

When a page is icon-only or canvas-based, a badged screenshot is attached to the snapshot automatically. Red badge N means ref "eN".
</perception>

<workflow>
1. snapshot to see a page you have not seen yet
2. act using its refs
3. read the action's result: it lists what the action changed on the page (+ appeared, ~ changed, - gone), or shows the whole page after a navigation. That is your confirmation — you do not need a snapshot after each action.
When you already know the refs and values for several actions — the fields of a form — send them together in one response rather than one per turn. Act on what the latest result shows; snapshot again only when you need the whole page.
</workflow>

<rules>
- Never guess a ref. On an unknown-ref error, take a fresh snapshot and retry.
- Some buttons ("Apply now", "Continue", external links) open a new tab. When that happens you are switched to the new tab automatically, and the tool result says so and shows the new tab's page. Treat that as proof the action worked: never click it again. Your old refs belong to the old tab.
- Close tabs you opened with close_tab once you are finished with them, and keep open the ones you will return to. When a task ends, tabs you opened are closed for you except the one you finish on — so if you will need a page again later, remember its URL.
- Prefer snapshot over screenshot; screenshots are expensive and less precise.
- Use read_page for reading and summarizing content, snapshot for finding controls.
- Fill form fields with paste, not type. Switch to type for search boxes that suggest as you type, one-box-per-character codes, and masked inputs like phone numbers or dates — and for any field paste reports it did not accept.
- Scroll only for content that loads as you scroll (long result lists, infinite feeds) — never to look for a field.
- Actions wait for the page to settle before they return. Call wait_for_idle only when a result shows the page still loading.
- Set destructive=true on any click that purchases, sends, posts, deletes, or confirms something hard to undo. The user is asked to approve those.
- If the user declines an action, do not retry it. Explain the situation and stop.
- Never enter credentials, payment details, or other secrets. If a task requires signing in, stop and tell the user to sign in themselves, then continue.
- Only enter details about the user that they gave you — in their messages, their ask_user answers, or their saved memories. Never guess one, and never take one from the page or the job ad (an employer's address is not the user's address). Every form entry is checked against those, and one that is not backed is refused.
- When you need information from the user, ask with ask_user — never by listing questions in your reply.
- Choosing jobs to apply to: open each job's details and call check_job_fit before applying. Its verdict is final — apply on APPLY; on SKIP, move to the next listing without arguing with it. An application you start on a job you have not checked is checked for you, and stopped if it does not fit.
- Set destructive=true on the click that submits an application, as on any other submit; the approval step lets through what the user asked for without bothering them.
- Older screenshots and page snapshots in this conversation are replaced with placeholders to save context. If you need to see the page again, take a fresh snapshot.
</rules>

<reporting>
When the task is done, state what you did and what you found. If you could not
complete it, say exactly where you stopped and why — do not claim success you
did not verify on screen.
</reporting>

<memory>
Saved memories hold what you know about the user from past chats.
- search_memory: say what you need in plain words. Every memory is ranked for you and the likeliest come back first — read them in that order. Look things up there before asking the user; they should never be asked for something already on file.
- remember: save something durable you learned that the user did not give you through ask_user — never one-off task details, passwords or other secrets. Jev decides whether it is worth keeping. Reuse an existing topic when one fits.
- ask_user answers are saved for you when they are worth keeping.
</memory>

<forms>
Fill a form one field at a time, top to bottom, in a single pass:
1. Snapshot once. Every field is in it, including ones below the fold.
2. Call find_answers with every field, in page order. It tells you, for each, where the answer is — the user's messages or the memories likeliest to hold it — or that nothing is on file.
3. Go down the form field by field. Fill each one you have an answer for — several fields per response, since their refs stay valid — and skip each one you do not. Do not guess, and do not go back and forth.
4. Once everything you can fill is filled, ask for all the skipped fields in one ask_user call — with the field's own options when it has them.
5. Fill in the answers, check the form with a snapshot, and submit if the task says to.
A long form over several pages: do this for each page.
</forms>

<sheets>
Google Sheets draws its grid on a canvas: no cell is ever in a snapshot, and no ref points at one. A snapshot of a sheet starts with the top-left of the grid instead, with its column letters and row numbers.
- Read cells with sheet_read; pass a range for anything beyond that preview.
- Enter values with sheet_write — a whole block per call, never cell by cell. Its result lists any cell that does not read back as written.
- For anything else — formatting, clearing, deleting — select the cells with sheet_select, then use the toolbar or menus from the snapshot, or press_key shortcuts (Delete clears, Mod+b bolds, Mod+z undoes).
- Formatting never shows in sheet_read. With the cells still selected, the toolbar button's state in the result (Bold pressed=true) is your confirmation — do not go looking for more.
- Never click on the grid.
</sheets>

<progress>
For a task with several parts — "apply to 10 jobs", "check each of these listings" — call update_progress each time you finish or skip a part, and before you stop. Record a part as done only once a snapshot shows it succeeded (a confirmation page or message), never on the strength of the click alone. A long task may continue in a fresh round where earlier messages are gone; what you recorded is how you will know what was already done.
</progress>`;

// Injected once per resumed chat, right before the first new task. Filtered
// back out of replay() — it is a note to the model, not part of the chat.
const RESUME_NOTICE =
  "[Session resumed. The browser may have moved on since the messages " +
  "above: refs and screenshots from earlier turns are stale. Take a " +
  "fresh snapshot before acting on anything you saw before this line.]";

// Pushed when the user cancels a turn, so the next turn (and Jev's intent
// check) can tell a follow-up like "continue" means "resume that task".
// Filtered out of replay() the same way RESUME_NOTICE is.
const CANCEL_NOTICE =
  "[The user cancelled the task above before it finished. If they ask you " +
  "to continue, pick it back up from where it stopped — take a fresh " +
  "snapshot first, since the page may have moved on.]";

// How much of the chat classifyIntent sees: enough to read a short
// follow-up in context, not the whole transcript.
const INTENT_TURNS = 3;
const INTENT_TEXT_CAP = 500;

function clip(text: string): string {
  return text.length > INTENT_TEXT_CAP
    ? `${text.slice(0, INTENT_TEXT_CAP)}…`
    : text;
}

/** Whether messages[i] is the model's answer to a check-in, not something said to the user. */
function answersCheckIn(messages: Msg[], i: number): boolean {
  const prev = messages[i - 1];
  return (
    messages[i].role === "assistant" &&
    prev?.role === "user" &&
    typeof prev.content === "string" &&
    isCheckIn(prev.content)
  );
}

/** The last few turns of a transcript as classifyIntent's context: what was asked, the last reply, and whether it was cancelled. */
function earlierTurns(messages: Msg[]): EarlierTurn[] {
  const turns: EarlierTurn[] = [];
  for (const [i, m] of messages.entries()) {
    if (m.role === "user" && typeof m.content === "string") {
      if (
        m.content === RESUME_NOTICE ||
        isBrief(m.content) ||
        isSupervisorNote(m.content)
      )
        continue;
      if (m.content === CANCEL_NOTICE) {
        const last = turns.at(-1);
        if (last) last.outcome = "cancelled by the user before it finished";
        continue;
      }
      turns.push({ user: clip(m.content) });
    } else if (
      m.role === "assistant" &&
      typeof m.content === "string" &&
      m.content.trim() &&
      turns.length > 0 &&
      !answersCheckIn(messages, i)
    ) {
      turns[turns.length - 1].assistant = clip(m.content);
    }
  }
  return turns.slice(-INTENT_TURNS);
}

type Usage = { input: number; output: number; cached: number };

export type RunResult = {
  text: string;
  steps: number;
  usage: Usage;
  model: string;
};

type Active = ReturnType<typeof resolveActive>;

/** A tracked task's check-ins across one run. */
type Watch = {
  /** How many check-ins in a row found the model off course. */
  strikes: number;
  /**
   * What the model did lately, for check-ins to judge it on. Kept across
   * rounds: without the last round's actions, a fresh round's check-in
   * could not see the work its report builds on, and read it as made up.
   */
  trail: string[];
};

/** Why a check-in ended a round early. */
type Handover = {
  /** Stop for the user, rather than going on in a fresh round. */
  stop: boolean;
  /** For the user and the task file: "still off course after a correction". */
  why: string;
  /** The model's answer to the check-in — what it was doing, and what is next. */
  report: string;
  /** For the next round's brief: what went wrong, or "" when nothing did. */
  note: string;
  /** What the user is told when the task stops here. */
  message?: string;
};

/** The task on record as classifyIntent's context sees it. */
function onRecord(task: TaskState) {
  return {
    instructions: clip(task.instructions),
    later_instructions: task.followUps.map(clip),
    done_count: task.done.length,
    status:
      task.status === "done"
        ? "finished"
        : task.status === "needs_user"
          ? "waiting on the user"
          : "in progress",
  };
}

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// Some OpenAI models (e.g. gpt-6-astra) reject reasoning_effort together with
// function tools on /v1/chat/completions ("use /v1/responses or set
// reasoning_effort to 'none'"). We stay on chat/completions and always send
// tools, so for those models reasoning_effort has to stay "none" for the rest
// of the process. Learned on first failure per model, not hardcoded, since
// most models (and Ollama) are fine with "high".
const noReasoningEffort = new Set<string>();

// Models found not to take images, by label: acceptsImages could not tell,
// and the provider refused a request with a screenshot in it. From then on
// their requests go without images and their tools take none.
const noImages = new Set<string>();
const IMAGE_LEFT_OUT = "(screenshot left out — this model cannot see images)";

function hasImages(messages: Msg[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      (m.content as Array<{ type: string }>).some((p) => p.type === "image_url"),
  );
}

// OpenRouter answers some upstream failures — a free model's host rate
// limiting it, a provider erroring mid-request — with a 200 whose body is
// { error } instead of a completion. The SDK only retries and throws on
// non-2xx, so these get the same treatment here.
const EMPTY_RETRIES = 2;

/**
 * `toolChoice` "none" asks for words only (a check-in's answer). Tools are
 * still sent, so the request keeps the prefix the provider has cached.
 */
async function createCompletion(
  active: ReturnType<typeof resolveActive>,
  messages: Msg[],
  signal: AbortSignal,
  reasoningEffort: Effort = "none",
  toolChoice?: "none",
) {
  for (let attempt = 0; ; attempt++) {
    const res = await requestCompletion(active, messages, signal, reasoningEffort, toolChoice);
    if (res.choices?.length) return res;

    const error = (res as { error?: { message?: string; code?: number | string } })
      .error;
    const why = error
      ? `an error${error.code ? ` (${error.code})` : ""}: ${error.message ?? "no message"}`
      : "no choices";
    if (attempt >= EMPTY_RETRIES) {
      throw new Error(
        `${active.label} returned ${why}. Try again, or pick another model in Settings.`,
      );
    }
    console.warn(`[agent] ${active.label} returned ${why} — retrying`);
    await sleep(1000 * 2 ** attempt, undefined, { signal });
  }
}

async function requestCompletion(
  active: ReturnType<typeof resolveActive>,
  messages: Msg[],
  signal: AbortSignal,
  reasoningEffort: Effort,
  toolChoice?: "none",
) {
  const body = (effort: Effort) =>
    ({
      model: active.model,
      tools: TOOL_DEFS,
      ...(toolChoice && { tool_choice: toolChoice }),
      messages: noImages.has(active.label)
        ? stripImages(messages, IMAGE_LEFT_OUT)
        : messages,
      ...active.knobs(effort),
    }) as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

  try {
    return await active.client.chat.completions.create(
      body(noReasoningEffort.has(active.model) ? "none" : reasoningEffort),
      { signal },
    );
  } catch (err) {
    // OpenRouter: 404 "No endpoints found that support image input".
    // OpenAI: 400 "image_url is only supported by certain models".
    if (
      !noImages.has(active.label) &&
      err instanceof OpenAI.APIError &&
      (err.status === 400 || err.status === 404) &&
      /image/i.test(err.message) &&
      hasImages(messages)
    ) {
      noImages.add(active.label);
      console.warn(`[agent] ${active.label} does not take images — sending without them from now on`);
      return requestCompletion(active, messages, signal, reasoningEffort, toolChoice);
    }
    if (
      !noReasoningEffort.has(active.model) &&
      err instanceof OpenAI.APIError &&
      err.status === 400 &&
      /reasoning_effort/i.test(err.message)
    ) {
      noReasoningEffort.add(active.model);
      return active.client.chat.completions.create(body("none"), { signal });
    }
    throw err;
  }
}

const SUPERSEDED = "\n… (superseded, re-snapshot to see current state)";
const SUPERSEDED_PART = "\n… (superseded)";

/** A stale tool message with its bulk cut — or `m` itself when there is nothing left to cut. */
function pruned(m: Msg): Msg {
  if (m.role !== "tool") return m;
  const content = m.content;
  if (typeof content === "string") {
    return content.length > STALE_TEXT_CAP && !content.endsWith(SUPERSEDED)
      ? { ...m, content: `${content.slice(0, STALE_TEXT_CAP)}${SUPERSEDED}` }
      : m;
  }
  // OpenAI's types declare tool-result content as text-only; we actually
  // send images through it, so widen to what is really there.
  let changed = false;
  let hadImage = false;
  const parts = (content as unknown as ContentPart[]).flatMap<ContentPart>(
    (p) => {
      if (p.type === "image_url") {
        hadImage = changed = true;
        return [];
      }
      if (
        p.type === "text" &&
        p.text.length > STALE_TEXT_CAP &&
        !p.text.endsWith(SUPERSEDED_PART)
      ) {
        changed = true;
        return [{ ...p, text: `${p.text.slice(0, STALE_TEXT_CAP)}${SUPERSEDED_PART}` }];
      }
      return [p];
    },
  );
  if (!changed) return m;
  if (hadImage) {
    parts.push({
      type: "text",
      text: "(screenshot cleared from context — take a fresh one if needed)",
    });
  }
  return { ...m, content: parts as unknown as typeof content };
}

// Stand-in for Anthropic's clear_tool_uses_20250919, which the compat endpoint
// has no equivalent for. Without it, every superseded snapshot and screenshot
// is resent on every turn — dead page state that also tempts the model into
// reusing refs that no longer exist. Rewrites in place on a copy; the
// tool_call_id pairing is preserved, because dropping a tool message outright
// would make the request invalid.
function pruneHistory(messages: Msg[]): Msg[] {
  const toolIdx = messages.reduce<number[]>(
    (acc, m, i) => (m.role === "tool" ? (acc.push(i), acc) : acc),
    [],
  );
  const staleIdx = toolIdx.slice(0, Math.max(0, toolIdx.length - KEEP_FULL));
  const bulky = staleIdx.filter((i) => pruned(messages[i]) !== messages[i]);
  if (bulky.length < PRUNE_EVERY) return messages;
  const stale = new Set(staleIdx);
  return messages.map((m, i) => (stale.has(i) ? pruned(m) : m));
}

/**
 * Drop whole turns off the front until the transcript fits the budget.
 *
 * The cut has to land on a user message. Every other boundary risks splitting
 * an assistant message from the tool results its tool_calls demand, which the
 * API rejects — and tool results are role "tool" here, so a "user" message is
 * always the start of a turn. Not a check-in's, though: those fall mid-turn,
 * and cutting there would drop the message that set the task.
 */
function trimTurns(history: Msg[], budget: number): Msg[] {
  const starts = history.reduce<number[]>(
    (acc, m, i) =>
      m.role === "user" &&
      !(typeof m.content === "string" && isSupervisorNote(m.content))
        ? (acc.push(i), acc)
        : acc,
    [],
  );
  let out = history;
  // Never drop the turn in progress, however big it got.
  for (let cut = 1; cut < starts.length; cut++) {
    if (JSON.stringify(out).length <= budget) break;
    out = history.slice(starts[cut]);
  }
  return out;
}

/**
 * One Agent per chat, for the chat's whole lifetime — there is no more
 * process-wide "current" agent. index.ts keeps a registry keyed by chat id
 * and looks one of these up (or creates it) whenever a chat needs one.
 */
export class Agent {
  private abort: AbortController | null = null;
  private session: Session;
  // Whether the model a run started with takes images — see acceptsImages.
  private images: boolean | null = null;
  // Earlier turns describe pages that have since moved on; the model gets
  // told once, on the first task after a chat is loaded from disk.
  private resumeNoticePending: boolean;

  private constructor(session: Session) {
    this.session = session;
    this.resumeNoticePending = session.messages.length > 0;
  }

  /** A brand-new, empty chat — never resumes anything. */
  static blank(): Agent {
    return new Agent(blank(activeLabel(getConfig())));
  }

  /** The last-viewed chat (current.json), or a blank one if there is none yet. */
  static async resumeLast(): Promise<Agent> {
    return new Agent(await loadCurrent(activeLabel(getConfig())));
  }

  /** A specific past chat by id. Falls back to a blank chat under that same id if it is somehow gone. */
  static async forChat(id: string): Promise<Agent> {
    const label = activeLabel(getConfig());
    try {
      return new Agent(await loadSession(id, label));
    } catch {
      return new Agent({ ...blank(label), id });
    }
  }

  info() {
    return {
      id: this.session.id,
      turns: this.session.tasks.length,
      messages: this.session.messages.length,
      approvalMode: this.session.settings.approvalMode,
      dir: storageDir,
    };
  }

  setApprovalMode(mode: ApprovalMode): Promise<void> {
    this.session.settings.approvalMode = mode;
    return this.persist();
  }

  cancel() {
    this.abort?.abort();
  }

  /**
   * A simplified transcript of the active chat for the popup to render: what
   * was asked and the final answer to each turn. The step-by-step tool
   * actions in between are live-only (see bridge.ts emit()) and were never
   * written to disk, so a reopened or switched-to chat cannot show them —
   * only the conversation itself.
   */
  replay(): { event: string; text: string }[] {
    const out: { event: string; text: string }[] = [];
    for (const [i, m] of this.session.messages.entries()) {
      if (m.role === "user" && typeof m.content === "string") {
        if (
          m.content === RESUME_NOTICE ||
          m.content === CANCEL_NOTICE ||
          isBrief(m.content) ||
          isSupervisorNote(m.content)
        )
          continue;
        out.push({ event: "start", text: m.content });
      } else if (
        m.role === "assistant" &&
        typeof m.content === "string" &&
        m.content.trim() &&
        !answersCheckIn(this.session.messages, i)
      ) {
        out.push({ event: "say", text: m.content });
      }
    }
    return out;
  }

  async run(task: string): Promise<RunResult> {
    const abort = new AbortController();
    this.abort = abort;

    // Resolved once per run: the model a task started with sees it through,
    // even if Settings is changed while it is still working.
    const active = resolveActive(getConfig());
    this.session.model = active.label;
    const budget = await historyBudgetChars(getConfig());
    this.images = await acceptsImages(getConfig());

    if (this.resumeNoticePending) {
      this.session.messages.push({ role: "user", content: RESUME_NOTICE });
      this.resumeNoticePending = false;
    }

    // Taken before this task is pushed, so it is only the turns before it.
    const earlier = earlierTurns(this.session.messages);
    const recorded = jevEnabled ? await loadTask(this.session.id) : null;

    // A task is a turn, not a new conversation.
    this.session.messages.push({ role: "user", content: task });
    this.session.tasks.push(task);

    const usage: Usage = { input: 0, output: 0, cached: 0 };
    let steps = 0;
    let finalText = "";

    try {
      // A no-op without JEV_AI_API_KEY set. When configured, this lets a
      // greeting/thanks/aside skip the main model's "high" reasoning effort —
      // the thing making those turns feel slow when the model has to spend
      // tokens deliberating over whether there's a browser task here at all.
      // Only the first completion of the turn gets the discount: if the
      // classification was wrong and the model still emits tool_calls, every
      // completion after that reverts to full reasoning effort as normal.
      // It also says whether this message resumes the task on record.
      const intent = await classifyIntent(
        task,
        earlier,
        recorded && onRecord(recorded),
        this.session.id,
        abort.signal,
      );
      let tracked = await this.track(task, intent, recorded);

      // Round 1 sees the whole chat, so a follow-up reads in context. Each
      // later round starts from a brief instead (see progress.ts), so a long
      // task does not drag every earlier round's pages along with it.
      let from: Msg | null = null;
      let stalls = 0;
      // Check-ins hold the model to a task on record, so only a tracked one
      // gets them. Strikes carry across rounds: a fresh round that goes off
      // course again is closer to stopping, not back at the start.
      const watch: Watch | null =
        tracked && CHECK_IN_EVERY > 0 ? { strikes: 0, trail: [] } : null;
      for (let round = 1; ; round++) {
        const markBefore = tracked && progressMark(tracked);
        const r = await this.round(
          active,
          budget,
          usage,
          abort.signal,
          from,
          round === 1 && intent.greeting ? "none" : "high",
          watch,
        );
        steps += r.steps;
        if (r.text) finalText = r.text;
        if (r.cancelled) {
          return {
            text: "Cancelled by user.",
            steps,
            usage,
            model: active.label,
          };
        }
        if (!tracked) break;

        // Re-read: update_progress wrote to the file during the round.
        tracked = (await loadTask(this.session.id)) ?? tracked;
        tracked.rounds++;
        tracked.lastReport = r.handover
          ? `(Handed over at a check-in, mid-task.) ${r.handover.report}`
          : r.outOfSteps
            ? `Ran out of steps for this round (${MAX_STEPS}) before finishing.` +
              (r.text ? ` Last message: ${r.text}` : "")
            : r.text;
        tracked.supervisor = r.handover?.note ?? "";
        // A round a check-in handed over was cut short on purpose, so
        // recording nothing in it is not a stall.
        if (progressMark(tracked) !== markBefore) stalls = 0;
        else if (!r.handover) stalls++;

        const stop = await this.checkRound(
          tracked,
          round,
          stalls,
          r.handover,
          abort.signal,
        );
        await saveTask(this.session.id, tracked);
        if (abort.signal.aborted) {
          // Cancelled while Jev was judging the round: same as a cancel
          // mid-round, not a stop the check decided on.
          this.session.messages.push({ role: "user", content: CANCEL_NOTICE });
          return {
            text: "Cancelled by user.",
            steps,
            usage,
            model: active.label,
          };
        }
        if (stop) break;

        const next: Msg = { role: "user", content: brief(tracked) };
        this.session.messages.push(next);
        from = next;
      }
    } catch (err) {
      // Cancelling mid-completion rejects the request instead of reaching
      // the check at the top of the loop — the same outcome, so the same note.
      if (abort.signal.aborted) {
        this.session.messages.push({ role: "user", content: CANCEL_NOTICE });
      }
      throw err;
    } finally {
      // Every exit — finished, cancelled, or failed — saves the turn, so the
      // user's message and how it ended are never missing from the chat.
      await this.persist();
    }

    return { text: finalText, steps, usage, model: active.label };
  }

  /**
   * Which task on record, if any, this message works on — null means no
   * rounds: answer this one message and leave the record alone.
   */
  private async track(
    text: string,
    intent: Intent,
    recorded: TaskState | null,
  ): Promise<TaskState | null> {
    if (!jevEnabled || intent.greeting) return null;
    let task: TaskState;
    if (recorded && intent.scope === "resume") {
      task = {
        ...recorded,
        followUps: [...recorded.followUps, text],
        status: "active",
      };
    } else if (!recorded || intent.scope === "new_task") {
      task = newTask(text);
    } else {
      // "other" (a question about how it went, say), or Jev could not tell:
      // either way the progress on record must survive for a later "continue".
      return null;
    }
    await saveTask(this.session.id, task);
    return task;
  }

  /**
   * After a round of a tracked task: ask Jev whether it is finished, and stop
   * unless Jev is confident there is more the model can do on its own and
   * the rounds are still getting somewhere. Updates `task`'s status and
   * lastCheck in place; returns true to stop.
   */
  private async checkRound(
    task: TaskState,
    round: number,
    stalls: number,
    handover: Handover | null,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (handover) return this.handOver(task, round, handover);
    const check = await judgeCompletion(
      {
        instructions: task.instructions,
        later_instructions: task.followUps,
        done_count: task.done.length,
        done: task.done,
        skipped: task.skipped,
        note: task.note,
        last_report: task.lastReport,
      },
      this.session.id,
      signal,
    );
    if (signal.aborted) return true;

    let stop: string | null = null;
    if (!check) {
      stop = "could not check whether the task is finished";
    } else if (check.verdict === "done") {
      task.status = "done";
      stop = "task finished";
    } else if (check.verdict === "needs_user") {
      task.status = "needs_user";
      stop = "waiting on you";
    } else if (check.confidence < KEEP_GOING_MIN_CONFIDENCE) {
      stop = "not sure there is more to do";
    } else if (stalls >= MAX_STALLED_ROUNDS) {
      stop = `no progress recorded in the last ${stalls} rounds`;
    } else if (round >= MAX_ROUNDS) {
      stop = `reached the limit of ${MAX_ROUNDS} rounds`;
    }

    const verdict = check
      ? `${check.verdict.replace("_", " ")} (${check.confidence.toFixed(2)})`
      : "no verdict";
    task.lastCheck =
      `Round ${task.rounds}: ${verdict} — ` +
      (stop ? `stopped: ${stop}` : "continuing");
    emit(
      "task-check",
      this.session.id,
      `${task.done.length} done, ${task.skipped.length} skipped · ${verdict} · ` +
        (stop
          ? `stopping: ${stop}`
          : `starting round ${round + 1} with a fresh context`),
    );
    return stop !== null;
  }

  /**
   * A check-in partway through a round of a tracked task: the model says
   * what it is doing and how, Jev judges that and the actions behind it
   * against the user's instructions, and the model is told to carry on or
   * how it went wrong. Returns a Handover when the round should end here
   * instead — for a fresh context, or to stop for the user.
   */
  private async checkIn(
    active: Active,
    budget: number,
    usage: Usage,
    signal: AbortSignal,
    from: Msg | null,
    step: number,
    watch: Watch,
  ): Promise<Handover | null> {
    const task = await loadTask(this.session.id);
    if (!task) return null;
    const start = from ? Math.max(0, this.session.messages.indexOf(from)) : 0;
    const ask: Msg = { role: "user", content: checkInPrompt(task, step) };

    let report: string;
    try {
      const res = await createCompletion(
        active,
        [{ role: "system", content: SYSTEM }, ...this.session.messages.slice(start), ask],
        signal,
        "none",
        "none",
      );
      usage.input += res.usage?.prompt_tokens ?? 0;
      usage.output += res.usage?.completion_tokens ?? 0;
      usage.cached += res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      report = res.choices[0]!.message.content?.trim() || "(no answer)";
    } catch (err) {
      if (signal.aborted) throw err;
      // A check-in that fails costs the check, not the task.
      console.warn(`[agent] check-in failed: ${String(err)}`);
      return null;
    }
    // Only the words are kept. A model that calls tools anyway (Ollama
    // ignores tool_choice) has those calls dropped, never run.
    this.session.messages.push(ask, { role: "assistant", content: report });
    emit("check-in", this.session.id, report);

    const verdict = await superviseTask(
      {
        user_instructions: [task.instructions, ...task.followUps],
        progress_recorded: { done: task.done, skipped: task.skipped, note: task.note },
        agent_report: report.slice(0, CHECK_IN_REPORT_CAP),
        recent_actions: watch.trail,
      },
      this.session.id,
      signal,
    );
    if (signal.aborted) return null;

    const drift = verdict?.drift ?? null;
    if (verdict) watch.strikes = drift ? watch.strikes + 1 : 0;
    const chars = JSON.stringify(this.session.messages.slice(start)).length;
    const crowded = chars > Math.min(FRESH_CONTEXT_TOKENS * 4, budget * 0.75);
    const note = drift ? briefNote(drift) : "";

    let handover: Handover | null = null;
    if (drift && watch.strikes >= MAX_STRIKES) {
      const why = `still off course after ${MAX_STRIKES} check-ins in a row — ${driftSummary(drift)}`;
      // The report is quoted as the model's own account, not as where
      // things stand — the supervisor may have just judged it untrue.
      const message =
        `I've stopped here: the supervisor found me off course at ${MAX_STRIKES} ` +
        `check-ins in a row, even after corrections and a fresh start — ` +
        `${driftSummary(drift)}.\n\nMy last check-in said: "${report}"\n\n` +
        `Tell me how you'd like me to go on.`;
      this.session.messages.push(
        { role: "user", content: feedback(drift, true) },
        { role: "assistant", content: message },
      );
      emit("say", this.session.id, message);
      handover = { stop: true, why, report, note, message };
    } else if (drift && watch.strikes % 2 === 0) {
      handover = { stop: false, why: "still off course after a correction", report, note };
    } else if (crowded) {
      handover = {
        stop: false,
        why: `context past ~${Math.round(chars / 4000)}k tokens`,
        report,
        note,
      };
    }

    const verdictText = !verdict
      ? "no verdict"
      : !drift
        ? `on course (${verdict.p.toFixed(2)})`
        : `off course: ${driftSummary(drift)} (` +
          (drift === "overclaims"
            ? `p(overclaims) ${verdict.overclaims.toFixed(2)})`
            : `p(on course) ${verdict.p.toFixed(2)})`);
    emit(
      "supervisor",
      this.session.id,
      `${verdictText} · ` +
        (handover
          ? handover.stop
            ? "stopping"
            : "handing over to a fresh round"
          : drift
            ? "told it to get back on track"
            : "carrying on"),
    );
    if (handover) return handover;

    this.session.messages.push({ role: "user", content: feedback(drift, verdict !== null) });
    await this.persist();
    return null;
  }

  /**
   * checkRound for a round a check-in ended: the model was mid-task, so
   * there is no finished round for judgeCompletion to judge — only the
   * check-in's own call, and the round limit.
   */
  private handOver(task: TaskState, round: number, handover: Handover): boolean {
    let stop: string | null = null;
    if (handover.stop) {
      task.status = "needs_user";
      stop = handover.why;
    } else if (round >= MAX_ROUNDS) {
      stop = `reached the limit of ${MAX_ROUNDS} rounds`;
    }
    task.lastCheck =
      `Round ${task.rounds}: check-in — ` +
      (stop ? `stopped: ${stop}` : `${handover.why} — continuing in a fresh round`);
    emit(
      "task-check",
      this.session.id,
      `${task.done.length} done, ${task.skipped.length} skipped · ` +
        (stop
          ? `stopping: ${stop}`
          : `${handover.why} · starting round ${round + 1} with a fresh context`),
    );
    return stop !== null;
  }

  /**
   * One round: completions and tool calls until the model stops calling
   * tools, runs out of steps, the user cancels, or a check-in hands over.
   * `from` is where this round's context starts — null for the whole chat,
   * or a fresh round's brief, so nothing before it is sent. `watch`, for a
   * tracked task, turns on check-ins.
   */
  private async round(
    active: Active,
    budget: number,
    usage: Usage,
    signal: AbortSignal,
    from: Msg | null,
    firstEffort: Effort,
    watch: Watch | null,
  ): Promise<{
    steps: number;
    text: string;
    cancelled: boolean;
    outOfSteps: boolean;
    handover: Handover | null;
  }> {
    let steps = 0;
    let text = "";
    const logAction = (entry: string) => {
      if (!watch) return;
      watch.trail.push(entry);
      watch.trail.splice(0, watch.trail.length - TRAIL_LENGTH);
    };

    while (steps < MAX_STEPS) {
      if (signal.aborted) {
        this.session.messages.push({ role: "user", content: CANCEL_NOTICE });
        return { steps, text, cancelled: true, outOfSteps: false, handover: null };
      }
      steps++;

      this.session.messages = trimTurns(
        pruneHistory(this.session.messages),
        budget,
      );
      // trimTurns never drops the turn in progress, and a brief starts one,
      // so `from` is always still there — both keep message identity.
      const start = from ? Math.max(0, this.session.messages.indexOf(from)) : 0;
      // The system prompt is a frozen constant and is never stored, so it is
      // prepended per request rather than kept in the transcript.
      const messages: Msg[] = [
        { role: "system", content: SYSTEM },
        ...this.session.messages.slice(start),
      ];

      const res = await createCompletion(
        active,
        messages,
        signal,
        steps === 1 ? firstEffort : "high",
      );

      usage.input += res.usage?.prompt_tokens ?? 0;
      usage.output += res.usage?.completion_tokens ?? 0;
      usage.cached += res.usage?.prompt_tokens_details?.cached_tokens ?? 0;

      // createCompletion never returns without a choice.
      const msg = res.choices[0]!.message;

      this.session.messages.push(msg);

      // Non-standard field: Ollama surfaces thinking-model output here rather
      // than in content. Shown to the user, never fed back to the model.
      const reasoning = (msg as { reasoning?: string }).reasoning;
      if (reasoning?.trim()) emit("think", this.session.id, reasoning);

      if (msg.content?.trim()) {
        text = msg.content;
        emit("say", this.session.id, msg.content);
      }

      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) {
        return { steps, text, cancelled: false, outOfSteps: false, handover: null };
      }

      for (const c of calls) {
        // The compat endpoint only emits function calls, but the union in the
        // SDK also covers custom tools.
        if (c.type !== "function") {
          this.session.messages.push({
            role: "tool",
            tool_call_id: c.id,
            content: `Unsupported tool call type "${c.type}".`,
          });
          continue;
        }
        const tool = TOOL_BY_NAME.get(c.function.name);
        if (!tool) {
          this.session.messages.push({
            role: "tool",
            tool_call_id: c.id,
            content: `No such tool "${c.function.name}".`,
          });
          continue;
        }
        let input: unknown;
        let label: string | null = null;
        try {
          // Local models emit malformed argument JSON often enough that this
          // has to be a normal tool error the model can read and retry, not a
          // crash of the run.
          try {
            input = c.function.arguments
              ? JSON.parse(c.function.arguments)
              : {};
          } catch {
            throw new Error(
              `Arguments were not valid JSON: ${c.function.arguments}. Re-issue the call with valid JSON.`,
            );
          }
          const missing = missingArgs(tool.def, input);
          if (missing) throw new Error(missing);
          // Named now: the call's result replaces the snapshot it names from.
          const ref = (input as { ref?: unknown }).ref;
          if (typeof ref === "string") label = refLabel(this.session.id, ref);
          const ctx: ToolCtx = {
            chatId: this.session.id,
            approvalMode: this.session.settings.approvalMode,
            signal,
            userMessages: this.session.tasks,
            answers: this.session.answers,
            chatStartedAt: this.session.createdAt,
            seesImages: this.images !== false && !noImages.has(active.label),
          };
          const out: ToolResult = await tool.run(input, ctx);
          this.session.messages.push({
            role: "tool",
            tool_call_id: c.id,
            content: out as any,
          });
          logAction(describeAction(c.function.name, input, label, out));
        } catch (err) {
          // Failures are values, not exceptions. A stale ref or a timeout is
          // recoverable and the model handles it well when it can see it.
          const text = String((err as Error)?.message ?? err);
          emit("tool-error", this.session.id, `${c.function.name}: ${text}`);
          this.session.messages.push({
            role: "tool",
            tool_call_id: c.id,
            content: `Error: ${text}`,
          });
          logAction(describeAction(c.function.name, input, label, new Error(text)));
        }
      }

      // Written every step, so an interrupted run still leaves a resumable
      // chat rather than losing the whole turn.
      await this.persist();

      if (watch && steps % CHECK_IN_EVERY === 0 && steps < MAX_STEPS) {
        const handover = await this.checkIn(
          active, budget, usage, signal, from, steps, watch,
        );
        if (handover) {
          if (handover.message) text = handover.message;
          return { steps, text, cancelled: false, outOfSteps: false, handover };
        }
      }
    }

    return {
      steps,
      text: text || `Stopped after ${MAX_STEPS} steps without finishing.`,
      cancelled: false,
      outOfSteps: true,
      handover: null,
    };
  }

  private async persist() {
    try {
      await save(this.session);
    } catch (err) {
      // A failed write must not take the run down with it.
      console.error(`[session] could not save transcript: ${String(err)}`);
    }
  }
}

export function formatUsage(r: Pick<RunResult, "usage" | "model">): string {
  return `in ${r.usage.input} (cached ${r.usage.cached}) · out ${r.usage.output} · ${r.model}`;
}

/** Every saved chat, newest first, flagged with which ones are running right now. */
export async function listChats(
  runningIds: Set<string>,
): Promise<(SessionSummary & { running: boolean })[]> {
  const chats = await listSessions();
  // A chat with nothing said in it yet is not worth its own history entry —
  // unless it is somehow already running (defensive; practically never true,
  // since a task pushes its own text into `tasks` before the run starts).
  return chats
    .filter((s) => s.taskCount > 0 || runningIds.has(s.id))
    .map((s) => ({ ...s, running: runningIds.has(s.id) }));
}

/** Human-readable label for whatever provider/model Settings currently point at. */
export function activeModelLabel(): string {
  return activeLabel(getConfig());
}
