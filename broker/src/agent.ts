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
import {
  emit,
  newRequestId,
  TimeUp,
  type ApprovalOutcome,
  type AskOutcome,
  type PendingRequest,
} from "./bridge.js";
import {
  APPROVAL_DENIED,
  askResult,
  missingArgs,
  PauseForUser,
  refLabel,
  TOOL_DEFS,
  TOOL_BY_NAME,
  type ToolCtx,
  type ToolResult,
  type ContentPart,
  type UserRequest,
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
import { splitTaskMessage, taskMessage, type TaskExtras } from "./task-extras.js";
import {
  blank,
  listSessions,
  loadCurrent,
  loadSession,
  save,
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
// Running as the hosted CopperOS (its Lambdas set STAGE), where users have
// no .env and no Ollama of their own.
const HOSTED = Boolean(process.env.STAGE);

function resolveActive(cfg: LLMConfig) {
  if (cfg.provider === "openai") {
    if (!cfg.openai.apiKey) {
      throw new Error(
        HOSTED
          ? "No OpenAI API key set. Add yours in Settings, or choose OpenRouter."
          : "No OpenAI API key set. Add one in Settings, or switch the provider back to Ollama.",
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
        HOSTED
          ? "No OpenRouter API key set. Add yours in Settings."
          : "No OpenRouter API key set. Add one in Settings or as OPENROUTER_API_KEY in broker/.env.",
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

// Pushed when a task stops at its time limit, for the same reason as
// CANCEL_NOTICE, and filtered out of replay() the same way.
const TIME_UP_NOTICE =
  "[The task above stopped at its time limit before it finished. If the " +
  "user asks you to continue, pick it back up from where it stopped — take " +
  "a fresh snapshot first, since the page may have moved on.]";

// How long before a time limit no new step starts, so the one in progress
// can finish and the turn be saved. A quarter of the limit, if that is less.
const FINISH_MS = 30_000;

/**
 * A task's time limit, across the runs a pause splits it into — time spent
 * waiting on the person never counts. Past the margin before the limit no
 * new step starts; at the limit itself, whatever is still in flight is
 * stopped (the run's signal aborts with TimeUp), so the turn is saved
 * cleanly rather than cut off.
 */
class Clock {
  private readonly start = Date.now();
  private readonly timer: NodeJS.Timeout | null = null;
  // When whatever is still in flight gets stopped, or null for never.
  private readonly hardAt: number | null;
  private readonly margin: number = 0;
  timedOut = false;

  constructor(
    private readonly usedBefore: number,
    limitMs: number | null,
    abort: AbortController,
    endBy: number | null = null,
  ) {
    const byLimit = limitMs === null ? null : this.start + limitMs - usedBefore;
    this.hardAt =
      byLimit === null ? endBy : endBy === null ? byLimit : Math.min(byLimit, endBy);
    if (this.hardAt === null) return;
    this.margin = Math.min(FINISH_MS, (limitMs ?? this.hardAt - this.start) / 4);
    this.timer = setTimeout(() => {
      this.timedOut = true;
      abort.abort(new TimeUp());
    }, Math.max(0, this.hardAt - this.start));
  }

  /** Active time spent on the task so far, this run included. */
  used(): number {
    return this.usedBefore + (Date.now() - this.start);
  }

  /** Whether it is too late to start another step. */
  late(): boolean {
    return this.hardAt !== null && Date.now() >= this.hardAt - this.margin;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}

/**
 * A run's time limits. `limitMs` is the task's, in ms of active time across
 * its pauses; `endBy` is when this run itself must have stopped (epoch ms) —
 * a Lambda's own deadline. Null or absent means none.
 */
/** A task's supervisor rules as one more thing the user said, for Jev. */
function rulesLine(task: TaskState): string[] {
  return task.rules ? [`Rules the user set for this task: ${task.rules}`] : [];
}

/** A run's time limit, and for a new task, what comes with it (task-extras.ts). */
export type RunOptions = { limitMs?: number | null; endBy?: number | null } & TaskExtras;

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
      if (m.content === TIME_UP_NOTICE) {
        const last = turns.at(-1);
        if (last) last.outcome = "stopped at its time limit before it finished";
        continue;
      }
      turns.push({ user: clip(splitTaskMessage(m.content).text) });
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
  /** Set when the run stopped to wait on the person; resume() carries it on. */
  paused?: PendingRequest;
  /** Set when the task stopped at its time limit. */
  timeUp?: boolean;
  /** Active time spent on the task so far, across its pauses. */
  timeUsedMs?: number;
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

/**
 * Where a turn's rounds stand. Lives on the stack while a run goes, and is
 * saved with the chat when the turn pauses (session.ts's Paused) so resuming
 * carries on from the same round and step.
 */
type Loop = {
  round: number;
  /** Steps taken in this round. */
  step: number;
  /** Steps taken in the whole turn. */
  steps: number;
  stalls: number;
  /** progressMark at the start of this round, or false for an untracked turn. */
  markBefore: string | false;
  tracked: TaskState | null;
  watch: Watch | null;
  /** Where this round's context starts: null for the whole chat, or a fresh round's brief. */
  from: Msg | null;
  finalText: string;
};

type ToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;

/** A call waiting on the person: which one, and what for. */
type Waiting = { callId: string; request: UserRequest };

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
    later_instructions: [...task.followUps, ...rulesLine(task)].map(clip),
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
  // The running run's time limit, if it has one.
  private clock: Clock | null = null;
  private readonly userId: string;
  private session: Session;
  // Whether the model a run started with takes images — see acceptsImages.
  private images: boolean | null = null;
  // Whether the running turn's work is about jobs — see classifyIntent.
  private jobTask = true;
  // The rules the user set for the supervisor on the task in hand, if any —
  // what the user said, as far as Jev's judgments go.
  private rules: string | null = null;
  // Earlier turns describe pages that have since moved on; the model gets
  // told once, on the first task after a chat is loaded from disk.
  private resumeNoticePending: boolean;

  private constructor(userId: string, session: Session) {
    this.userId = userId;
    this.session = session;
    this.resumeNoticePending = session.messages.length > 0;
  }

  /** A brand-new, empty chat — never resumes anything. */
  static blank(userId: string): Agent {
    return new Agent(userId, blank(activeLabel(getConfig(userId))));
  }

  /** The last-viewed chat, or a blank one if there is none yet. */
  static async resumeLast(userId: string): Promise<Agent> {
    return new Agent(userId, await loadCurrent(userId, activeLabel(getConfig(userId))));
  }

  /** A specific past chat by id. Falls back to a blank chat under that same id if it is somehow gone. */
  static async forChat(userId: string, id: string): Promise<Agent> {
    const label = activeLabel(getConfig(userId));
    try {
      return new Agent(userId, await loadSession(userId, id, label));
    } catch {
      return new Agent(userId, { ...blank(label), id });
    }
  }

  info() {
    return {
      id: this.session.id,
      turns: this.session.tasks.length,
      messages: this.session.messages.length,
      approvalMode: this.session.settings.approvalMode,
      lastTask: this.session.tasks.at(-1) ?? null,
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
          m.content === TIME_UP_NOTICE ||
          isBrief(m.content) ||
          isSupervisorNote(m.content)
        )
          continue;
        const { text, rules } = splitTaskMessage(m.content);
        out.push({ event: "start", text });
        if (rules) out.push({ event: "rules", text: rules });
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

  async run(task: string, options: RunOptions = {}): Promise<RunResult> {
    const { abort, active, budget } = await this.begin();
    this.clock = new Clock(0, options.limitMs ?? null, abort, options.endBy ?? null);

    if (this.resumeNoticePending) {
      this.session.messages.push({ role: "user", content: RESUME_NOTICE });
      this.resumeNoticePending = false;
    }

    // Taken before this task is pushed, so it is only the turns before it.
    const earlier = earlierTurns(this.session.messages);
    const recorded = jevEnabled ? await loadTask(this.userId, this.session.id) : null;

    // A task is a turn, not a new conversation.
    this.session.messages.push({ role: "user", content: taskMessage(task, options) });
    this.session.tasks.push(task);

    const usage: Usage = { input: 0, output: 0, cached: 0 };
    let loop: Loop | null = null;

    try {
      // A no-op without JEV_AI_API_KEY set. When configured, this lets a
      // greeting/thanks/aside skip the main model's "high" reasoning effort —
      // the thing making those turns feel slow when the model has to spend
      // tokens deliberating over whether there's a browser task here at all.
      // Only the first completion of the turn gets the discount: if the
      // classification was wrong and the model still emits tool_calls, every
      // completion after that reverts to full reasoning effort as normal.
      // It also says whether this message resumes the task on record, and
      // whether the work is about jobs, which is all job checks run on.
      const intent = await classifyIntent(
        task,
        earlier,
        recorded && onRecord(recorded),
        this.session.id,
        abort.signal,
      );
      this.jobTask = intent.jobs;
      const tracked = await this.track(task, intent, recorded, options.rules ?? null);
      this.rules = tracked?.rules ?? options.rules ?? null;

      loop = {
        round: 1,
        step: 0,
        steps: 0,
        stalls: 0,
        markBefore: false,
        tracked,
        // Check-ins hold the model to a task on record, so only a tracked one
        // gets them. Strikes carry across rounds: a fresh round that goes off
        // course again is closer to stopping, not back at the start.
        watch: tracked && CHECK_IN_EVERY > 0 ? { strikes: 0, trail: [] } : null,
        from: null,
        finalText: "",
      };
      return await this.drive(
        active,
        budget,
        usage,
        abort.signal,
        loop,
        intent.greeting ? "none" : "high",
      );
    } catch (err) {
      // Cancelling mid-completion rejects the request instead of reaching
      // the check at the top of the loop — the same outcome, so the same note.
      if (this.clock.timedOut) return await this.timeUp(loop, usage, active, true);
      if (abort.signal.aborted) {
        this.session.messages.push({ role: "user", content: CANCEL_NOTICE });
      }
      throw err;
    } finally {
      this.clock.stop();
      // Every exit — finished, paused, cancelled, or failed — saves the turn,
      // so the user's message and how it ended are never missing from the chat.
      await this.persist();
    }
  }

  /**
   * Carry on a paused task with the person's answer. The call that waited
   * gets its result — the form's answers, the approved action actually run,
   * or a denial — then the rest of its step runs, and the turn goes on from
   * the round and step it paused at, as if it never stopped.
   */
  async resume(
    requestId: string,
    answer: ApprovalOutcome | AskOutcome,
    options: RunOptions = {},
  ): Promise<RunResult> {
    const paused = this.session.paused;
    if (!paused || paused.request.id !== requestId) {
      throw new Error(`chat ${this.session.id} is not waiting on ${requestId}`);
    }
    const isApproval = answer === "approved" || answer === "denied";
    if (isApproval !== (paused.request.kind === "approval")) {
      throw new Error(`a ${paused.request.kind} request cannot take that answer`);
    }

    // Claimed before anything is awaited, so the same answer arriving twice
    // finds nothing waiting the second time.
    this.session.paused = undefined;
    let setup: Awaited<ReturnType<Agent["begin"]>>;
    try {
      setup = await this.begin();
    } catch (err) {
      this.session.paused = paused;
      throw err;
    }
    const { abort, active, budget } = setup;
    // Waiting on the person did not count against the limit; the time before it did.
    this.clock = new Clock(
      paused.loop.timeUsedMs ?? 0,
      options.limitMs ?? null,
      abort,
      options.endBy ?? null,
    );
    const usage: Usage = { input: 0, output: 0, cached: 0 };
    this.jobTask = paused.loop.jobTask;
    // The task file may be gone (deleted by hand); carry on untracked then.
    const tracked = paused.loop.tracked ? await loadTask(this.userId, this.session.id) : null;
    this.rules = tracked?.rules ?? null;
    const loop: Loop = {
      ...paused.loop,
      tracked,
      watch: tracked ? paused.loop.watch : null,
      // A fresh round's context starts at its brief — the latest one, since
      // briefs are only ever pushed at the start of a round.
      from: paused.loop.round > 1 ? this.lastBrief() : null,
    };

    try {
      const [waiting, ...rest] = this.openCalls(paused.callId);
      const again = await this.answerCall(waiting, paused.request, answer, active, abort.signal, loop);
      if (again) {
        return {
          text: loop.finalText,
          steps: loop.steps,
          usage,
          model: active.label,
          paused: this.pause(again, loop),
          timeUsedMs: this.clock.used(),
        };
      }
      return await this.drive(active, budget, usage, abort.signal, loop, "high", rest);
    } catch (err) {
      if (this.clock.timedOut) return await this.timeUp(loop, usage, active, true);
      if (abort.signal.aborted) {
        this.session.messages.push({ role: "user", content: CANCEL_NOTICE });
      }
      throw err;
    } finally {
      this.clock.stop();
      await this.persist();
    }
  }

  /** What this chat's task is waiting on the person for, if it is paused. */
  waitingOn(): PendingRequest | null {
    return this.session.paused?.request ?? null;
  }

  /**
   * Cancel a paused task. Its waiting calls are answered as cancelled — what a
   * cancel mid-run leaves behind — so the chat can take a new task. Returns
   * the request it was waiting on, or null if it was not paused.
   */
  async cancelPause(): Promise<PendingRequest | null> {
    const paused = this.session.paused;
    if (!paused) return null;
    this.session.paused = undefined;
    for (const c of this.openCalls(paused.callId)) {
      this.session.messages.push({ role: "tool", tool_call_id: c.id, content: "Error: Cancelled by user." });
    }
    this.session.messages.push({ role: "user", content: CANCEL_NOTICE });
    await this.persist();
    return paused.request;
  }

  /** Per-run setup: a fresh abort signal, and the model resolved once for the whole run. */
  private async begin() {
    const abort = new AbortController();
    this.abort = abort;

    // Resolved once per run: the model a task started with sees it through,
    // even if Settings is changed while it is still working.
    const config = getConfig(this.userId);
    const active = resolveActive(config);
    this.session.model = active.label;
    const budget = await historyBudgetChars(config);
    this.images = await acceptsImages(config);
    return { abort, active, budget };
  }

  /**
   * The turn's rounds, from wherever `loop` stands — a new turn, or a paused
   * one resuming. `resumed` is the rest of the step a pause interrupted: calls
   * still to run before the next completion.
   */
  private async drive(
    active: Active,
    budget: number,
    usage: Usage,
    signal: AbortSignal,
    loop: Loop,
    firstEffort: Effort,
    resumed?: ToolCall[],
  ): Promise<RunResult> {
    const result = (text: string, paused?: PendingRequest): RunResult => ({
      text,
      steps: loop.steps,
      usage,
      model: active.label,
      timeUsedMs: this.clock?.used() ?? 0,
      ...(paused ? { paused } : {}),
    });

    // Round 1 sees the whole chat, so a follow-up reads in context. Each
    // later round starts from a brief instead (see progress.ts), so a long
    // task does not drag every earlier round's pages along with it.
    for (; ; loop.round++) {
      if (!resumed) {
        loop.step = 0;
        loop.markBefore = loop.tracked ? progressMark(loop.tracked) : false;
      }
      const r = await this.round(
        active,
        budget,
        usage,
        signal,
        loop,
        loop.round === 1 ? firstEffort : "high",
        resumed,
      );
      resumed = undefined;
      if (r.text) loop.finalText = r.text;
      if (r.waiting) return result(loop.finalText, this.pause(r.waiting, loop));
      if (r.timeUp) return this.timeUp(loop, usage, active, true);
      if (r.cancelled) return result("Cancelled by user.");
      if (!loop.tracked) break;

      // Re-read: update_progress wrote to the file during the round.
      const tracked = (await loadTask(this.userId, this.session.id)) ?? loop.tracked;
      loop.tracked = tracked;
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
      if (progressMark(tracked) !== loop.markBefore) loop.stalls = 0;
      else if (!r.handover) loop.stalls++;

      const stop = await this.checkRound(
        tracked,
        loop.round,
        loop.stalls,
        r.handover,
        signal,
      );
      await saveTask(this.userId, this.session.id, tracked);
      if (this.clock?.timedOut) return this.timeUp(loop, usage, active, false);
      if (signal.aborted) {
        // Cancelled while Jev was judging the round: same as a cancel
        // mid-round, not a stop the check decided on.
        this.session.messages.push({ role: "user", content: CANCEL_NOTICE });
        return result("Cancelled by user.");
      }
      if (stop) break;
      if (this.clock?.late()) return this.timeUp(loop, usage, active, false);

      const next: Msg = { role: "user", content: brief(tracked) };
      this.session.messages.push(next);
      loop.from = next;
    }

    return result(loop.finalText);
  }

  /**
   * Save the turn as waiting on the person, and say what for. The run ends
   * here; the caller shows the request, and the answer comes to resume().
   */
  private pause(waiting: Waiting, loop: Loop): PendingRequest {
    const id = newRequestId(this.session.id);
    const chatId = this.session.id;
    const request: PendingRequest =
      waiting.request.kind === "approval"
        ? { id, chatId, kind: "approval", text: waiting.request.text }
        : { id, chatId, kind: "ask", ask: waiting.request.ask };
    this.session.paused = {
      request,
      callId: waiting.callId,
      at: new Date().toISOString(),
      loop: {
        round: loop.round,
        step: loop.step,
        steps: loop.steps,
        stalls: loop.stalls,
        markBefore: loop.markBefore,
        tracked: loop.tracked !== null,
        watch: loop.watch,
        jobTask: this.jobTask,
        finalText: loop.finalText,
        timeUsedMs: this.clock?.used() ?? 0,
      },
    };
    return request;
  }

  /**
   * End the turn at its time limit: noted in the transcript so "continue"
   * picks it up, and recorded on a tracked task — `midRound` when the round
   * it was in never finished, so it counts as a round cut short.
   */
  private async timeUp(
    loop: Loop | null,
    usage: Usage,
    active: Active,
    midRound: boolean,
  ): Promise<RunResult> {
    this.session.messages.push({ role: "user", content: TIME_UP_NOTICE });
    const task = loop?.tracked ? await loadTask(this.userId, this.session.id) : null;
    if (task) {
      if (midRound) {
        task.rounds++;
        task.lastReport =
          "Stopped at the time limit partway through this round." +
          (loop!.finalText ? ` Last message: ${loop!.finalText}` : "");
      }
      task.lastCheck = `Round ${task.rounds}: stopped: time limit`;
      await saveTask(this.userId, this.session.id, task);
    }
    const minutes = Math.round((this.clock?.used() ?? 0) / 60_000);
    return {
      text:
        `Stopped after ${minutes ? `${minutes} minutes` : "less than a minute"} of work, the most one run can take` +
        (task ? ` — ${task.done.length} done, ${task.skipped.length} skipped so far` : "") +
        `. Say "continue" and it picks up where it left off.`,
      steps: loop?.steps ?? 0,
      usage,
      model: active.label,
      timeUp: true,
      timeUsedMs: this.clock?.used() ?? 0,
    };
  }

  /** The call a paused turn waits on, then the calls after it in its step that have not run yet. */
  private openCalls(callId: string): ToolCall[] {
    const msgs = this.session.messages;
    const i = msgs.findLastIndex(
      (m) => m.role === "assistant" && (m.tool_calls ?? []).some((c) => c.id === callId),
    );
    if (i === -1) throw new Error(`the paused call ${callId} is missing from the transcript`);
    const calls = (msgs[i] as Extract<Msg, { role: "assistant" }>).tool_calls!;
    const answered = new Set(
      msgs.slice(i + 1).flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : [])),
    );
    return calls.slice(calls.findIndex((c) => c.id === callId)).filter((c) => !answered.has(c.id));
  }

  /** The latest fresh round's brief in the transcript. */
  private lastBrief(): Msg | null {
    return (
      this.session.messages.findLast(
        (m) => m.role === "user" && typeof m.content === "string" && isBrief(m.content),
      ) ?? null
    );
  }

  /**
   * The waiting call's result, from the person's answer. An approved action
   * is run for real, past its gate; anything else is answered in place.
   * Returns a new wait only if running the approved action asked again.
   */
  private async answerCall(
    call: ToolCall,
    request: PendingRequest,
    answer: ApprovalOutcome | AskOutcome,
    active: Active,
    signal: AbortSignal,
    loop: Loop,
  ): Promise<Waiting | null> {
    if (answer === "approved") return this.runCalls([call], active, signal, loop, true);
    if (call.type !== "function") throw new Error(`the paused call ${call.id} is not a function call`);

    let input: unknown = {};
    try {
      input = JSON.parse(call.function.arguments || "{}");
    } catch {
      // It parsed when the call first ran; nothing to recover here.
    }
    let content: string;
    try {
      content =
        request.kind === "approval"
          ? APPROVAL_DENIED
          : await askResult(input, answer as AskOutcome, this.toolCtx(active, signal));
    } catch (err) {
      content = `Error: ${String((err as Error)?.message ?? err)}`;
    }
    this.session.messages.push({ role: "tool", tool_call_id: call.id, content });
    this.logAction(loop, describeAction(call.function.name, input, null, content));
    return null;
  }

  private toolCtx(active: Active, signal: AbortSignal, preApproved = false): ToolCtx {
    return {
      userId: this.userId,
      chatId: this.session.id,
      approvalMode: this.session.settings.approvalMode,
      signal,
      userMessages: this.rules
        ? [...this.session.tasks, `Rules I set for this task: ${this.rules}`]
        : this.session.tasks,
      answers: this.session.answers,
      chatStartedAt: this.session.createdAt,
      seesImages: this.images !== false && !noImages.has(active.label),
      jobTask: this.jobTask,
      ...(preApproved ? { preApproved } : {}),
    };
  }

  /** What the model did, for check-ins to judge it on — kept only for a watched turn. */
  private logAction(loop: Loop, entry: string): void {
    if (!loop.watch) return;
    loop.watch.trail.push(entry);
    loop.watch.trail.splice(0, loop.watch.trail.length - TRAIL_LENGTH);
  }

  /**
   * Which task on record, if any, this message works on — null means no
   * rounds: answer this one message and leave the record alone.
   */
  private async track(
    text: string,
    intent: Intent,
    recorded: TaskState | null,
    rules: string | null,
  ): Promise<TaskState | null> {
    if (!jevEnabled) return null;
    // Rules for the supervisor mean the user wants this watched, whatever
    // the message looks like.
    if (intent.greeting && !rules) return null;
    let task: TaskState;
    if (recorded && intent.scope === "resume") {
      task = {
        ...recorded,
        followUps: [...recorded.followUps, text],
        status: "active",
        // New rules replace the old; none sent keeps what was set.
        ...(rules ? { rules } : {}),
      };
    } else if (!recorded || intent.scope === "new_task" || rules) {
      task = { ...newTask(text), ...(rules ? { rules } : {}) };
    } else {
      // "other" (a question about how it went, say), or Jev could not tell:
      // either way the progress on record must survive for a later "continue".
      return null;
    }
    await saveTask(this.userId, this.session.id, task);
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
        later_instructions: [...task.followUps, ...rulesLine(task)],
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
    const task = await loadTask(this.userId, this.session.id);
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
        user_instructions: [task.instructions, ...task.followUps, ...rulesLine(task)],
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
   * tools, runs out of steps, the user cancels, a check-in hands over, or a
   * call has to wait on the person. `loop.from` is where this round's context
   * starts — null for the whole chat, or a fresh round's brief, so nothing
   * before it is sent; `loop.watch`, for a tracked task, turns on check-ins.
   * `resumed` carries on the step a pause interrupted: the rest of its calls,
   * then its check-in, then on as normal.
   */
  private async round(
    active: Active,
    budget: number,
    usage: Usage,
    signal: AbortSignal,
    loop: Loop,
    firstEffort: Effort,
    resumed?: ToolCall[],
  ): Promise<{
    text: string;
    cancelled: boolean;
    outOfSteps: boolean;
    handover: Handover | null;
    waiting: Waiting | null;
    timeUp: boolean;
  }> {
    let text = "";
    const ended = { cancelled: false, outOfSteps: false, handover: null, waiting: null, timeUp: false };
    let pending = resumed ?? null;

    while (pending || loop.step < MAX_STEPS) {
      let calls: ToolCall[];
      if (pending) {
        calls = pending;
        pending = null;
      } else {
        // The time limit, whether it stopped something in flight or is just
        // too close to start another step. drive() notes it.
        if (this.clock?.timedOut || this.clock?.late()) return { ...ended, text, timeUp: true };
        if (signal.aborted) {
          this.session.messages.push({ role: "user", content: CANCEL_NOTICE });
          return { ...ended, text, cancelled: true };
        }
        loop.step++;
        loop.steps++;

        this.session.messages = trimTurns(
          pruneHistory(this.session.messages),
          budget,
        );
        // trimTurns never drops the turn in progress, and a brief starts one,
        // so `from` is always still there — both keep message identity.
        const start = loop.from ? Math.max(0, this.session.messages.indexOf(loop.from)) : 0;
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
          loop.step === 1 ? firstEffort : "high",
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

        calls = msg.tool_calls ?? [];
        if (calls.length === 0) return { ...ended, text };
      }

      const waiting = await this.runCalls(calls, active, signal, loop);
      if (waiting) return { ...ended, text, waiting };

      // Written every step, so an interrupted run still leaves a resumable
      // chat rather than losing the whole turn.
      await this.persist();

      if (
        loop.watch &&
        loop.step % CHECK_IN_EVERY === 0 &&
        loop.step < MAX_STEPS &&
        !this.clock?.late()
      ) {
        const handover = await this.checkIn(
          active, budget, usage, signal, loop.from, loop.step, loop.watch,
        );
        if (handover) {
          if (handover.message) text = handover.message;
          return { ...ended, text, handover };
        }
      }
    }

    return {
      ...ended,
      text: text || `Stopped after ${MAX_STEPS} steps without finishing.`,
      outOfSteps: true,
    };
  }

  /**
   * A step's tool calls, in order, each result added to the transcript. Stops
   * at a call that has to wait on the person and says which: it and the calls
   * after it stay unanswered until the turn resumes. `preApproved` is for
   * running again a call the person has just approved.
   */
  private async runCalls(
    calls: ToolCall[],
    active: Active,
    signal: AbortSignal,
    loop: Loop,
    preApproved = false,
  ): Promise<Waiting | null> {
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
        const out: ToolResult = await tool.run(input, this.toolCtx(active, signal, preApproved));
        this.session.messages.push({
          role: "tool",
          tool_call_id: c.id,
          content: out as any,
        });
        this.logAction(loop, describeAction(c.function.name, input, label, out));
      } catch (err) {
        // Not a failure: the call is waiting on the person, and so is the turn.
        if (err instanceof PauseForUser) return { callId: c.id, request: err.request };
        // Failures are values, not exceptions. A stale ref or a timeout is
        // recoverable and the model handles it well when it can see it.
        const text = String((err as Error)?.message ?? err);
        emit("tool-error", this.session.id, `${c.function.name}: ${text}`);
        this.session.messages.push({
          role: "tool",
          tool_call_id: c.id,
          content: `Error: ${text}`,
        });
        this.logAction(loop, describeAction(c.function.name, input, label, new Error(text)));
      }
    }
    return null;
  }

  private async persist() {
    try {
      await save(this.userId, this.session);
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
  userId: string,
  runningIds: Set<string>,
): Promise<(SessionSummary & { running: boolean })[]> {
  const chats = await listSessions(userId);
  // A chat with nothing said in it yet is not worth its own history entry —
  // unless it is somehow already running (defensive; practically never true,
  // since a task pushes its own text into `tasks` before the run starts).
  return chats
    .filter((s) => s.taskCount > 0 || runningIds.has(s.id))
    .map((s) => ({ ...s, running: runningIds.has(s.id) }));
}

/** Human-readable label for whatever provider/model Settings currently point at. */
export function activeModelLabel(userId: string): string {
  return activeLabel(getConfig(userId));
}
