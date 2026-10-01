import "dotenv/config";
import { createServer, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  emit,
  requestChatId,
  showRequest,
  useTransport,
  withdrawRequest,
  type ApprovalOutcome,
  type AskOutcome,
  type ChatState,
} from "./bridge.js";
import { Agent, activeModelLabel, formatUsage, listChats, type RunResult } from "./agent.js";
import { listSessions, setCurrent, type ApprovalMode } from "./session.js";
import { initConfig, getConfig, setConfig, listModels, type Provider } from "./config.js";
import { LOCAL_USER, useStore } from "./store/store.js";
import { FsStore } from "./store/fs.js";
import { LocalServer } from "./transport/local.js";
import type { TaskExtras } from "./task-extras.js";

const PORT = Number(process.env.PORT ?? 7331);
// Optional locally: a limit on each task's active time, like the hosted
// version's. Unset or 0 means none. Time spent waiting on you never counts.
const TASK_LIMIT_MS = Number(process.env.TASK_BUDGET_MS ?? 0) || null;

// The local broker: files under storage/, one user, and a WebSocket server
// the extension connects to.
const USER = LOCAL_USER;
useStore(new FsStore());
const server = new LocalServer();
useTransport(server);
await initConfig(USER);

// Every chat is its own agent, created the first time something addresses it
// and kept around for the life of the process — there is no more single
// "current" agent gating everything else.
const agents = new Map<string, Agent>();
const runs = new Map<string, { busy: boolean; task: string | null; cancelRequested: boolean }>();

function runOf(id: string) {
  let r = runs.get(id);
  if (!r) {
    r = { busy: false, task: null, cancelRequested: false };
    runs.set(id, r);
  }
  return r;
}

function register(agent: Agent): Agent {
  agents.set(agent.info().id, agent);
  return agent;
}

/** The agent for `id`, from the registry if it is already there, else loaded from disk. */
async function getAgent(id: string): Promise<Agent> {
  return agents.get(id) ?? register(await Agent.forChat(USER, id));
}

async function chatStateFor(id: string): Promise<ChatState> {
  const agent = await getAgent(id);
  const info = agent.info();
  const run = runOf(id);
  return {
    id: info.id,
    events: agent.replay(),
    running: run.busy,
    task: run.task,
    approvalMode: info.approvalMode,
    supervisor: info.supervisor,
  };
}

/** How a run ended, for callers that wait on it (the task API). */
type Outcome =
  | { status: "done"; text: string; steps: number }
  | { status: "paused"; request: string }
  | { status: "timeout" | "cancelled"; text: string; steps: number }
  | { status: "error"; error: string };

async function runTask(agent: Agent, text: string, extras: TaskExtras, limitMs: number | null = TASK_LIMIT_MS): Promise<Outcome> {
  const id = agent.info().id;
  const run = runOf(id);
  run.busy = true;
  run.task = text;
  run.cancelRequested = false;
  console.log(`\n[task ${id}] ${text}`);
  emit("start", id, text);
  if (extras.rules) emit("rules", id, extras.rules);
  return drive(agent, () => agent.run(text, { limitMs, ...extras }));
}

/**
 * Runs `work` — a new task, or a paused one resuming — and reports how it
 * ended. Pausing is not an end: the chat stays busy (to the panel it is still
 * running, waiting on you) and its request is shown until it is answered.
 */
