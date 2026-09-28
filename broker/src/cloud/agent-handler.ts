// The agent Lambda's entry point: started by the relay, asynchronously, for
// one piece of a task (see agent-run.ts).
//
// Jev's key comes from SSM and has to be in the environment before the agent
// core is first loaded — jev.ts reads it once, at load — so the core is
// imported only after it is fetched.

import { GetParameterCommand, ParameterNotFound, SSMClient } from "@aws-sdk/client-ssm";
import type { Context } from "aws-lambda";
import type { AgentJob } from "./jobs.js";

const ssm = new SSMClient({});
let keyLoaded = false;

async function loadJevKey(): Promise<void> {
  if (keyLoaded) return;
  try {
    const res = await ssm.send(
      new GetParameterCommand({ Name: process.env.JEV_PARAM, WithDecryption: true }),
    );
    process.env.JEV_AI_API_KEY = res.Parameter?.Value ?? "";
  } catch (err) {
    // No key stored: run without Jev, as a local broker with no key does.
    if (!(err instanceof ParameterNotFound)) throw err;
    console.warn(`[agent] no Jev key at ${process.env.JEV_PARAM} — running without Jev`);
  }
  keyLoaded = true;
}

export async function handler(job: AgentJob, context: Context): Promise<void> {
  await loadJevKey();
  const { runJob } = await import("./agent-run.js");
  await runJob(job, context.getRemainingTimeInMillis());
}
