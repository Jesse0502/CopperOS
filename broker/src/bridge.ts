// WebSocket RPC bridge to the extension.
//
// The broker is the server so the extension can reconnect freely across
// service-worker restarts. Every op is a request/response pair with an id;
// unsolicited traffic (tasks from the popup, approvals) is typed instead.

import { WebSocketServer, WebSocket } from "ws";
import type { LLMConfig, Provider } from "./config.js";

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
};

export type BridgeHandlers = {
  onTask: (text: string, chatId: string | undefined) => void;
  onCancel: (chatId: string) => void;
  /** Start a brand-new chat, independent of whatever else is running. */
  onReset: () => void;
  /** The popup wants the list of saved chats. */
  onListChats: () => void;
  /** The popup picked a past chat to make active. */
  onSwitchChat: (id: string) => void;
  /** Per-chat setting change. */
  onSetApprovalMode: (chatId: string, mode: string) => void;
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

/**
 * Three states, not two. "unanswered" means nobody was watching — the popup is
 * a transient window and closes the moment the user clicks another tab — and
 * must never be reported to the model as a refusal.
 */
export type ApprovalOutcome = "approved" | "denied" | "unanswered";

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

const DEFAULT_TIMEOUT_MS = 45_000;
// MV3 recycles idle service workers, which drops the socket for a few seconds.
// Ops wait that out instead of failing the run.
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS ?? 30_000);
// Generous, because the human may be in another app entirely. Expiry is
// reported as "unanswered", so a long wait does not become a fake denial.
const APPROVAL_TIMEOUT_MS = Number(process.env.APPROVAL_TIMEOUT_MS ?? 900_000);

let client: WebSocket | null = null;
let seq = 0;
// Flap detection. One well-behaved extension reconnects rarely; a stream of
// connections that each displace a live one means two clients are fighting
// over the single slot, which no amount of retrying will resolve.
const FLAP_WINDOW_MS = 5_000;
let lastConnectAt = 0;
let rapidConnects = 0;
let flapWarned = false;
const pending = new Map<string, Pending>();
// Outstanding gates keep their prompt text so they can be re-sent to a popup
// that opens later, or to a restarted service worker.
const approvals = new Map<
  string,
  { chatId: string; text: string; settle: (outcome: ApprovalOutcome) => void }
>();
const connectionWaiters: Array<() => void> = [];

export function isConnected(): boolean {
  return client !== null && client.readyState === WebSocket.OPEN;
}

export function start(port: number, handlers: BridgeHandlers): WebSocketServer {
  const wss = new WebSocketServer({ host: "127.0.0.1", port });

  wss.on("connection", (ws) => {
    const now = Date.now();
    // Displacing a socket that was still OPEN is the signature: a clean
    // reconnect follows a close, so there is nothing live to displace.
    const displacedLiveClient =
      client !== null && client !== ws && client.readyState === WebSocket.OPEN;
    rapidConnects = now - lastConnectAt < FLAP_WINDOW_MS ? rapidConnects + 1 : 0;
    lastConnectAt = now;

    // One extension at a time; a reconnect supersedes the previous socket.
    if (client && client !== ws) {
      try { client.close(); } catch { /* already gone */ }
    }
    client = ws;
    console.log("[bridge] extension connected");

    if (displacedLiveClient && rapidConnects >= 3 && !flapWarned) {
      flapWarned = true;
      console.warn(
        "[bridge] connections are flapping: clients keep displacing each other.\n" +
        "[bridge] this is almost always two CopperOS instances talking to one broker —\n" +
        "[bridge]   • check chrome://extensions for a second copy loaded unpacked\n" +
        "[bridge]   • or a second Chrome profile/window with the extension installed\n" +
        "[bridge] remove one; the broker only ever keeps the newest connection.",
      );
    }
    while (connectionWaiters.length) connectionWaiters.shift()!();

    // A reconnecting extension may have lost track of any open approval
    // prompts along with its service worker — for every chat, not just the
    // one it is about to ask to resume. Bring it back up to date.
    for (const [id, a] of approvals) {
      ws.send(JSON.stringify({
        type: "agent_event", event: "approval_request", id, chatId: a.chatId, text: a.text,
      }));
    }

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (msg.type === "hello") {
        void (async () => {
          const state = await handlers.onHello(
            typeof msg.chatId === "string" ? msg.chatId : undefined,
          );
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "chat_state", ...state }));
          }
        })();
        return;
      }
      if (msg.type === "task" && typeof msg.text === "string") {
        handlers.onTask(msg.text, typeof msg.chatId === "string" ? msg.chatId : undefined);
        return;
      }
      if (msg.type === "cancel" && typeof msg.chatId === "string") {
        handlers.onCancel(msg.chatId);
        return;
      }
      if (msg.type === "reset") {
        handlers.onReset();
        return;
      }
      if (msg.type === "list_chats") {
        handlers.onListChats();
        return;
      }
      if (msg.type === "switch_chat" && typeof msg.id === "string") {
        handlers.onSwitchChat(msg.id);
        return;
      }
      if (
        msg.type === "set_approval_mode" &&
        typeof msg.chatId === "string" &&
        typeof msg.mode === "string"
      ) {
        handlers.onSetApprovalMode(msg.chatId, msg.mode);
        return;
      }
      if (msg.type === "approval") {
        approvals.get(msg.id)?.settle(msg.approved ? "approved" : "denied");
        approvals.delete(msg.id);
        return;
      }
      if (msg.type === "get_config") {
        void (async () => {
          const config = await handlers.onGetConfig();
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "config", config }));
        })();
        return;
      }
      if (msg.type === "set_config") {
        void (async () => {
          const config = await handlers.onSetConfig(msg.patch ?? {});
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "config", config }));
        })();
        return;
      }
      if (msg.type === "list_models" && typeof msg.provider === "string") {
        const provider = msg.provider as Provider;
        void (async () => {
          try {
            const models = await handlers.onListModels(provider);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "models", provider, models }));
            }
          } catch (err) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: "models", provider, error: String((err as Error)?.message ?? err),
              }));
            }
          }
        })();
        return;
      }

      // Op response.
      const p = msg.id ? pending.get(msg.id) : undefined;
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error ?? "unknown extension error"));
    });

    ws.on("close", () => {
      if (client === ws) client = null;
      console.log("[bridge] extension disconnected");
    });
  });

  console.log(`[bridge] listening on ws://127.0.0.1:${port}`);
  return wss;
}