async function drive(agent: Agent, work: () => Promise<RunResult>): Promise<Outcome> {
  const id = agent.info().id;
  const run = runOf(id);
  let paused = false;
  try {
    const result = await work();
    if (result.paused) {
      // Cancel was clicked just as it paused: nothing should be left waiting.
      if (run.cancelRequested) {
        await agent.cancelPause();
        console.log(`[cancelled ${id}] stopped by user`);
        return { status: "cancelled", text: "", steps: result.steps };
      }
      paused = true;
      const what = result.paused.kind === "approval" ? `approval — ${result.paused.text}` : "questions";
      console.log(`[waiting ${id}] ${what}`);
      showRequest(result.paused);
      return { status: "paused", request: what };
    }
    if (result.timeUp) {
      console.log(`[time-up ${id}] ${result.steps} steps · ${formatUsage(result)}`);
      // Shown the way a cancel is — the run ends, nothing is left waiting —
      // with its own words.
      emit("cancelled", id, result.text);
      return { status: "timeout", text: result.text, steps: result.steps };
    }
    // Cancel already told the UI the moment it was clicked — the run
    // unwinding afterward (cleanly, or via an aborted tool call throwing)
    // is not a second, different outcome worth re-announcing.
    if (run.cancelRequested) {
      console.log(`[cancelled ${id}] ${result.steps} steps · ${formatUsage(result)}`);
      return { status: "cancelled", text: result.text, steps: result.steps };
    }
    console.log(`[done ${id}] ${result.steps} steps · ${formatUsage(result)}`);
    console.log(result.text);
    emit("done", id, `${result.steps} steps · ${formatUsage(result)}`);
    return { status: "done", text: result.text, steps: result.steps };
  } catch (err) {
    if (run.cancelRequested) {
      console.log(`[cancelled ${id}] stopped by user`);
      return { status: "cancelled", text: "", steps: 0 };
    }
    const text = String((err as Error)?.message ?? err);
    console.error(`[error ${id}] ${text}`);
    emit("error", id, text);
    return { status: "error", error: text };
  } finally {
    if (!paused) {
      run.busy = false;
      run.task = null;
    }
  }
}

/** The person answered a paused task's request: carry the task on. */
function answer(requestId: string, outcome: ApprovalOutcome | AskOutcome) {
  void (async () => {
    const chatId = requestChatId(requestId);
    if (!chatId) return;
    const agent = await getAgent(chatId);
    // Answered twice, or its task was cancelled since: nothing waits on it.
    if (agent.waitingOn()?.id !== requestId) return;
    runOf(chatId).cancelRequested = false;
    const what = typeof outcome === "string" ? outcome : "answered";
    console.log(`[resume ${chatId}] ${what}`);
    await drive(agent, () => agent.resume(requestId, outcome, { limitMs: TASK_LIMIT_MS }));
  })();
}

// Tasks that were waiting on you when the broker stopped are still waiting:
// show their requests again, and keep their chats busy until answered.
for (const chat of await listSessions(USER)) {
  if (!chat.pending) continue;
  const run = runOf(chat.id);
  run.busy = true;
  run.task = (await getAgent(chat.id)).info().lastTask;
  showRequest(chat.pending);
  console.log(`[waiting ${chat.id}] since before the restart`);
}

function runningIds(): Set<string> {
  return new Set([...runs.entries()].filter(([, r]) => r.busy).map(([id]) => id));
}

