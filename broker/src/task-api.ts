// The task API's routes for other programs and AIs (the MCP server is a thin
// wrapper over them): start a task without waiting for it, read chats and what
// a running one is doing, stop it, change its approvals and supervisor, and
// read or edit memories and molds. The port, the bearer check and the blocking
// POST /api/task stay in index.ts, which owns the agents these act on.
//
// Two things are deliberately not here. Nothing answers an approval or a
// question a paused task is waiting on: that is the person's, in the panel; a
// caller sees that the chat is waiting and says so. And the changes that make
// CopperOS trust or ask for less — lower approvals, the supervisor off, a new
// memory or mold, which the agent treats as the person's own words — are
// refused unless MCP_ALLOW_LOOSENING=1 is set, so a page that talks an AI into
// them cannot do it quietly.

import type { IncomingMessage, ServerResponse } from "node:http";
import { Agent, listChats } from "./agent.js";
import { cap, isLoosening, moldPrompt, settingsProblem, turnsOf, waitingOf } from "./ai-access.js";
import { watchEvents } from "./bridge.js";
import { jevFor } from "./config.js";
import { jevOn, withJev } from "./jev.js";
import { addUserMemory, deleteMemoryByKey, memoriesForPage } from "./memory.js";
import type { ApprovalMode } from "./session.js";
import { store } from "./store/store.js";
import type { TaskExtras } from "./task-extras.js";
import { deleteWorkflow, listWorkflows, saveWorkflow } from "./workflows.js";

/** How a run ended, for callers that wait on it. */
export type Outcome =
  | { status: "done"; text: string; steps: number }
  | { status: "paused"; request: string }
  | { status: "timeout" | "cancelled"; text: string; steps: number }
  | { status: "error"; error: string };

export type ApiDeps = {
  user: string;
  extensionConnected: () => boolean;
  runningIds: () => Set<string>;
  getAgent: (id: string) => Promise<Agent>;
  newAgent: () => Agent;
  /** Starts a task and reports how it ended; limitMs undefined is the broker's own default. */
  runTask: (agent: Agent, text: string, extras: TaskExtras, limitMs?: number) => Promise<Outcome>;
  /** Stop, as the panel's Stop button does it. */
  cancelChat: (chatId: string) => void;
  /** How the chat's last run ended in this process, if it has run one. */
  lastOutcome: (chatId: string) => { status: string; at: string; error?: string } | undefined;
};

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const LOOSENING_OFF =
  "This is switched off for connected AIs: it lowers what CopperOS asks you about, or adds something it will treat as yours. " +
  "To allow it, set MCP_ALLOW_LOOSENING=1 in broker/.env and restart the broker. You can also do it yourself in the CopperOS panel.";

const ACTIVITY_KEEP = 25;
const ACTIVITY_CHATS = 50;
// Events that say nothing about what the task is doing.
const QUIET_EVENTS = new Set(["intent", "rules", "offer_workflow", "mold_proposal"]);

type Activity = { at: string; event: string; text: string };

type Reply = { status: number; body: unknown };
const ok = (body: unknown, status = 200): Reply => ({ status, body });

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) throw new ApiError(413, "request too large");
  }
  try {
    const body = JSON.parse(raw || "{}");
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // Not JSON: said below.
  }
  throw new ApiError(400, "the body must be a JSON object");
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Messages the person is meant to read (a full allowance, a duplicate mold) come back as a 400. */
async function userFacing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new ApiError(400, String((err as Error)?.message ?? err));
  }
}

