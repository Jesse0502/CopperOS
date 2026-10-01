// The agent core's line to the extension: run an op in a tab and wait for its
// result, show a progress line in the panel, and show an approval or a
// question the person has to answer. Which connection carries it is set once
// at startup — the local broker's WebSocket server (transport/local.ts) today.
//
// Nothing waits on the person here. A task that needs them pauses (see
// agent.ts): the request is shown, and the answer comes back as a new message
// that resumes it, whenever that is.
//
// Every op is a request/response pair with an id; unsolicited traffic (tasks
// from the panel, approvals) is typed instead.

import type { LLMConfig, Provider } from "./config.js";
import type { TaskExtras } from "./task-extras.js";

/**
 * Full status of one chat, sent whenever the extension needs to (re)draw it.
 * Outstanding approvals are not included here — they are their own
 * `approval_request` events, resent to every (re)connecting socket for every
 * chat that has one outstanding, regardless of which chat this is for.
 */
export type ChatState = {
  id: string;
  events: { event: string; text: string }[];
  running: boolean;
  task: string | null;
  approvalMode: string;
  /** Whether the chat's tasks get supervisor check-ins. */
  supervisor: boolean;
};

/** What the panel can ask of the broker, besides answering ops. */
export type BridgeHandlers = {
  /** A new task, with the tab it starts on and any rules for the supervisor. */
  onTask: (text: string, chatId: string | undefined, extras: TaskExtras) => void;
  onCancel: (chatId: string) => void;
  /** Start a brand-new chat, independent of whatever else is running. */
  onReset: () => void;
  /** The popup wants the list of saved chats. */
  onListChats: () => void;
  /** The popup picked a past chat to make active. */
  onSwitchChat: (id: string) => void;
  /** Per-chat setting change. */
  onSetApprovalMode: (chatId: string, mode: string) => void;
  /** The supervisor turned on or off for a chat. */
  onSetSupervisor: (chatId: string, on: boolean) => void;
  /** The person approved or denied a request shown with show(). */
  onApproval: (requestId: string, approved: boolean) => void;
  /** The person answered (or closed) a question form shown with show(). */
  onAnswers: (requestId: string, outcome: AskOutcome) => void;
  /** The Settings page wants the current LLM provider/model/key config. */
  onGetConfig: () => LLMConfig | Promise<LLMConfig>;
  /** The Settings page changed something — merge and persist it. */
  onSetConfig: (patch: Record<string, unknown>) => LLMConfig | Promise<LLMConfig>;
  /** The Settings page wants the model list for a provider (may hit the network). */
  onListModels: (provider: Provider) => Promise<string[]>;
  /**
   * A (re)connecting extension asks to resume a chat — the one it already
   * knew about, or none if it has no memory of one (a cold start).
   */
  onHello: (chatId: string | undefined) => Promise<ChatState>;
};

export type ApprovalOutcome = "approved" | "denied";

/** One question in an ask_user form. The panel always adds a free-text answer after `options`. */
export type AskQuestion = { question: string; options: string[]; multiple: boolean };
export type AskRequest = { intro: string; questions: AskQuestion[] };
/** One answer per question, null where the user skipped it. */
export type AskOutcome = { answers: Array<string | null> } | "dismissed";

/**
 * Something a paused task is waiting on the person for. Kept with the chat
 * until it is answered, so it can be shown again to a panel that opens later,
 * a restarted service worker, or after the broker itself restarts.
 */
export type PendingRequest = { id: string; chatId: string } & (
  | { kind: "approval"; text: string }
  | { kind: "ask"; ask: AskRequest }
);

/**
 * A request id carries its chat, so an answer finds the task it resumes with
 * nothing else to look up.
 */
export function newRequestId(chatId: string): string {
  return `${chatId}/${Math.random().toString(36).slice(2, 10)}`;
}

/** A request as the panel expects it: an approval_request or ask_request event. */
export function requestMessage(request: PendingRequest): Record<string, unknown> {
  const { id, chatId } = request;
  return request.kind === "approval"
    ? { type: "agent_event", event: "approval_request", id, chatId, text: request.text }
    : { type: "agent_event", event: "ask_request", id, chatId, ask: request.ask };
}

/** The chat a request id belongs to, or null if it is not one of ours. */
export function requestChatId(requestId: string): string | null {
  const i = requestId.lastIndexOf("/");
  return i > 0 ? requestId.slice(0, i) : null;
}

/** A connection to the extension, as the agent core needs it. */
export interface Transport {
  call<T>(
    op: string,
    chatId: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T>;
  emit(event: string, chatId: string | null, text?: string): void;
  /** Show a request, and keep showing it to a (re)connecting panel until withdrawn or answered. */
  show(request: PendingRequest): void;
  withdraw(requestId: string): void;
}

let active: Transport | null = null;

/** Set once at startup, by whichever entry point is running. */
export function useTransport(transport: Transport): void {
  active = transport;
}

function transport(): Transport {
  if (!active) throw new Error("no transport configured — call useTransport() at startup");
  return active;
}

const DEFAULT_TIMEOUT_MS = 45_000;

/** Aborts a run's signal when it reaches its time limit, rather than the person cancelling. */
export class TimeUp extends Error {
  constructor() {
    super("Stopped at the time limit.");
    this.name = "TimeUp";
  }
}

/** What an op stopped by `signal` reports: a cancel, unless the run hit its time limit. */
export function abortedError(signal: AbortSignal): Error {
  return new Error(signal.reason instanceof TimeUp ? signal.reason.message : "Cancelled by user.");
}

/**
 * `chatId` tells the extension which chat's tab context an op belongs to.
 * `signal`, when given, rejects immediately on cancel instead of leaving the
 * run stuck until the op's own timeout (up to tens of seconds) elapses —
 * that wait is what made Cancel feel like it did nothing.
 */
export function call<T = any>(
  op: string,
  chatId: string,
  params: Record<string, unknown> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<T> {
  return transport().call<T>(op, chatId, params, timeoutMs, signal);
}

/**
 * Progress line for the popup log. Never enters the model's context.
 * `chatId: null` means a broker-wide notice (e.g. shutting down) rather than
 * one belonging to a specific chat — the extension shows those regardless of
 * which chat is currently being viewed.
 */
export function emit(event: string, chatId: string | null, text?: string): void {
  transport().emit(event, chatId, text);
}

/** Put a paused task's request in front of the person. */
export function showRequest(request: PendingRequest): void {
  transport().show(request);
}

/** Stop showing a request — it was answered, or its task was cancelled. */
export function withdrawRequest(requestId: string): void {
  transport().withdraw(requestId);
}