server.start(PORT, {
  onTask: (text, chatId, extras) => {
    void (async () => {
      // No chatId at all is a defensive fallback (should not happen once the
      // extension has completed its hello handshake) — start somewhere fresh
      // rather than silently dropping the task.
      const agent = chatId ? await getAgent(chatId) : register(Agent.blank(USER));
      const id = agent.info().id;
      if (runOf(id).busy) {
        emit("error", id, "This chat is already running a task — cancel it, or start/switch to another chat.");
        return;
      }
      void runTask(agent, text, extras);
    })();
  },
  onCancel: (chatId) => {
    runOf(chatId).cancelRequested = true;
    agents.get(chatId)?.cancel();
    emit("cancelled", chatId, "");
    // A paused task has no run to stop: cancel it where it waits.
    void (async () => {
      const request = await (await getAgent(chatId)).cancelPause();
      if (!request) return;
      withdrawRequest(request.id);
      const run = runOf(chatId);
      run.busy = false;
      run.task = null;
      console.log(`[cancelled ${chatId}] while waiting on you`);
    })();
  },
  onReset: () => {
    void (async () => {
      const agent = register(Agent.blank(USER));
      const id = agent.info().id;
      await setCurrent(USER, id);
      console.log(`[session] new chat ${id}`);
      server.sendChatState(await chatStateFor(id));
    })();
  },
  onListChats: () => {
    void (async () => {
      try {
        server.sendChats(await listChats(USER, runningIds()));
      } catch (err) {
        emit("error", null, `Could not list chats: ${String((err as Error)?.message ?? err)}`);
      }
    })();
  },
  onSwitchChat: (id) => {
    void (async () => {
      try {
        await getAgent(id);
        await setCurrent(USER, id);
        console.log(`[session] switched to chat ${id}`);
        server.sendChatState(await chatStateFor(id));
      } catch (err) {
        emit("error", id, `Could not switch chat: ${String((err as Error)?.message ?? err)}`);
      }
    })();
  },
  onSetApprovalMode: (chatId, mode) => {
    void (async () => {
      if (!["all", "submits", "none"].includes(mode)) return;
      const agent = await getAgent(chatId);
      await agent.setApprovalMode(mode as ApprovalMode);
    })();
  },
  onSetSupervisor: (chatId, on) => {
    void (async () => {
      const agent = await getAgent(chatId);
      await agent.setSupervisor(on);
    })();
  },
  onApproval: (requestId, approved) => answer(requestId, approved ? "approved" : "denied"),
  onAnswers: (requestId, outcome) => answer(requestId, outcome),
  onGetConfig: () => getConfig(USER),
  onSetConfig: (patch) => setConfig(USER, patch as Parameters<typeof setConfig>[1]),
  onListModels: (provider) => listModels(USER, provider),
  onHello: async (chatId) => {
    const agent = chatId ? await getAgent(chatId) : register(await Agent.resumeLast(USER));
    const id = agent.info().id;
    await setCurrent(USER, id);
    return chatStateFor(id);
  },
}).on("error", (err) => exitIfPortTaken(err, PORT));

console.log(`[broker] model: ${activeModelLabel(USER)}`);
console.log("[broker] load the unpacked extension, then type a task in its popup.");
console.log("[broker] change provider/model/API keys any time from the extension's Settings page.");

// Fail at startup rather than on the first task: a stopped Ollama or a model
// that was never pulled are both easy mistakes with unhelpful mid-run errors.
// Only meaningful when Ollama is the active provider.
void (async () => {
  const cfg = getConfig(USER);
  if (cfg.provider !== "ollama") return;
  try {
    const res = await fetch(`${cfg.ollama.host.replace(/\/$/, "")}/api/tags`);
    const { models } = (await res.json()) as { models?: { name: string }[] };
    const names = (models ?? []).map((m) => m.name);
    if (names.length && !names.includes(cfg.ollama.model)) {
      console.warn(
        `[broker] "${cfg.ollama.model}" is not in \`ollama list\` (${names.join(", ") || "none"}).\n` +
        `[broker] pull it, or change the model in Settings to one you have.`,
      );
    }
  } catch {
    console.warn(
      `[broker] cannot reach Ollama at ${cfg.ollama.host} — start it with \`ollama serve\`.`,
    );
  }
})();

// Task API: lets another program on this computer (such as a marketing engine)
// run a task and get its result, without a second broker. Off unless
// TASK_API_TOKEN is set. Listens on 127.0.0.1 only.
const API_TOKEN = process.env.TASK_API_TOKEN?.trim();
if (API_TOKEN) startTaskApi(API_TOKEN, Number(process.env.TASK_API_PORT ?? 7332));

