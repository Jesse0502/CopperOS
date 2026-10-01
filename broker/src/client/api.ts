// Client for the broker's local task API. Shared by the CLI and the MCP server,
// which are both thin wrappers: the running broker does the work, in the
// Chrome that's already signed in.
import { config } from "dotenv";
import { fileURLToPath } from "node:url";

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
