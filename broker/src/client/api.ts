// Client for the broker's local task API. Shared by the CLI and the MCP server,
// which are both thin wrappers: the running broker does the work, in the
// Chrome that's already signed in.
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import type { Backend, ChatDetail } from "./backend.js";

// Read broker/.env so TASK_API_TOKEN needn't be repeated in every MCP config.
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

export type TaskRequest = { text: string; rules?: string; approvalMode?: "all" | "submits" | "none"; timeoutMs?: number };

export type TaskResult =
  | { status: "done"; text: string; steps: number; chatId: string }
  | { status: "timeout" | "cancelled"; text: string; steps: number; chatId: string }
  | { status: "blocked"; request: string; chatId: string }
  | { status: "error"; error: string; chatId?: string };

const port = process.env.TASK_API_PORT ?? "7332";
const base = process.env.COPPER_URL?.replace(/\/$/, "") ?? `http://127.0.0.1:${port}`;

async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<{ status: number; body: T }> {
  const token = process.env.TASK_API_TOKEN?.trim();
  if (!token) throw new Error("TASK_API_TOKEN is not set (put it in broker/.env, then restart the broker)");
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if ((err as Error).name === "TimeoutError") throw new Error(`no answer from the broker within ${Math.round(timeoutMs / 1000)}s`);
    throw new Error(`can't reach the broker at ${base} — is it running with TASK_API_TOKEN set? (${(err as Error).message})`);
  }
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

export async function health() {
  const { status, body } = await call<{ ok?: boolean; extension?: boolean; busy?: boolean; model?: string; error?: string }>("GET", "/api/health");
  if (status !== 200) throw new Error(body.error ?? `broker answered ${status}`);
  return body;
}

/** Runs a task and waits. Non-200s (busy, extension offline) come back as errors. */
export async function runTask(req: TaskRequest): Promise<TaskResult> {
  const limit = Math.min(Math.max(req.timeoutMs ?? 600_000, 30_000), 1_800_000);
  // The broker enforces `limit` itself; the extra minute is only for it to answer.
  const { status, body } = await call<TaskResult & { error?: string }>("POST", "/api/task", { ...req, timeoutMs: limit }, limit + 60_000);
  if (status !== 200) return { status: "error", error: body.error ?? `broker answered ${status}` };
  return body;
}

// ── chats, memories and molds ─────────────────────────────────────────────

/** Like `call`, but anything other than a 2xx is an Error carrying the broker's own words. */
async function ok<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const { status, body: res } = await call<T & { error?: string }>(method, path, body, timeoutMs);
  if (status >= 300) throw new Error(res.error ?? `broker answered ${status}`);
  return res;
}

const enc = encodeURIComponent;

const LOOSENING =
  "Lowering approvals (to a mode that asks less) or turning the supervisor off, and adding a memory or mold, only work when the person has set MCP_ALLOW_LOOSENING=1 in broker/.env; otherwise the call is refused and says so.";

/** The broker on this computer, through its task API. */
export const localBackend: Backend = {
  maxWaitSeconds: 300,
  canWriteTrust: true,
  loosenNote: LOOSENING,
  startTask: (req) => ok("POST", "/api/tasks", req),
  listChats: (query, limit) =>
    ok("GET", `/api/chats?${new URLSearchParams({ ...(query ? { q: query } : {}), ...(limit ? { limit: String(limit) } : {}) })}`, undefined, 60_000),
  getChat: (chatId, turns) => ok("GET", `/api/chats/${enc(chatId)}${turns ? `?turns=${turns}` : ""}`),
  async chatStatus(chatId) {
    const chat = await ok<ChatDetail>("GET", `/api/chats/${enc(chatId)}?turns=1`);
    const step = chat.activity.at(-1);
    return { status: chat.status, ...(step ? { step: `${step.event} ${step.text}`.trim() } : {}) };
  },
  stopChat: (chatId) => ok("POST", `/api/chats/${enc(chatId)}/cancel`, {}),
  setSettings: (chatId, patch) => ok("PATCH", `/api/chats/${enc(chatId)}/settings`, patch),
  listMemories: () => ok("GET", "/api/memories"),
  addMemory: (text) => ok("POST", "/api/memories", { text }, 60_000),
  deleteMemory: (key) => ok("DELETE", `/api/memories/${enc(key)}`),
  listMolds: () => ok("GET", "/api/molds"),
  saveMold: (mold) => ok("POST", "/api/molds", mold),
  deleteMold: (moldId) => ok("DELETE", `/api/molds/${enc(moldId)}`),
};

/** The result as plain text, for a terminal or a model. */
export function describe(r: TaskResult): string {
  switch (r.status) {
    case "done":
      return r.text;
    case "timeout":
      return `Stopped at the time limit after ${r.steps} steps.\n${r.text}`.trim();
    case "cancelled":
      return `Cancelled after ${r.steps} steps.\n${r.text}`.trim();
    case "blocked":
      return `Blocked: the task needed approval or an answer it couldn't get. ${r.request}`;
    case "error":
      return `Error: ${r.error}`;
  }
}