function startTaskApi(token: string, port: number) {
  const expected = Buffer.from(`Bearer ${token}`);
  const authorized = (header: string | undefined) => {
    const got = Buffer.from(header ?? "");
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  createServer(async (req, res) => {
    try {
      if (!authorized(req.headers.authorization)) return reply(res, 401, { error: "unauthorized" });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/api/health") {
        return reply(res, 200, { ok: true, extension: server.isConnected(), busy: runningIds().size > 0, model: activeModelLabel(USER) });
      }

      if (req.method === "POST" && url.pathname === "/api/task") {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 64_000) return reply(res, 413, { error: "task too large" });
        }
        const body = JSON.parse(raw || "{}") as { text?: string; rules?: string; approvalMode?: string; timeoutMs?: number };
        const text = String(body.text ?? "").trim();
        if (!text) return reply(res, 400, { error: "text is required" });
        if (!server.isConnected()) return reply(res, 503, { error: "the extension is not connected (is Chrome open with CopperOS?)" });
        // The extension drives one tab at a time, so tasks never overlap.
        if (runningIds().size > 0) return reply(res, 409, { error: "busy: another task is running" });

        // A fresh chat per task: never mixed into the person's own chats.
        const agent = register(Agent.blank(USER));
        const mode = (["all", "submits", "none"] as const).find((m) => m === body.approvalMode) ?? "submits";
        await agent.setApprovalMode(mode);
        const limit = Math.min(Math.max(Number(body.timeoutMs) || 600_000, 30_000), 1_800_000);
        const extras: TaskExtras = body.rules?.trim() ? { rules: body.rules.trim().slice(0, 2000) } : {};
        const outcome = await runTask(agent, text, extras, limit);

        // A caller waiting on an answer can't click Approve in the panel, so a
        // task that stopped to ask is ended rather than left waiting.
        if (outcome.status === "paused") {
          const request = await agent.cancelPause();
          if (request) withdrawRequest(request.id);
          const run = runOf(agent.info().id);
          run.busy = false;
          run.task = null;
          return reply(res, 200, { status: "blocked", chatId: agent.info().id, request: outcome.request });
        }
        return reply(res, 200, { ...outcome, chatId: agent.info().id });
      }

      return reply(res, 404, { error: "not found" });
    } catch (err) {
      return reply(res, 500, { error: String((err as Error)?.message ?? err) });
    }
  })
    .on("error", (err) => exitIfPortTaken(err, port))
    .listen(port, "127.0.0.1", () => console.log(`[broker] task API on http://127.0.0.1:${port}`));
}

// One-shot CLI:  npm run task -- "find the pricing page"
const flagIndex = process.argv.indexOf("--task");
if (flagIndex !== -1) {
  const task = process.argv.slice(flagIndex + 1).join(" ").trim();
  if (!task) {
    console.error('[broker] --task needs text, e.g. --task "open example.com"');
    process.exit(1);
  }
  void (async () => {
    await server.waitForExtension();
    const agent = register(await Agent.resumeLast(USER));
    await runTask(agent, task, {});
    // A task that paused for you carries on once you answer in the panel.
    while (runOf(agent.info().id).busy) await sleep(500);
    process.exit(0);
  })();
}

process.on("SIGINT", () => {
  if (server.isConnected()) emit("error", null, "Broker shutting down.");
  process.exit(0);
});
// `kill` and launchd's stop both send SIGTERM. Exiting cleanly tells a
// supervisor (e.g. a KeepAlive launch agent) this was a stop, not a crash.
process.on("SIGTERM", () => process.exit(0));

/**
 * Another broker already holds the port, often a background one started by a
 * launch agent. Say so and exit 0, so a supervisor doesn't keep relaunching a
 * duplicate that can never bind.
 */
function exitIfPortTaken(err: Error, port: number): never {
  if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
  console.error(
    `[broker] port ${port} is already in use, probably by another broker.\n` +
    `[broker]   see what holds it:  lsof -nP -iTCP:${port} -sTCP:LISTEN\n` +
    `[broker]   a background one from a launch agent comes back when killed; list them with\n` +
    `[broker]   grep -l browsercontrol ~/Library/LaunchAgents/*.plist  and stop it with\n` +
    `[broker]   launchctl bootout gui/$(id -u)/<label>  (for AImarketing: mkt browser-uninstall)`,
  );
  process.exit(0);
}
