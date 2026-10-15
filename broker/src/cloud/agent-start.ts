// Starting the agent Lambda for a task, for whoever asked: the relay, when the
// panel sends one, and the MCP endpoint, when a connected AI does.

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CloudStore } from "../store/cloud.js";
import { createGrant } from "./connections.js";
import type { AgentJob, AgentRequest } from "./jobs.js";

const lambda = new LambdaClient({});
const cloud = new CloudStore();

/** Asks the agent Lambda to run `job`. If that cannot be done the chat is freed for another try, and the error goes on. */
export async function startAgent(job: AgentRequest): Promise<void> {
  try {
    const full: AgentJob = { ...job, grant: await createGrant(job.userId, job.chatId) };
    await lambda.send(
      new InvokeCommand({
        FunctionName: process.env.AGENT_FUNCTION,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify(full)),
      }),
    );
  } catch (err) {
    // Nothing is running after all: free the chat for another try.
    await cloud.endRun(job.userId, job.chatId, false);
    throw err;
  }
}
