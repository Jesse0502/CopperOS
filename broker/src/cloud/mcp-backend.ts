// What a connected AI gets on the hosted service: the same chats, memories and
// molds the person's panel has, and the same Lambdas running its tasks. It
// reaches them as the person (their user id, from the token it signed in with).
//
// An AI can ask for far more work than a person clicking: a loop that starts a
// task every few seconds. So starting one goes through checks the panel does not
// have, before anything is launched and before any model call is made:
//   - a hold per person, so requests at the same moment cannot start two tasks;
//   - one task at a time, the same rule as the local broker (the browser drives
//     one tab), looked at with a read that sees the last write;
//   - a cap on tasks started per hour;
//   - the usage meter and the week's running time, asked up front, so a person
//     whose usage is spent is told so and no Lambda is started for nothing.
// The meter inside a running task (meter.ts) is unchanged and still stops it.
//
// What lowers CopperOS's guard, or adds something it treats as the person's own
// words, is off unless the person has turned it on in Settings (ai-apps.ts):
// lowering approvals, the supervisor off, memories and molds written. Those tools
// are not even offered while it is off.

import { Agent } from "../agent.js";
import { isLoosening, moldPrompt, settingsProblem, turnsOf, waitingOf } from "../ai-access.js";
import type { Backend, ChatBrief, ChatDetail, ChatStatus, Mold } from "../client/backend.js";
import { initConfig, jevFor, usesPlatformKey } from "../config.js";
import { withJev } from "../jev.js";
import { addUserMemory, deleteMemoryByKey, memoriesForPage } from "../memory.js";
import { meterFor, UsageLimitError } from "../meter.js";
import { busy, CloudStore, type ChatItem } from "../store/cloud.js";
import type { TaskExtras } from "../task-extras.js";
import { deleteWorkflow, listWorkflows, saveWorkflow } from "../workflows.js";
import { startAgent } from "./agent-start.js";
import { budgetOf } from "./runtime.js";
import { cancelChat, setApprovalMode, setSupervisor } from "./chat-control.js";
import { extensionsOf, postToExtensions } from "./connections.js";
import { dynamoLedger, loadLimits, loadRuntime } from "./ledger.js";
import { PLAN_NAMES, planOf, usageSummary, weekOf } from "./billing.js";
import type { AuthStore } from "./mcp-store.js";

export const LIMITS = {
  /** Requests to the endpoint, per person per minute. A wait polls inside one request, so this is generous. */
  requestsPerMinute: Number(process.env.MCP_REQUESTS_PER_MIN ?? 120),
  /** Tasks a connected AI may start per person per hour. */
  startsPerHour: Number(process.env.MCP_STARTS_PER_HOUR ?? 30),
};

/** Counts one request for `userId` against this minute's limit: true if it may go on. */
export async function requestAllowed(auth: AuthStore, userId: string, now = Date.now()): Promise<boolean> {
  const minute = Math.floor(now / 60_000);
  return (await auth.increment(`rate:req:${userId}:${minute}`, 120)) <= LIMITS.requestsPerMinute;
}

const REFUSED =
  "Not allowed for connected AI apps: lowering approvals, turning the supervisor off, and adding memories or molds. " +
  "The person can allow it in CopperOS Settings, under MCP, or do it themselves in the panel.";

const MAX_SEARCHED = 30;

const cloud = new CloudStore();

const statusOf = (item: ChatItem | null | undefined): ChatStatus => (item?.pending ? "waiting" : busy(item) ? "running" : "idle");

const briefOf = (c: ChatItem): ChatBrief => ({
  id: c.chatId,
  title: (c.title ?? "(empty chat)").slice(0, 120),
  updatedAt: c.updatedAt ?? c.createdAt ?? "",
  tasks: c.taskCount ?? 0,
  status: statusOf(c),
  ...(c.pending ? { waiting: waitingOf(c.pending) } : {}),
});

/**
 * Why a task cannot start for lack of usage, in words for the person — or null
 * if it can. The same meter and weekly running time a task meets as it runs,
 * asked before anything is launched.
 */
export async function usageProblem(userId: string, now = Date.now()): Promise<string | null> {
  await initConfig(userId);
  // Only a run on CopperOS's own model is metered; a Foundry account on its own key is not.
  if (usesPlatformKey(userId)) {
    const meter = meterFor(userId);
    if (!meter) throw new Error("Usage limits are not set up on this server.");
    try {
      await meter.check();
    } catch (err) {
      if (err instanceof UsageLimitError) return err.message;
      throw err;
    }
  }
  const plan = planOf(await dynamoLedger.account(userId), now);
  const budget = budgetOf((await loadRuntime())[plan], await dynamoLedger.weekActive(userId, weekOf(now).id));
  if (budget.weekLeftMs === 0) return `This week's running time on ${PLAN_NAMES[plan]} is used up. It starts again on Monday (UTC).`;
  return null;
}

