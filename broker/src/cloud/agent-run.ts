// One piece of a task in the agent Lambda: a new task, a paused one carried on
// with the person's answer, or a long one carried on from where the last
// Lambda had to stop. Runs until the task finishes, pauses for the person
// again, reaches its time limit, or reaches the end of this Lambda, with the
// same agent core as the local broker, then gives the chat back.
//
// How long a task may run depends on the plan (runtime.ts): the trial's is 15
// minutes, which fits in one Lambda. A longer one is handed from Lambda to
// Lambda. Near the end of its 15 minutes a Lambda stops at a step boundary
// and saves where the task stands; the chat stays claimed; and the Lambda
// asks for another, which picks the task up and joins the same socket. The
// person sees one task, with one timer.

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { Agent, formatUsage } from "../agent.js";
import { emit, showRequest, useTransport } from "../bridge.js";
import { initConfig, jevFor } from "../config.js";
import { withJev } from "../jev.js";
import { UsageLimitError } from "../meter.js";
import type { ApprovalMode } from "../session.js";
import { CloudStore } from "../store/cloud.js";
import { useStore } from "../store/store.js";
import { CloudTransport } from "../transport/cloud.js";
import { PLAN_NAMES, planOf, weekOf, type PlanId } from "./billing.js";
import { createGrant, postToExtensions } from "./connections.js";
import type { AgentJob, DraftJob } from "./jobs.js";
import { dynamoLedger, installBilling, loadRuntime } from "./ledger.js";
import { budgetOf, limitFor, spanText } from "./runtime.js";

const store = new CloudStore();
useStore(store);
// Runs on CopperOS's own model are charged to the user's allowance and credits, and
// only a plan that allows it runs on its owner's own key.
installBilling();

const lambda = new LambdaClient({});

// Stop this far before the Lambda would be cut off, to save the turn cleanly.
const LAMBDA_MARGIN_MS = 20_000;

/** What the person is told when a task reaches the limit its plan sets. */
function limitMessage(plan: PlanId, why: "task" | "week"): (usedMs: number) => string {
  const name = PLAN_NAMES[plan];
  return (used) =>
    why === "week"
      ? `Stopped: this week's running time on ${name} is used up. It starts again on Monday (UTC), and then "continue" picks the task up where it left off.`
      : plan === "ore"
        ? `Stopped after ${spanText(used)} of work, the most one task can run in the trial. Say "continue" and it picks up where it left off, or choose a plan for longer tasks (Settings → Plans & credits).`
        : `Stopped after ${spanText(used)} of work, the most one task can run on ${name}. Say "continue" and it picks up where it left off.`;
}

/** Another Lambda for the same task, to carry on where this one has to stop. False if it could not be asked. */
async function handOff(job: AgentJob, usedMs: number): Promise<boolean> {
  const name = process.env.AGENT_FUNCTION_NAME;
  if (!name) {
    console.error("[agent] AGENT_FUNCTION_NAME is not set: a long task cannot be handed on");
    return false;
  }
  try {
    // Keeps the chat taken through the gap; false if the person cancelled meanwhile.
    if (!(await store.extendRun(job.userId, job.chatId, usedMs))) return false;
    const next: AgentJob = {
      kind: "continue",
      userId: job.userId,
      chatId: job.chatId,
      connectionId: job.connectionId,
      grant: await createGrant(job.userId, job.chatId),
    };
    await lambda.send(
      new InvokeCommand({ FunctionName: name, InvocationType: "Event", Payload: Buffer.from(JSON.stringify(next)) }),
    );
    return true;
  } catch (err) {
    console.error(`[agent ${job.chatId}] could not hand the task on: ${String((err as Error)?.stack ?? err)}`);
    return false;
  }
}

export async function runJob(job: AgentJob, lambdaMsLeft: number): Promise<void> {
  const startedAt = Date.now();
  await initConfig(job.userId);
  // Every Jev judgment in this run goes to the user's Jev: CopperOS's, theirs on Foundry, or none.
  return withJev(jevFor(job.userId), () => runJobAs(job, startedAt + lambdaMsLeft - LAMBDA_MARGIN_MS, startedAt));
}

