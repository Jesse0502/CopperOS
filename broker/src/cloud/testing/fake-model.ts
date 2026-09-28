// A scripted stand-in for an LLM, deployed only to dev stacks (cdk.json's
// `testModel`), so the hosted pipeline — relay, agent Lambda, worker socket,
// pauses — can be tested end to end for free and with the same result every
// time. It speaks just enough of Ollama's API for the agent to use it as an
// "ollama" host. What it does is picked by a tag in the task's text:
//
//   [test:look]     take a snapshot, then report how much it read
//   [test:approve]  click e3 (gated in "All actions"), then say it did
//   [test:ask]      ask_user one question, then echo the answer
//   [test:multi]    snapshot, click e3 and read_page in one step
//
// Anything else — a fresh round's brief, a check-in, no tag — gets a plain
// final answer, so a tracked task always ends.

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

type Msg = { role: string; content?: unknown; tool_call_id?: string };

let seq = 0;
const call = (name: string, args: Record<string, unknown>) => ({
  id: `fake_${Date.now()}_${++seq}`,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p: any) => (p?.type === "text" ? p.text : "")).join("");
  return "";
}

function reply(messages: Msg[], toolChoice: unknown) {
  const say = (content: string) => ({ role: "assistant", content });
  if (toolChoice === "none") return say("Check-in: I am working on the test task and it is on track.");

  const last = messages.at(-1);
  if (last?.role === "user" && text(last.content).startsWith("[Fresh round")) {
    return say("Nothing more to do for this test.");
  }
  const at = messages.findLastIndex((m) => m.role === "user" && /\[test:\w+\]/.test(text(m.content)));
  if (at === -1) return say("Hi — this is the CopperOS test model.");
  const command = text(messages[at].content).match(/\[test:(\w+)\]/)![1];
  const results = messages.slice(at + 1).filter((m) => m.role === "tool").map((m) => text(m.content));

  if (results.length === 0) {
    const calls: Record<string, ReturnType<typeof call>[]> = {
      look: [call("snapshot", {})],
      approve: [call("click", { ref: "e3", why: "Press Go" })],
      ask: [call("ask_user", { questions: [{ question: "Which city?", options: ["Melbourne", "Sydney"] }] })],
      multi: [call("snapshot", {}), call("click", { ref: "e3", why: "Press Go" }), call("read_page", {})],
    };
    const tool_calls = calls[command];
    if (!tool_calls) return say(`Unknown test "${command}".`);
    return { role: "assistant", content: null, tool_calls };
  }
  const read = results.reduce((n, r) => n + r.length, 0);
  return say(`Test ${command} finished after ${results.length} tool result(s), ${read} characters read. Last: ${results.at(-1)!.slice(0, 120)}`);
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const json = (body: unknown) => ({
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const path = event.rawPath;
  if (path === "/api/show") return json({ capabilities: ["completion", "tools"] });
  if (path === "/api/tags") return json({ models: [{ name: "fake" }] });
  if (path !== "/v1/chat/completions") return { statusCode: 404, body: "not found" };

  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body ?? "{}";
  const body = JSON.parse(raw) as { messages?: Msg[]; tool_choice?: unknown };
  const message = reply(body.messages ?? [], body.tool_choice);
  return json({
    id: `fake-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "fake",
    choices: [{ index: 0, message, finish_reason: "tool_calls" in message ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
}