export function cloudBackend(userId: string, auth: AuthStore, opts: { loosening?: boolean } = {}): Backend {
  const loosening = opts.loosening === true;
  const ready = () => initConfig(userId);

  async function itemOf(chatId: string): Promise<ChatItem> {
    const item = await cloud.chatItem(userId, chatId);
    if (!item) throw new Error("no chat with that id");
    return item;
  }

  async function search(query: string, limit: number, items: ChatItem[]) {
    const needle = query.toLowerCase();
    const recent = items.slice(0, MAX_SEARCHED);
    const texts = await Promise.all(
      recent.map(async (c) => {
        try {
          return turnsOf((await Agent.forChat(userId, c.chatId)).replay()).map((t) => t.text).join("\n");
        } catch {
          return ""; // unreadable: skipped, as in the chat list
        }
      }),
    );
    const found: ChatBrief[] = [];
    for (const [i, text] of texts.entries()) {
      const at = text.toLowerCase().indexOf(needle);
      if (at === -1) continue;
      found.push({ ...briefOf(recent[i]), match: text.slice(Math.max(0, at - 80), at + needle.length + 80).replace(/\s+/g, " ") });
      if (found.length >= limit) break;
    }
    return found;
  }

  return {
    maxWaitSeconds: 20,
    canWriteTrust: loosening,
    loosenNote: loosening
      ? "The person has allowed this app to lower approvals, turn the supervisor off, and add memories and molds. Do those only when they asked you to."
      : "Lowering approvals, turning the supervisor off, and adding memories or molds are not allowed for this app unless the person turns that on in CopperOS Settings.",

    async startTask(req) {
      const text = (req.text ?? "").trim();
      const moldId = (req.moldId ?? "").trim();
      if (!text && !moldId) throw new Error("task or mold_id is required");
      const asked = { approvalMode: req.approvalMode, supervisor: req.supervisor };
      if (asked.approvalMode !== undefined || asked.supervisor !== undefined) {
        const bad = settingsProblem(asked);
        if (bad) throw new Error(bad);
      }
      await ready();

      // The chat to use, and what it would be told.
      const existing = req.chatId?.trim() ? await itemOf(req.chatId.trim()) : null;
      const agent = existing ? await Agent.forChat(userId, existing.chatId) : Agent.blank(userId);
      const chatId = agent.info().id;
      if (!loosening && isLoosening(agent.info(), asked)) throw new Error(REFUSED);

      let prompt = text;
      const extras: TaskExtras = req.rules?.trim() ? { rules: req.rules.trim().slice(0, 2000) } : {};
      if (moldId) {
        const mold = (await listWorkflows(userId)).find((w) => w.id === moldId);
        if (!mold) throw new Error("no mold with that id");
        prompt = moldPrompt(mold, text);
        extras.fromMold = mold.id;
      }

      // Tasks run in the person's browser, and need it open.
      if ((await extensionsOf(userId)).length === 0) {
        throw new Error("Chrome with CopperOS is not connected. The person needs to open Chrome and be signed in to CopperOS.");
      }

      const startsKey = `rate:starts:${userId}:${Math.floor(Date.now() / 3_600_000)}`;
      if ((await auth.count(startsKey)) >= LIMITS.startsPerHour) {
        throw new Error(`Limit reached: ${LIMITS.startsPerHour} tasks started in the last hour from connected AIs. Try again later, or start tasks from the CopperOS panel.`);
      }

      // Of requests at the same moment, one gets to check and claim.
      const hold = `lock:start:${userId}`;
      if (!(await auth.lock(hold, 20))) throw new Error("Another task is being started for this account. Try again in a moment.");
      try {
        if ((await cloud.chatItems(userId, true)).some((c) => busy(c))) {
          throw new Error("busy: a task is already running, or waiting on the person, in the CopperOS panel. Stop it, or wait for it, then start another.");
        }
        const stop = await usageProblem(userId);
        if (stop) throw new Error(stop);
        if (!(await cloud.claimRun(userId, chatId, prompt))) throw new Error("This chat is already running a task.");
        try {
          if (asked.approvalMode !== undefined) await agent.setApprovalMode(asked.approvalMode);
          if (asked.supervisor !== undefined) await agent.setSupervisor(asked.supervisor);
          await postToExtensions(userId, { type: "agent_event", event: "start", chatId, text: prompt });
          if (extras.rules) await postToExtensions(userId, { type: "agent_event", event: "rules", chatId, text: extras.rules });
          await startAgent({ kind: "run", text: prompt, extras, userId, chatId, connectionId: null });
        } catch (err) {
          await cloud.endRun(userId, chatId, false).catch(() => {});
          throw err;
        }
        await auth.increment(startsKey, 3600);
      } finally {
        await auth.release(hold);
      }
      return { chatId, status: "running" };
    },

    async listChats(query, limit) {
      const items = (await cloud.chatItems(userId))
        .filter((c) => c.createdAt && ((c.taskCount ?? 0) > 0 || busy(c)))
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
      const n = Math.min(Math.max(limit ?? 20, 1), 100);
      if (query?.trim()) {
        await ready();
        return { chats: await search(query.trim(), n, items) };
      }
      return { chats: items.slice(0, n).map(briefOf) };
    },

    async getChat(chatId, turns): Promise<ChatDetail> {
      await ready();
      const item = await itemOf(chatId);
      const agent = await Agent.forChat(userId, chatId);
      const info = agent.info();
      const all = turnsOf(agent.replay());
      const task = await cloud.loadTask(userId, chatId);
      const status = statusOf(item);
      return {
        ...briefOf(item),
        createdAt: item.createdAt ?? "",
        ...(status === "running" ? { currentTask: item.run?.task ?? info.lastTask } : {}),
        settings: { approvalMode: info.approvalMode, supervisor: info.supervisor },
        // The supervisor needs the account's runs to have Jev (a Foundry account only with its own key).
        supervisorAvailable: jevFor(userId) !== null,
        ...(task
          ? {
              progress: {
                status: task.status,
                done: task.done.length,
                skipped: task.skipped.length,
                note: task.note.slice(0, 600),
                rounds: task.rounds,
                loop: task.loop === true,
              },
            }
          : {}),
        // A hosted task's steps go to the browser as they happen and are not kept.
        activity: [],
        totalTurns: all.length,
        turns: all.slice(-Math.min(Math.max(turns ?? 12, 1), 100)),
      };
    },

    async chatStatus(chatId) {
      return { status: statusOf(await itemOf(chatId)) };
    },

    async stopChat(chatId) {
      if (statusOf(await itemOf(chatId)) === "idle") return { chatId, stopped: false };
      await cancelChat(userId, chatId);
      return { chatId, stopped: true };
    },

    async setSettings(chatId, patch) {
      const bad = settingsProblem(patch);
      if (bad) throw new Error(bad);
      await ready();
      await itemOf(chatId);
      const info = (await Agent.forChat(userId, chatId)).info();
      if (!loosening && isLoosening(info, patch)) throw new Error(REFUSED);
      if (patch.approvalMode !== undefined) await setApprovalMode(userId, chatId, patch.approvalMode as "all" | "submits" | "none");
      if (patch.supervisor !== undefined) await setSupervisor(userId, chatId, patch.supervisor);
      return {
        chatId,
        settings: {
          approvalMode: (patch.approvalMode ?? info.approvalMode) as "all" | "submits" | "none",
          supervisor: patch.supervisor ?? info.supervisor,
        },
      };
    },

    async listMemories() {
      return { memories: await memoriesForPage(userId) };
    },
    async addMemory(text) {
      if (!loosening) throw new Error(REFUSED);
      await ready();
      await withJev(jevFor(userId), () => addUserMemory(userId, text));
      return { memories: await memoriesForPage(userId) };
    },
    async deleteMemory(key) {
      await deleteMemoryByKey(userId, key);
      return { memories: await memoriesForPage(userId) };
    },

    async listMolds() {
      return { molds: (await listWorkflows(userId)) as Mold[] };
    },
    async saveMold(mold) {
      if (!loosening) throw new Error(REFUSED);
      const molds = await saveWorkflow(userId, mold);
      // Newest change first: the one just saved.
      return { mold: molds[0] as Mold, total: molds.length };
    },
    async deleteMold(moldId) {
      return { total: (await deleteWorkflow(userId, moldId)).length };
    },

    async usage() {
      await ready();
      const u = await usageSummary(userId, dynamoLedger, loadLimits, Date.now(), loadRuntime);
      return {
        planName: u.planName,
        ownKey: !usesPlatformKey(userId),
        period: u.period,
        leftPct: u.leftPct,
        resetsAt: u.resetsAt,
        credits: u.credits,
        tokens: u.tokens,
        poolFull: u.poolFull,
        poolResetsAt: u.poolResetsAt,
        runtime: u.runtime,
      };
    },
  };
}
