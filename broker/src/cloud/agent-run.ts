// One piece of a task in the agent Lambda: a new task, or a paused one
// carried on with the person's answer. Runs until the task finishes, pauses
// for the person again, or reaches its time limit, with the same agent core
// as the local broker, then gives the chat back.

import { Agent, formatUsage } from "../agent.js";
import { emit, showRequest, useTransport } from "../bridge.js";
import { initConfig } from "../config.js";
import type { ApprovalMode } from "../session.js";
import { CloudStore } from "../store/cloud.js";
import { useStore } from "../store/store.js";
import { CloudTransport } from "../transport/cloud.js";
import type { AgentJob } from "./jobs.js";

const store = new CloudStore();
useStore(store);

// A task's active time, across its pauses. Waiting on the person never counts.
const TASK_LIMIT_MS = Number(process.env.TASK_LIMIT_MS ?? 15 * 60_000);
// Stop this far before the Lambda would be cut off, to save the turn cleanly.
const LAMBDA_MARGIN_MS = 20_000;

export async function runJob(job: AgentJob, lambdaMsLeft: number): Promise<void> {
  const { userId, chatId } = job;
  const endBy = Date.now() + lambdaMsLeft - LAMBDA_MARGIN_MS;
  await initConfig(userId);

  let agent: Agent | null = null;
  let cancelled = false;
  const transport = new CloudTransport(userId, job.connectionId, (control) => {
    if (control.type === "cancel") {
      cancelled = true;
      agent?.cancel();
    } else if (control.type === "set_approval_mode" && agent) {
      void agent.setApprovalMode(control.mode as ApprovalMode);
    }
  });
  useTransport(transport);

  let paused = false;
  try {
    await transport.open(job.grant);
    agent = await Agent.forChat(userId, chatId);
    if (cancelled) return;
    const options = { limitMs: TASK_LIMIT_MS, endBy };
    const result =
      job.kind === "run"
        ? await agent.run(job.text, options)
        : await agent.resume(job.requestId, job.answer, options);

    if (result.paused) {
      paused = true;
      showRequest(result.paused);
      console.log(`[agent ${chatId}] waiting on the user: ${result.paused.kind}`);
    } else if (cancelled) {
      // The relay told the panel the moment Cancel was clicked.
      console.log(`[agent ${chatId}] cancelled · ${formatUsage(result)}`);
    } else if (result.timeUp) {
      console.log(`[agent ${chatId}] time's up · ${formatUsage(result)}`);
      emit("cancelled", chatId, result.text);
    } else {
      console.log(`[agent ${chatId}] done · ${result.steps} steps · ${formatUsage(result)}`);
      emit("done", chatId, `${result.steps} steps · ${formatUsage(result)}`);
    }
  } catch (err) {
    const text = String((err as Error)?.message ?? err);
    console.error(`[agent ${chatId}] ${(err as Error)?.stack ?? text}`);
    if (!cancelled) emit("error", chatId, text);
  } finally {
    // A paused task keeps its request on the chat; anything else frees it.
    await store.endRun(userId, chatId, paused).catch((err) =>
      console.error(`[agent ${chatId}] could not free the chat: ${String(err)}`),
    );
    await transport.close();
  }
}
