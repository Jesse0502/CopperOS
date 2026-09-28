// Every WebSocket event, the hosted counterpart of index.ts. It speaks the
// same protocol as the local broker, so the extension's panel works the same
// against either. Quick things are answered here — the chat list, switching
// chats, settings, a cancel. A task, or the answer a paused task was waiting
// on, starts the agent Lambda, which runs it and reports straight to the
// browser; the extension's op results come back through here and are handed
// to that task's worker connection.

import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { Agent, listChats } from "../agent.js";
import { requestChatId, requestMessage, type AskOutcome } from "../bridge.js";
import { getConfig, initConfig, listModels, setConfig, type LLMConfig, type Provider } from "../config.js";
import { setCurrent, type ApprovalMode } from "../session.js";
import { busy, CloudStore, deleteUserData, type ChatItem } from "../store/cloud.js";
import { useStore } from "../store/store.js";
import {
  createGrant,
  forgetConnection,
  getConnection,
  post,
  postToExtensions,
  recordConnection,
  workersOf,
  type Kind,
} from "./connections.js";
import type { AgentJob, AgentRequest } from "./jobs.js";

const store = new CloudStore();
useStore(store);
const lambda = new LambdaClient({});
const cognito = new CognitoIdentityProviderClient({});
// A task's active time on the free plan; the panel counts it down.
const TASK_LIMIT_MS = Number(process.env.TASK_LIMIT_MS ?? 15 * 60_000);

/** What the authorizer said about the connection, on every event for it. */
type Event = APIGatewayProxyWebsocketEventV2 & {
  requestContext: { authorizer?: { userId?: string; kind?: Kind; chatId?: string } };
};

const OK = { statusCode: 200 };

export async function handler(event: Event): Promise<APIGatewayProxyResultV2> {
  const { routeKey, connectionId } = event.requestContext;
  const auth = event.requestContext.authorizer ?? {};

  if (routeKey === "$connect") {
    if (!auth.userId) return { statusCode: 401 };
    await recordConnection(connectionId, auth.userId, auth.kind ?? "extension", auth.chatId);
    return OK;
  }
  if (routeKey === "$disconnect") {
    await forgetConnection(connectionId);
    return OK;
  }

  let msg: any;
  try {
    msg = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400 };
  }
  const who = auth.userId
    ? { userId: auth.userId, kind: auth.kind ?? "extension" }
    : await getConnection(connectionId);
  if (!who) return { statusCode: 410 };

  if (msg.type === "ping") {
    await post(connectionId, { type: "pong" });
    return OK;
  }
  // A worker only keeps its connection alive; everything it says goes
  // straight to the browser.
  if (who.kind === "worker") return OK;

  // An op result (whole, or a chunk of a big one) for a running task.
  if (msg.type === "chunk" || (typeof msg.id === "string" && "ok" in msg)) {
    await Promise.all((await workersOf(who.userId)).map((w) => post(w.connectionId, msg)));
    return OK;
  }

  try {
    await handle(who.userId, connectionId, msg);
  } catch (err) {
    console.error(`[relay] ${msg.type}: ${String((err as Error)?.stack ?? err)}`);
    await post(connectionId, {
      type: "agent_event",
      event: "error",
      chatId: typeof msg.chatId === "string" ? msg.chatId : null,
      text: `Something went wrong: ${String((err as Error)?.message ?? err)}`,
    });
  }
  return OK;
}