async function runJobAs(job: AgentJob, endBy: number, startedAt: number): Promise<void> {
  const { userId, chatId } = job;

  let agent: Agent | null = null;
  let cancelled = false;
  const transport = new CloudTransport(userId, job.connectionId, (control) => {
    if (control.type === "cancel") {
      cancelled = true;
      agent?.cancel();
    } else if (control.type === "set_approval_mode" && agent) {
      void agent.setApprovalMode(control.mode as ApprovalMode);
    } else if (control.type === "set_supervisor" && agent) {
      void agent.setSupervisor(control.on === true);
    }
  });
  useTransport(transport);

  let paused = false;
  let handedOn = false;
  let usedMs = 0;
  try {
    await transport.open(job.grant);
    // A task that was cancelled between two Lambdas has nobody to hear it: the mark on its run does.
    if (job.kind === "continue" && !(await store.continueRun(userId, chatId))) {
      console.log(`[agent ${chatId}] cancelled between stretches`);
      return;
    }
    agent = await Agent.forChat(userId, chatId);
    if (cancelled) return;

    // The plan's limits, as of now: how long this task may run in all, and what is left of the week.
    const now = Date.now();
    const plan = planOf(await dynamoLedger.account(userId), now);
    const rules = (await loadRuntime())[plan];
    const budget = budgetOf(rules, await dynamoLedger.weekActive(userId, weekOf(now).id));
    const { limitMs, why } = limitFor(budget, job.kind === "run" ? 0 : agent.workedMs());
    const options = { limitMs, endBy, limitMessage: limitMessage(plan, why) };

    const result =
      job.kind === "run"
        ? await agent.run(job.text, { ...options, ...job.extras })
        : job.kind === "resume"
          ? await agent.resume(job.requestId, job.answer, options)
          : await agent.continueSlice(options);

    usedMs = result.timeUsedMs ?? 0;
    if (result.paused) {
      paused = true;
      showRequest(result.paused);
      console.log(`[agent ${chatId}] waiting on the user: ${result.paused.kind}`);
    } else if (cancelled || agent.stopped()) {
      // The relay told the panel the moment Cancel was clicked. A run the
      // extension stopped (it refuses ops once the person stops the chat
      // there) is announced here, since no cancel came through to say it.
      if (!cancelled) emit("cancelled", chatId, "");
      console.log(`[agent ${chatId}] cancelled · ${formatUsage(result)}`);
    } else if (result.timeUp && result.slice) {
      // Only this Lambda's time is up: the task goes on, and the person sees nothing change.
      handedOn = await handOff(job, usedMs);
      if (handedOn) {
        console.log(`[agent ${chatId}] handed on after ${spanText(Date.now() - startedAt)} · ${formatUsage(result)}`);
      } else if (!(await store.continueRun(userId, chatId).catch(() => false))) {
        console.log(`[agent ${chatId}] cancelled while being handed on`);
      } else {
        emit("error", chatId, "The task could not be carried on after its first stretch. Say \"continue\" to pick it up.");
      }
    } else if (result.timeUp) {
      console.log(`[agent ${chatId}] time's up · ${formatUsage(result)}`);
      emit("cancelled", chatId, result.text);
    } else {
      console.log(`[agent ${chatId}] done · ${result.steps} steps · ${formatUsage(result)}`);
      emit("done", chatId, `${result.steps} steps · ${formatUsage(result)}`);
    }
  } catch (err) {
    const text = String((err as Error)?.message ?? err);
    if (err instanceof UsageLimitError) {
      // Not a fault: the user's allowance is spent. They are told what to do.
      console.log(`[agent ${chatId}] out of usage (${err.info.plan})`);
      if (!cancelled) emit("error", chatId, text);
    } else if (agent?.stopped()) {
      // Stop landing mid-request rejects it ("Request was aborted"): a cancel, not a fault.
      console.log(`[agent ${chatId}] cancelled mid-request`);
      if (!cancelled) emit("cancelled", chatId, "");
    } else {
      console.error(`[agent ${chatId}] ${(err as Error)?.stack ?? text}`);
      if (!cancelled) emit("error", chatId, text);
    }
  } finally {
    // The time this Lambda worked counts against the week, however it ended.
    await dynamoLedger
      .addActive(userId, weekOf(Date.now()).id, Date.now() - startedAt)
      .catch((err) => console.error(`[agent ${chatId}] could not record working time: ${String(err)}`));
    // A paused task keeps its request on the chat, and one handed on stays claimed
    // for the next Lambda; anything else frees the chat.
    if (!handedOn) {
      await store.endRun(userId, chatId, paused, usedMs).catch((err) =>
        console.error(`[agent ${chatId}] could not free the chat: ${String(err)}`),
      );
    }
    await transport.close();
  }
}

/**
 * A chat written up as a workflow, sent to the person's browsers: the draft,
 * or why there is none (nothing in the chat to write from, or no usage left).
 */
export async function runDraft(job: DraftJob): Promise<void> {
  try {
    await initConfig(job.userId);
    const agent = await Agent.forChat(job.userId, job.chatId);
    const draft = await withJev(jevFor(job.userId), () => agent.draftWorkflow(job.request));
    await postToExtensions(job.userId, { type: "workflow_draft", ...draft });
  } catch (err) {
    console.log(`[draft ${job.chatId}] ${String((err as Error)?.message ?? err)}`);
    await postToExtensions(job.userId, {
      type: "workflow_draft",
      error: String((err as Error)?.message ?? err),
    });
  }
}
