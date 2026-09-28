// The agent Lambda's connection to the extension. Ops, progress lines and
// requests go straight to the user's browser through API Gateway. Answers
// come back the other way: the extension's messages reach the relay, which
// forwards op results (and cancels) to this task's own "worker" connection
// on the same socket. That connection is opened with a one-time pass the
// relay made for the task (see cloud/connections.ts).
//
// API Gateway takes at most 128 KB per message, so the extension sends a big
// result — a screenshot — as numbered chunks, joined back together here.

import WebSocket from "ws";
import { abortedError, requestMessage, type PendingRequest, type Transport } from "../bridge.js";
import { extensionsOf, post } from "../cloud/connections.js";

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

/** Messages the relay passes on from the person: stop the task, or change its approval mode. */
export type Control = { type: "cancel" } | { type: "set_approval_mode"; mode: string };

// A restarted service worker drops the socket for a few seconds; ops wait
// that out instead of failing the run.
const RECONNECT_GRACE_MS = 30_000;
// API Gateway closes a connection idle for 10 minutes.
const KEEPALIVE_MS = 4 * 60_000;
// How long a list of the user's browsers is trusted before looking again.
const LISTENERS_TTL_MS = 15_000;

export class CloudTransport implements Transport {
  private ws: WebSocket | null = null;
  private seq = 0;
  // Op ids are unique across every task a user has running at once, since
  // the relay hands each result to all of them.
  private readonly tag = Math.random().toString(36).slice(2, 8);
  private readonly pending = new Map<string, Pending>();
  private readonly chunks = new Map<string, string[]>();
  // Where ops go: the browser that started the task, until it disconnects.
  private target: string | null;
  private listeners: { ids: string[]; at: number } | null = null;
  // Everything sent goes out in order, one after another.
  private outbox: Promise<unknown> = Promise.resolve();
  private keepalive: NodeJS.Timeout | null = null;

  constructor(
    private readonly userId: string,
    extensionConnectionId: string | null,
    private readonly onControl: (message: Control) => void,
  ) {
    this.target = extensionConnectionId;
  }

  /** Join the socket as this task's worker. */
  async open(grant: string): Promise<void> {
    const base = process.env.SOCKET_URL;
    if (!base) throw new Error("SOCKET_URL is not set");
    const ws = new WebSocket(`${base}?token=${encodeURIComponent(`worker:${grant}`)}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("unexpected-response", (_req, res) => reject(new Error(`worker connection refused (${res.statusCode})`)));
      ws.once("error", reject);
    });
    ws.on("message", (raw) => {
      try {
        this.receive(JSON.parse(raw.toString()));
      } catch (err) {
        console.warn(`[transport] unreadable message: ${String(err)}`);
      }
    });
    this.ws = ws;
    this.keepalive = setInterval(() => ws.send(JSON.stringify({ type: "ping" })), KEEPALIVE_MS);
  }

  /** Wait for everything sent so far to go out, then leave the socket. */
  async close(): Promise<void> {
    await this.outbox.catch(() => {});
    if (this.keepalive) clearInterval(this.keepalive);
    this.ws?.close();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("the task ended"));
    }
    this.pending.clear();
  }

  private receive(msg: any): void {
    if (msg.type === "chunk") {
      const parts = this.chunks.get(msg.id) ?? new Array<string>(msg.of);
      parts[msg.seq] = msg.data;
      this.chunks.set(msg.id, parts);
      if (parts.filter((p) => p !== undefined).length === msg.of) {
        this.chunks.delete(msg.id);
        this.receive(JSON.parse(parts.join("")));
      }
      return;
    }
    if (msg.type === "pong") return;
    if (msg.type === "cancel" || msg.type === "set_approval_mode") {
      this.onControl(msg);
      return;
    }
    const p = msg.id ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.data);
    else p.reject(new Error(msg.error ?? "unknown extension error"));
  }

  /** Run a send behind everything sent before it; resolves to whether it arrived. */
  private enqueue(send: () => Promise<boolean>): Promise<boolean> {
    const sent = this.outbox.then(send);
    this.outbox = sent.catch(() => false);
    return sent;
  }

  /** The browser ops go to — waiting out a reconnect if it has gone. */
  private async browser(): Promise<string> {
    if (this.target) return this.target;
    const giveUp = Date.now() + RECONNECT_GRACE_MS;
    for (;;) {
      const [newest] = await extensionsOf(this.userId);
      if (newest) return (this.target = newest.connectionId);
      if (Date.now() > giveUp) throw new Error("extension is not connected");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /** Every browser the user has open, for progress lines and requests. */
  private async everyBrowser(): Promise<string[]> {
    if (!this.listeners || Date.now() - this.listeners.at > LISTENERS_TTL_MS) {
      const ids = (await extensionsOf(this.userId)).map((c) => c.connectionId);
      this.listeners = { ids, at: Date.now() };
    }
    return this.listeners.ids;
  }

  private broadcast(message: unknown): void {
    void this.enqueue(async () => {
      for (const id of await this.everyBrowser()) await post(id, message);
      return true;
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
    const id = `${this.tag}.${++this.seq}`;
    const result = new Promise<T>((resolve, reject) => {
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
        resolve: (v) => { signal?.removeEventListener("abort", onAbort); resolve(v as T); },
        reject: (e) => { signal?.removeEventListener("abort", onAbort); reject(e); },
        timer,
      });
    });
    // The browser that started the task may have reconnected since: try the
    // one we know, then whichever is newest.
    const message = { id, op, params, chatId };
    const delivered = await this.enqueue(async () => {
      if (await post(await this.browser(), message)) return true;
      this.target = null;
      return post(await this.browser(), message);
    }).catch(() => false);
    if (!delivered) {
      const p = this.pending.get(id);
      p?.reject(new Error("extension is not connected"));
      if (p) clearTimeout(p.timer);
      this.pending.delete(id);
    }
    return result;
  }

  emit(event: string, chatId: string | null, text?: string): void {
    this.broadcast({ type: "agent_event", event, chatId, text });
  }

  show(request: PendingRequest): void {
    this.broadcast(requestMessage(request));
  }

  // A paused task's request is kept on its chat (and shown again by the
  // relay), not by the transport.
  withdraw(): void {}
}