/** Routes for the task API: answers true when it handled the request, false when the path is not one of these. */
export function apiRoutes(deps: ApiDeps) {
  const { user } = deps;

  // What each chat has been doing since its task began: the panel's step lines are
  // live-only and never saved, so the broker keeps the last few for whoever asks.
  const activity = new Map<string, Activity[]>();
  watchEvents((event, chatId, text) => {
    if (!chatId || QUIET_EVENTS.has(event)) return;
    let list = activity.get(chatId);
    if (!list) {
      list = [];
      activity.set(chatId, list);
      if (activity.size > ACTIVITY_CHATS) activity.delete(activity.keys().next().value!);
    }
    if (event === "start") list.length = 0;
    list.push({ at: new Date().toISOString(), event, text: (text ?? "").slice(0, 200) });
    if (list.length > ACTIVITY_KEEP) list.shift();
  });

  type Row = Awaited<ReturnType<typeof listChats>>[number];
  const rows = async (): Promise<Row[]> => {
    const running = deps.runningIds();
    const saved = await listChats(user, running);
    // A task that has just started is not saved until its first step is: its agent has it.
    const fresh: Row[] = [];
    for (const id of running) {
      if (saved.some((r) => r.id === id)) continue;
      const now = new Date().toISOString();
      fresh.push({ id, createdAt: now, updatedAt: now, title: (await deps.getAgent(id)).info().lastTask ?? "(starting)", taskCount: 1, running: true });
    }
    return [...fresh, ...saved];
  };
  const statusOf = (r: Row) => (r.pending ? "waiting" : r.running ? "running" : "idle");

  const rowFor = async (id: string): Promise<Row> => {
    // Matched against the saved ids, never used as a path.
    const row = (await rows()).find((r) => r.id === id);
    if (!row) throw new ApiError(404, "no chat with that id");
    return row;
  };

  const brief = (r: Row) => ({
    id: r.id,
    title: r.title.slice(0, 120),
    updatedAt: r.updatedAt,
    tasks: r.taskCount,
    status: statusOf(r),
    ...(r.pending ? { waiting: waitingOf(r.pending) } : {}),
  });

  /** Chats matching `q` in anything said in them, newest first. */
  async function search(q: string, limit: number) {
    const needle = q.toLowerCase();
    const found: (ReturnType<typeof brief> & { match: string })[] = [];
    for (const row of (await rows()).slice(0, 300)) {
      if (found.length >= limit) break;
      let text: string;
      try {
        text = turnsOf((await Agent.forChat(user, row.id)).replay()).map((t) => t.text).join("\n");
      } catch {
        continue; // unreadable: skipped, as in the chat list
      }
      const at = text.toLowerCase().indexOf(needle);
      if (at === -1) continue;
      const from = Math.max(0, at - 80);
      found.push({ ...brief(row), match: text.slice(from, at + needle.length + 80).replace(/\s+/g, " ") });
    }
    return found;
  }

  async function chatDetail(id: string, last: number) {
    const row = await rowFor(id);
    const agent = await deps.getAgent(id);
    const info = agent.info();
    const turns = turnsOf(agent.replay());
    const task = await store().loadTask(user, id);
    const outcome = deps.lastOutcome(id);
    return {
      ...brief(row),
      createdAt: row.createdAt,
      ...(row.running && !row.pending ? { currentTask: info.lastTask } : {}),
      ...(outcome && !row.running ? { lastRun: outcome } : {}),
      settings: { approvalMode: info.approvalMode, supervisor: info.supervisor },
      // The supervisor only checks in when this run has Jev.
      supervisorAvailable: withJev(jevFor(user), jevOn),
      ...(task
        ? {
            progress: {
              status: task.status,
              done: task.done.length,
              skipped: task.skipped.length,
              note: cap(task.note, 600),
              rounds: task.rounds,
              loop: task.loop === true,
            },
          }
        : {}),
      activity: activity.get(id) ?? [],
      totalTurns: turns.length,
      turns: turns.slice(-last),
    };
  }

  /** Changes a chat's approvals and supervisor, refusing what loosens them unless that is switched on. */
  async function applySettings(agent: Agent, patch: { approvalMode?: unknown; supervisor?: unknown }, optional = false) {
    // On a new task both are optional; on a settings change one must be given.
    const problem = optional && patch.approvalMode === undefined && patch.supervisor === undefined ? null : settingsProblem(patch);
    if (problem) throw new ApiError(400, problem);
    const asked = { approvalMode: patch.approvalMode as string | undefined, supervisor: patch.supervisor as boolean | undefined };
    if (isLoosening(agent.info(), asked) && process.env.MCP_ALLOW_LOOSENING !== "1") throw new ApiError(403, LOOSENING_OFF);
    if (asked.approvalMode !== undefined) await agent.setApprovalMode(asked.approvalMode as ApprovalMode);
    if (asked.supervisor !== undefined) await agent.setSupervisor(asked.supervisor);
    const after = agent.info();
    return { approvalMode: after.approvalMode, supervisor: after.supervisor };
  }

  async function startTask(body: Record<string, unknown>): Promise<Reply> {
    const text = str(body.text);
    const moldId = str(body.moldId);
    if (!text && !moldId) throw new ApiError(400, "text or moldId is required");
    if (!deps.extensionConnected()) throw new ApiError(503, "the extension is not connected (is Chrome open with CopperOS?)");
    // The extension drives one tab at a time, so tasks never overlap.
    if (deps.runningIds().size > 0) throw new ApiError(409, "busy: another task is running or waiting on you");

    let prompt = text;
    const extras: TaskExtras = body.rules && str(body.rules) ? { rules: str(body.rules).slice(0, 2000) } : {};
    if (moldId) {
      const mold = (await listWorkflows(user)).find((w) => w.id === moldId);
      if (!mold) throw new ApiError(404, "no mold with that id");
      prompt = moldPrompt(mold, text);
      extras.fromMold = mold.id;
    }

    // A follow-up in a chat that exists, else a fresh one: never mixed into the person's own chats unasked.
    const chatId = str(body.chatId);
    const agent = chatId ? await deps.getAgent((await rowFor(chatId)).id) : deps.newAgent();
    await applySettings(agent, { approvalMode: body.approvalMode, supervisor: body.supervisor }, true);

    const ms = Number(body.timeoutMs);
    const limitMs = ms > 0 ? Math.min(Math.max(ms, 30_000), 24 * 3_600_000) : undefined;
    // Not awaited: the caller reads the chat to see how it goes. A task that needs
    // an answer waits in the panel for the person, as any other does.
    void deps.runTask(agent, prompt, extras, limitMs);
    return ok({ chatId: agent.info().id, status: "running" }, 202);
  }

  async function dispatch(method: string, url: URL, req: IncomingMessage): Promise<Reply | null> {
    const path = url.pathname;
    const q = url.searchParams;

    if (path === "/api/tasks" && method === "POST") return startTask(await readJson(req));

    if (path === "/api/chats" && method === "GET") {
      const limit = Math.min(Math.max(Number(q.get("limit")) || 20, 1), 100);
      const query = str(q.get("q"));
      const chats = query ? await search(query, limit) : (await rows()).slice(0, limit).map(brief);
      return ok({ chats });
    }

    const chat = path.match(/^\/api\/chats\/([^/]+)(?:\/(cancel|settings))?$/);
    if (chat) {
      const id = decodeURIComponent(chat[1]);
      if (!chat[2] && method === "GET") {
        return ok(await chatDetail(id, Math.min(Math.max(Number(q.get("turns")) || 12, 1), 100)));
      }
      if (chat[2] === "cancel" && method === "POST") {
        const row = await rowFor(id);
        if (statusOf(row) === "idle") return ok({ chatId: id, stopped: false });
        deps.cancelChat(id);
        return ok({ chatId: id, stopped: true });
      }
      if (chat[2] === "settings" && method === "PATCH") {
        const body = await readJson(req);
        const agent = await deps.getAgent((await rowFor(id)).id);
        return ok({ chatId: id, settings: await applySettings(agent, body) });
      }
      return null;
    }

    if (path === "/api/memories" && method === "GET") return ok({ memories: await memoriesForPage(user) });
    if (path === "/api/memories" && method === "POST") {
      const text = str((await readJson(req)).text);
      if (!text) throw new ApiError(400, "text is required");
      if (process.env.MCP_ALLOW_LOOSENING !== "1") throw new ApiError(403, LOOSENING_OFF);
      await userFacing(() => withJev(jevFor(user), () => addUserMemory(user, text)));
      return ok({ memories: await memoriesForPage(user) });
    }
    const memory = path.match(/^\/api\/memories\/(.+)$/);
    if (memory && method === "DELETE") {
      await userFacing(() => deleteMemoryByKey(user, decodeURIComponent(memory[1])));
      return ok({ memories: await memoriesForPage(user) });
    }

    if (path === "/api/molds" && method === "GET") return ok({ molds: await listWorkflows(user) });
    if (path === "/api/molds" && method === "POST") {
      const body = await readJson(req);
      if (process.env.MCP_ALLOW_LOOSENING !== "1") throw new ApiError(403, LOOSENING_OFF);
      const molds = await userFacing(() => saveWorkflow(user, { id: body.id, name: body.name, steps: body.steps }));
      // Newest change first: the one just saved.
      return ok({ mold: molds[0], total: molds.length });
    }
    const mold = path.match(/^\/api\/molds\/([^/]+)$/);
    if (mold && method === "DELETE") {
      const molds = await deleteWorkflow(user, decodeURIComponent(mold[1]));
      return ok({ total: molds.length });
    }

    return null;
  }

  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    let reply: Reply | null;
    try {
      reply = await dispatch(req.method ?? "GET", url, req);
    } catch (err) {
      reply = err instanceof ApiError ? ok({ error: err.message }, err.status) : ok({ error: String((err as Error)?.message ?? err) }, 500);
    }
    if (!reply) return false;
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body));
    return true;
  };
}