async function handle(userId: string, from: string, msg: any): Promise<void> {
  await initConfig(userId);
  const reply = (message: unknown) => post(from, message);
  const say = (event: string, chatId: string | null, text: string) =>
    postToExtensions(userId, { type: "agent_event", event, chatId, text });

  switch (msg.type) {
    case "hello": {
      // Anything waiting on the person, in any chat, is shown again first —
      // the browser may have lost track of it along with its service worker.
      const items = await store.chatItems(userId);
      for (const item of items) if (item.pending) await reply(requestMessage(item.pending));
      const agent =
        typeof msg.chatId === "string"
          ? await Agent.forChat(userId, msg.chatId)
          : await Agent.resumeLast(userId);
      const id = agent.info().id;
      await setCurrent(userId, id);
      await reply({ type: "chat_state", ...state(agent, items.find((c) => c.chatId === id)) });
      return;
    }

    case "reset": {
      const agent = Agent.blank(userId);
      await setCurrent(userId, agent.info().id);
      await reply({ type: "chat_state", ...state(agent, undefined) });
      return;
    }

    case "switch_chat": {
      if (typeof msg.id !== "string") return;
      const agent = await Agent.forChat(userId, msg.id);
      await setCurrent(userId, msg.id);
      await reply({ type: "chat_state", ...state(agent, (await store.chatItem(userId, msg.id)) ?? undefined) });
      return;
    }

    case "list_chats": {
      const running = new Set((await store.chatItems(userId)).filter((c) => busy(c)).map((c) => c.chatId));
      await reply({ type: "chats", chats: await listChats(userId, running) });
      return;
    }

    case "task": {
      if (typeof msg.text !== "string" || !msg.text.trim()) return;
      const chatId = typeof msg.chatId === "string" ? msg.chatId : Agent.blank(userId).info().id;
      if (!(await store.claimRun(userId, chatId, msg.text))) {
        await say("error", chatId, "This chat is already running a task — cancel it, or start/switch to another chat.");
        return;
      }
      await say("start", chatId, msg.text);
      await postToExtensions(userId, { type: "clock", chatId, limitMs: TASK_LIMIT_MS, usedMs: 0, ticking: true });
      await startAgent({ kind: "run", text: msg.text, userId, chatId, connectionId: from });
      return;
    }

    case "approval":
    case "answers": {
      if (typeof msg.id !== "string") return;
      const chatId = requestChatId(msg.id);
      if (!chatId) return;
      const item = await store.chatItem(userId, chatId);
      // Answered twice, or its task was cancelled since: nothing waits on it.
      if (!item || item.pending?.id !== msg.id) return;
      const answer =
        msg.type === "approval"
          ? msg.approved
            ? ("approved" as const)
            : ("denied" as const)
          : askOutcome(msg);
      const usedMs = item.run?.usedMs ?? 0;
      if (!(await store.claimRun(userId, chatId, item.run?.task ?? null, msg.id, usedMs))) return;
      await postToExtensions(userId, { type: "clock", chatId, limitMs: TASK_LIMIT_MS, usedMs, ticking: true });
      await startAgent({ kind: "resume", requestId: msg.id, answer, userId, chatId, connectionId: from });
      return;
    }

    case "cancel": {
      if (typeof msg.chatId !== "string") return;
      await say("cancelled", msg.chatId, "");
      // A paused task has no run to stop: cancel it where it waits.
      if (await store.claimPending(userId, msg.chatId)) {
        await (await Agent.forChat(userId, msg.chatId)).cancelPause();
        return;
      }
      for (const w of await workersOf(userId, msg.chatId)) await post(w.connectionId, { type: "cancel" });
      return;
    }

    case "set_approval_mode": {
      if (typeof msg.chatId !== "string" || !["all", "submits", "none"].includes(msg.mode)) return;
      const item = await store.chatItem(userId, msg.chatId);
      // A running task holds the chat's transcript: tell it rather than
      // writing underneath it.
      if (item?.run && item.run.until > Date.now() && !item.pending) {
        for (const w of await workersOf(userId, msg.chatId)) {
          await post(w.connectionId, { type: "set_approval_mode", mode: msg.mode });
        }
        return;
      }
      await (await Agent.forChat(userId, msg.chatId)).setApprovalMode(msg.mode as ApprovalMode);
      return;
    }

    case "get_config": {
      await reply({ type: "config", config: withoutKeys(getConfig(userId)) });
      return;
    }

    case "set_config": {
      const patch = (msg.patch ?? {}) as Partial<Record<keyof LLMConfig, any>>;
      if (patch.provider === "ollama") {
        await reply({
          type: "agent_event",
          event: "error",
          chatId: null,
          text: "Ollama runs on your own computer, so the hosted CopperOS cannot reach it. Choose OpenRouter or OpenAI.",
        });
        await reply({ type: "config", config: withoutKeys(getConfig(userId)) });
        return;
      }
      delete patch.ollama;
      // Keys are never sent to the page, so it sends them back blank: blank
      // means "keep the one saved".
      for (const p of ["openai", "openrouter"] as const) {
        if (patch[p] && !patch[p].apiKey) delete patch[p].apiKey;
      }
      await reply({ type: "config", config: withoutKeys(await setConfig(userId, patch)) });
      return;
    }

    case "delete_account": {
      // Stop anything still running first, and wait for it to finish, so
      // nothing writes after the delete.
      for (const w of await workersOf(userId)) await post(w.connectionId, { type: "cancel" });
      for (let waited = 0; waited < 20_000 && (await workersOf(userId)).length > 0; waited += 1000) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      const removed = await deleteUserData(userId);
      await deleteSignIn(userId);
      console.log(`[relay] deleted an account: ${removed.items} items, ${removed.transcripts} transcripts`);
      await postToExtensions(userId, { type: "account_deleted" });
      return;
    }

    case "list_models": {
      const provider = msg.provider as Provider;
      try {
        if (provider === "ollama") throw new Error("Ollama is not available in the hosted CopperOS.");
        await reply({ type: "models", provider, models: await listModels(userId, provider) });
      } catch (err) {
        await reply({ type: "models", provider, error: String((err as Error)?.message ?? err) });
      }
      return;
    }
  }
}

