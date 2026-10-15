// Stopping a chat's task and changing its approvals and supervisor, for whoever
// asks: the relay, when the panel does, and the MCP endpoint, when a connected
// AI does. A task that is running holds its chat's transcript, so a change is
// handed to the task's own worker rather than written underneath it.

import { Agent } from "../agent.js";
import type { ApprovalMode } from "../session.js";
import { CloudStore } from "../store/cloud.js";
import { post, postToExtensions, workersOf } from "./connections.js";

const cloud = new CloudStore();

/** Stop, as the panel's Stop does it. */
export async function cancelChat(userId: string, chatId: string): Promise<void> {
  await postToExtensions(userId, { type: "agent_event", event: "cancelled", chatId, text: "" });
  // A paused task has no run to stop: cancel it where it waits.
  if (await cloud.claimPending(userId, chatId)) {
    await (await Agent.forChat(userId, chatId)).cancelPause();
    return;
  }
  // A long task between two Lambdas has no worker to hear this: the mark tells the next one.
  await cloud.markCancelled(userId, chatId);
  for (const w of await workersOf(userId, chatId)) await post(w.connectionId, { type: "cancel" });
}

/** Whether a task is running in the chat right now, not paused. */
async function running(userId: string, chatId: string): Promise<boolean> {
  const item = await cloud.chatItem(userId, chatId);
  return Boolean(item?.run && item.run.until > Date.now() && !item.pending);
}

export async function setApprovalMode(userId: string, chatId: string, mode: ApprovalMode): Promise<void> {
  if (await running(userId, chatId)) {
    for (const w of await workersOf(userId, chatId)) await post(w.connectionId, { type: "set_approval_mode", mode });
    return;
  }
  await (await Agent.forChat(userId, chatId)).setApprovalMode(mode);
}

export async function setSupervisor(userId: string, chatId: string, on: boolean): Promise<void> {
  if (await running(userId, chatId)) {
    for (const w of await workersOf(userId, chatId)) await post(w.connectionId, { type: "set_supervisor", on });
    return;
  }
  await (await Agent.forChat(userId, chatId)).setSupervisor(on);
}
