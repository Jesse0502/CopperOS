// The agent Lambda's entry point: started by the relay, asynchronously, for
// one piece of a task (see agent-run.ts).
//
// Jev's key comes from SSM and has to be in the environment before the agent
// core is first loaded — jev.ts reads it once, at load — so the core is
// imported only after it is fetched. So does the key of CopperOS's own model,
// which every user not on a key of their own runs on.

import { GetParameterCommand, ParameterNotFound, SSMClient } from "@aws-sdk/client-ssm";
import type { Context } from "aws-lambda";
import type { AgentJob, DraftJob } from "./jobs.js";

const ssm = new SSMClient({});
let keyLoaded = false;

/** Puts the key stored at `param` into the environment variable `into`; false if none is stored. */
async function loadKey(param: string | undefined, into: string): Promise<boolean> {
  if (!param) return false;
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: param, WithDecryption: true }));
    process.env[into] = res.Parameter?.Value ?? "";
    return true;
  } catch (err) {
    if (!(err instanceof ParameterNotFound)) throw err;
    return false;
  }
}

async function loadKeys(): Promise<void> {
  if (keyLoaded) return;
  // No Jev key stored: run without Jev, as a local broker with no key does.
  if (!(await loadKey(process.env.JEV_PARAM, "JEV_AI_API_KEY"))) {
    console.warn(`[agent] no Jev key at ${process.env.JEV_PARAM} — running without Jev`);
  }
  // No model key stored: users on CopperOS's own model are told it is not available.
  if (!(await loadKey(process.env.PLATFORM_KEY_PARAM, "PLATFORM_OPENROUTER_KEY"))) {
    console.warn(`[agent] no model key at ${process.env.PLATFORM_KEY_PARAM} — only users with their own key can run`);
  }
  keyLoaded = true;
}

export async function handler(job: AgentJob | DraftJob, context: Context): Promise<void> {
  await loadKeys();
  const { runDraft, runJob } = await import("./agent-run.js");
  if (job.kind === "draft") return runDraft(job);
  await runJob(job, context.getRemainingTimeInMillis());
}