function state(agent: Agent, item: ChatItem | undefined) {
  const info = agent.info();
  const running = busy(item);
  return {
    id: info.id,
    events: agent.replay(),
    running,
    task: running ? (item?.run?.task ?? info.lastTask) : null,
    approvalMode: info.approvalMode,
    clock: running ? clockOf(item!) : null,
  };
}

/** Where a busy chat's task stands against its time limit. */
function clockOf(item: ChatItem) {
  const run = item.run;
  const waiting = Boolean(item.pending);
  const usedMs = (run?.usedMs ?? 0) + (run && !waiting ? Date.now() - run.startedAt : 0);
  return { limitMs: TASK_LIMIT_MS, usedMs, ticking: !waiting };
}

function askOutcome(msg: any): AskOutcome {
  if (msg.dismissed) return "dismissed";
  return {
    answers: (Array.isArray(msg.answers) ? msg.answers : []).map((a: unknown) =>
      typeof a === "string" && a.trim() ? a.trim() : null,
    ),
  };
}

/** Settings as the page may see them: which keys are saved, never the keys. */
function withoutKeys(config: LLMConfig) {
  return {
    ...config,
    openai: { model: config.openai.model, apiKey: "", hasKey: Boolean(config.openai.apiKey) },
    openrouter: { model: config.openrouter.model, apiKey: "", hasKey: Boolean(config.openrouter.apiKey) },
  };
}

/** The user's Cognito sign-in, found by the id the token carries (for Google users it differs from their username). */
async function deleteSignIn(userId: string): Promise<void> {
  const pool = process.env.USER_POOL_ID;
  const found = await cognito.send(
    new ListUsersCommand({ UserPoolId: pool, Filter: `sub = "${userId.replace(/"/g, "")}"`, Limit: 1 }),
  );
  const username = found.Users?.[0]?.Username;
  if (username) await cognito.send(new AdminDeleteUserCommand({ UserPoolId: pool, Username: username }));
}

async function startAgent(job: AgentRequest): Promise<void> {
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
    await store.endRun(job.userId, job.chatId, false);
    throw err;
  }
}
