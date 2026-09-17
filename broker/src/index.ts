import "dotenv/config";
import { start, emit, sendChats, sendChatState, waitForExtension, isConnected, type ChatState } from "./bridge.js";
import { Agent, activeModelLabel, formatUsage, listChats } from "./agent.js";
import { setCurrent, type ApprovalMode } from "./session.js";
import { initConfig, getConfig, setConfig, listModels, type Provider } from "./config.js";

const PORT = Number(process.env.PORT ?? 7331);

await initConfig();

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
  return agents.get(id) ?? register(await Agent.forChat(id));
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
  };
}

async function runTask(agent: Agent, text: string) {
  const id = agent.info().id;
  const run = runOf(id);
  run.busy = true;
  run.task = text;
  run.cancelRequested = false;
  console.log(`\n[task ${id}] ${text}`);
  emit("start", id, text);

  try {
    const result = await agent.run(text);
    // Cancel already told the UI the moment it was clicked — the run
    // unwinding afterward (cleanly, or via an aborted tool/approval wait
    // throwing) is not a second, different outcome worth re-announcing.
    if (run.cancelRequested) {
      console.log(`[cancelled ${id}] ${result.steps} steps · ${formatUsage(result)}`);
    } else {
      console.log(`[done ${id}] ${result.steps} steps · ${formatUsage(result)}`);
      console.log(result.text);
      emit("done", id, `${result.steps} steps · ${formatUsage(result)}`);
    }
  } catch (err) {
    if (run.cancelRequested) {
      console.log(`[cancelled ${id}] stopped by user`);
    } else {
      const text = String((err as Error)?.message ?? err);
      console.error(`[error ${id}] ${text}`);
      emit("error", id, text);
    }
  } finally {
    run.busy = false;
    run.task = null;
  }
}

function runningIds(): Set<string> {
  return new Set([...runs.entries()].filter(([, r]) => r.busy).map(([id]) => id));
}

start(PORT, {
  onTask: (text, chatId) => {
    void (async () => {
      // No chatId at all is a defensive fallback (should not happen once the
      // extension has completed its hello handshake) — start somewhere fresh
      // rather than silently dropping the task.
      const agent = chatId ? await getAgent(chatId) : register(Agent.blank());
      const id = agent.info().id;
      if (runOf(id).busy) {
        emit("error", id, "This chat is already running a task — cancel it, or start/switch to another chat.");
        return;
      }
      void runTask(agent, text);
    })();
  },
  onCancel: (chatId) => {
    runOf(chatId).cancelRequested = true;
    agents.get(chatId)?.cancel();
    emit("cancelled", chatId, "");
  },
  onReset: () => {
    void (async () => {
      const agent = register(Agent.blank());
      const id = agent.info().id;
      await setCurrent(id);
      console.log(`[session] new chat ${id}`);
      sendChatState(await chatStateFor(id));
    })();
  },
  onListChats: () => {
    void (async () => {
      try {
        sendChats(await listChats(runningIds()));
      } catch (err) {
        emit("error", null, `Could not list chats: ${String((err as Error)?.message ?? err)}`);
      }
    })();
  },
  onSwitchChat: (id) => {
    void (async () => {
      try {
        await getAgent(id);
        await setCurrent(id);
        console.log(`[session] switched to chat ${id}`);
        sendChatState(await chatStateFor(id));
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
  onGetConfig: () => getConfig(),
  onSetConfig: (patch) => setConfig(patch as Parameters<typeof setConfig>[0]),
  onListModels: (provider) => listModels(provider),
  onHello: async (chatId) => {
    const agent = chatId ? await getAgent(chatId) : register(await Agent.resumeLast());
    const id = agent.info().id;
    await setCurrent(id);
    return chatStateFor(id);
  },
});

console.log(`[broker] model: ${activeModelLabel()}`);
console.log("[broker] load the unpacked extension, then type a task in its popup.");
console.log("[broker] change provider/model/API keys any time from the extension's Settings page.");

// Fail at startup rather than on the first task: a stopped Ollama or a model
// that was never pulled are both easy mistakes with unhelpful mid-run errors.
// Only meaningful when Ollama is the active provider.
void (async () => {
  const cfg = getConfig();
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

// One-shot CLI:  npm run task -- "find the pricing page"
const flagIndex = process.argv.indexOf("--task");
if (flagIndex !== -1) {
  const task = process.argv.slice(flagIndex + 1).join(" ").trim();
  if (!task) {
    console.error('[broker] --task needs text, e.g. --task "open example.com"');
    process.exit(1);
  }
  void (async () => {
    await waitForExtension();
    const agent = register(await Agent.resumeLast());
    await runTask(agent, task);
    process.exit(0);
  })();
}

process.on("SIGINT", () => {
  if (isConnected()) emit("error", null, "Broker shutting down.");
  process.exit(0);
});
