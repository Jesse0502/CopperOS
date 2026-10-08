// What the relay asks the agent Lambda to do: start a task, or carry on a
// paused one with the person's answer. The agent Lambda asks itself for the
// third: carry on a long task whose last stretch ended with the Lambda's own
// time (agent-run.ts).

import type { ApprovalOutcome, AskOutcome } from "../bridge.js";
import type { TaskExtras } from "../task-extras.js";

export type AgentJob = {
  userId: string;
  chatId: string;
  /** The one-time pass the agent joins the socket with. */
  grant: string;
  /** The browser that asked — where ops go first. */
  connectionId: string | null;
} & (
  | { kind: "run"; text: string; extras?: TaskExtras }
  | { kind: "resume"; requestId: string; answer: ApprovalOutcome | AskOutcome }
  | { kind: "continue" }
);

/** A job before the relay has made its pass. */
export type AgentRequest = AgentJob extends infer J ? (J extends unknown ? Omit<J, "grant"> : never) : never;

/**
 * What the relay asks the agent Lambda to do besides running a task: write a
 * chat up as a workflow (workflows.ts). It needs the model's key, which only
 * the agent has, and answers straight to the person's browsers.
 */
export type DraftJob = { kind: "draft"; userId: string; chatId: string; request?: string };
