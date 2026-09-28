// The local broker's connection to the extension: a WebSocket server on
// 127.0.0.1. The broker is the server so the extension can reconnect freely
// across service-worker restarts.

import { WebSocketServer, WebSocket } from "ws";
import {
  abortedError,
  requestMessage,
  type AskOutcome,
  type BridgeHandlers,
  type ChatState,
  type PendingRequest,
  type Transport,
} from "../bridge.js";
import type { Provider } from "../config.js";

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

// MV3 recycles idle service workers, which drops the socket for a few seconds.
// Ops wait that out instead of failing the run.
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS ?? 30_000);
// Flap detection. One well-behaved extension reconnects rarely; a stream of
// connections that each displace a live one means two clients are fighting
// over the single slot, which no amount of retrying will resolve.
const FLAP_WINDOW_MS = 5_000;

export class LocalServer implements Transport {
  private client: WebSocket | null = null;
  private seq = 0;
  private lastConnectAt = 0;
  private rapidConnects = 0;
  private flapWarned = false;
  private readonly pending = new Map<string, Pending>();
  // Approvals and question forms still waiting on the person, re-sent to a
  // popup that opens later or to a restarted service worker.
  private readonly shown = new Map<string, PendingRequest>();
  private readonly connectionWaiters: Array<() => void> = [];

  isConnected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN;
  }

  start(port: number, handlers: BridgeHandlers): WebSocketServer {
    const wss = new WebSocketServer({ host: "127.0.0.1", port });

    wss.on("connection", (ws) => {
      const now = Date.now();
      // Displacing a socket that was still OPEN is the signature: a clean
      // reconnect follows a close, so there is nothing live to displace.
      const displacedLiveClient =
        this.client !== null && this.client !== ws && this.client.readyState === WebSocket.OPEN;
      this.rapidConnects = now - this.lastConnectAt < FLAP_WINDOW_MS ? this.rapidConnects + 1 : 0;
      this.lastConnectAt = now;

      // One extension at a time; a reconnect supersedes the previous socket.
      if (this.client && this.client !== ws) {
        try { this.client.close(); } catch { /* already gone */ }
      }
      this.client = ws;
      console.log("[bridge] extension connected");

      if (displacedLiveClient && this.rapidConnects >= 3 && !this.flapWarned) {
        this.flapWarned = true;
        console.warn(
          "[bridge] connections are flapping: clients keep displacing each other.\n" +
          "[bridge] this is almost always two CopperOS instances talking to one broker —\n" +
          "[bridge]   • check chrome://extensions for a second copy loaded unpacked\n" +
          "[bridge]   • or a second Chrome profile/window with the extension installed\n" +
          "[bridge] remove one; the broker only ever keeps the newest connection.",
        );
      }
      while (this.connectionWaiters.length) this.connectionWaiters.shift()!();

      // A reconnecting extension may have lost track of any open approval
      // prompts along with its service worker — for every chat, not just the
      // one it is about to ask to resume. Bring it back up to date.
      for (const request of this.shown.values()) ws.send(JSON.stringify(requestMessage(request)));

      ws.on("message", (raw) => this.onMessage(ws, raw.toString(), handlers));

      ws.on("close", () => {
        if (this.client === ws) this.client = null;
        console.log("[bridge] extension disconnected");
      });
    });

    console.log(`[bridge] listening on ws://127.0.0.1:${port}`);
    return wss;
  }

  private onMessage(ws: WebSocket, raw: string, handlers: BridgeHandlers): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
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
    if (msg.type === "approval" && typeof msg.id === "string") {
      this.shown.delete(msg.id);
      handlers.onApproval(msg.id, Boolean(msg.approved));
      return;
    }
    if (msg.type === "answers" && typeof msg.id === "string") {
      const outcome: AskOutcome = msg.dismissed
        ? "dismissed"
        : {
            answers: (Array.isArray(msg.answers) ? msg.answers : []).map((a: unknown) =>
              typeof a === "string" && a.trim() ? a.trim() : null,
            ),
          };
      this.shown.delete(msg.id);
      handlers.onAnswers(msg.id, outcome);
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
    const p = msg.id ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.data);
    else p.reject(new Error(msg.error ?? "unknown extension error"));
  }

  waitForExtension(): Promise<void> {
    if (this.isConnected()) return Promise.resolve();
    console.log("[bridge] waiting for the extension to connect…");
    return new Promise((resolve) => this.connectionWaiters.push(resolve));
  }

  /** Resolves true once the extension is back, false if the grace period runs out. */
  private waitForReconnect(ms: number): Promise<boolean> {
    if (this.isConnected()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.connectionWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  async call<T>(
    op: string,
    chatId: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw abortedError(signal);
    if (!this.isConnected()) {
      console.log("[bridge] extension away, waiting for it to come back…");
      if (!(await this.waitForReconnect(RECONNECT_GRACE_MS))) {
        throw new Error("extension is not connected");
      }
    }
    const id = `r${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`op "${op}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(abortedError(signal!));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v: unknown) => { signal?.removeEventListener("abort", onAbort); resolve(v as T); },
        reject: (e: Error) => { signal?.removeEventListener("abort", onAbort); reject(e); },
        timer,
      });
      this.client!.send(JSON.stringify({ id, op, params, chatId }));
    });
  }

  emit(event: string, chatId: string | null, text?: string): void {
    if (!this.isConnected()) return;
    this.client!.send(JSON.stringify({ type: "agent_event", event, chatId, text }));
  }

  /** Answers a list_chats request (or refreshes it after a switch). */
  sendChats(chats: unknown): void {
    if (!this.isConnected()) return;
    this.client!.send(JSON.stringify({ type: "chats", chats }));
  }

  /** A chat's full status, pushed after a reset/switch (hello gets one inline). */
  sendChatState(state: ChatState): void {
    if (!this.isConnected()) return;
    this.client!.send(JSON.stringify({ type: "chat_state", ...state }));
  }

  show(request: PendingRequest): void {
    this.shown.set(request.id, request);
    if (this.isConnected()) this.client!.send(JSON.stringify(requestMessage(request)));
  }

  withdraw(requestId: string): void {
    this.shown.delete(requestId);
  }
}