export function waitForExtension(): Promise<void> {
  if (isConnected()) return Promise.resolve();
  console.log("[bridge] waiting for the extension to connect…");
  return new Promise((resolve) => connectionWaiters.push(resolve));
}

/** Resolves true once the extension is back, false if the grace period runs out. */
function waitForReconnect(ms: number): Promise<boolean> {
  if (isConnected()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    connectionWaiters.push(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * `chatId` tells the extension which chat's tab context an op belongs to.
 * `signal`, when given, rejects immediately on cancel instead of leaving the
 * run stuck until the op's own timeout (up to tens of seconds) elapses —
 * that wait is what made Cancel feel like it did nothing.
 */
export async function call<T = any>(
  op: string,
  chatId: string,
  params: Record<string, unknown> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new Error("Cancelled by user.");
  if (!isConnected()) {
    console.log("[bridge] extension away, waiting for it to come back…");
    if (!(await waitForReconnect(RECONNECT_GRACE_MS))) {
      throw new Error("extension is not connected");
    }
  }
  const id = `r${++seq}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`op "${op}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error("Cancelled by user."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(id, {
      resolve: (v: unknown) => { signal?.removeEventListener("abort", onAbort); resolve(v as T); },
      reject: (e: Error) => { signal?.removeEventListener("abort", onAbort); reject(e); },
      timer,
    });
    client!.send(JSON.stringify({ id, op, params, chatId }));
  });
}

/**
 * Progress line for the popup log. Never enters the model's context.
 * `chatId: null` means a broker-wide notice (e.g. shutting down) rather than
 * one belonging to a specific chat — the extension shows those regardless of
 * which chat is currently being viewed.
 */
export function emit(event: string, chatId: string | null, text?: string): void {
  if (!isConnected()) return;
  client!.send(JSON.stringify({ type: "agent_event", event, chatId, text }));
}

/** Answers a list_chats request (or refreshes it after a switch). */
export function sendChats(chats: unknown): void {
  if (!isConnected()) return;
  client!.send(JSON.stringify({ type: "chats", chats }));
}

/** A chat's full status, pushed after a reset/switch (hello gets one inline). */
export function sendChatState(state: ChatState): void {
  if (!isConnected()) return;
  client!.send(JSON.stringify({ type: "chat_state", ...state }));
}

/**
 * Ask the human. Survives the popup being closed and the service worker being
 * recycled: the request is held open, re-sent on reconnect, and only reported
 * as "unanswered" if nobody responds within APPROVAL_TIMEOUT_MS.
 *
 * `signal`, when given, also resolves as "unanswered" immediately on cancel —
 * without it, cancelling a run stuck at an approval gate did nothing until
 * the 15-minute timeout expired.
 */
export async function requestApproval(
  text: string,
  chatId: string,
  timeoutMs = APPROVAL_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<ApprovalOutcome> {
  if (signal?.aborted) return "unanswered";
  if (!isConnected() && !(await waitForReconnect(RECONNECT_GRACE_MS))) {
    return "unanswered";
  }
  const id = `a${++seq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      approvals.delete(id);
      resolve("unanswered");
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      approvals.delete(id);
      resolve("unanswered");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    approvals.set(id, {
      chatId,
      text,
      settle: (outcome) => {
        signal?.removeEventListener("abort", onAbort);
        clearTimeout(timer);
        resolve(outcome);
      },
    });
    // Best effort: if the socket is gone the request stays outstanding and is
    // re-sent by the connection handler above.
    if (isConnected()) {
      client!.send(JSON.stringify({
        type: "agent_event", event: "approval_request", id, chatId, text,
      }));
    }
  });
}
