// What the relay asks the agent Lambda to do: start a task, or carry on a
// paused one with the person's answer.

import type { ApprovalOutcome, AskOutcome } from "../bridge.js";

export type AgentJob = {
  userId: string;
  chatId: string;
  /** The one-time pass the agent joins the socket with. */
  grant: string;
  /** The browser that asked — where ops go first. */
  connectionId: string | null;
} & (
  | { kind: "run"; text: string }
  | { kind: "resume"; requestId: string; answer: ApprovalOutcome | AskOutcome }
);

/** A job before the relay has made its pass. */
export type AgentRequest = AgentJob extends infer J ? (J extends unknown ? Omit<J, "grant"> : never) : never;
