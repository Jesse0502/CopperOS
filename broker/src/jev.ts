// Experiments 1 & 2 (jev branch): shadow classifiers.
//
// Both fire alongside the real tool-call path in tools.ts — one at gate(),
// one at describeAction() — purely to see how Jev's judgment compares with
// what the broker already does. Neither blocks its caller, throws into it,
// or influences whether an action proceeds. Silently a no-op when no key is
// configured, so this is invisible on any branch/setup that isn't
// experimenting with it.
//
// judgeMemoryWorth (experiment 3) follows the same shadow pattern for
// memory.ts's `remember` tool. suggestMemoryTopic does not: it is a real,
// blocking call whose answer actually shapes search_memory's ranking — the
// first non-shadow use of Jev in this file. Its own failure/timeout handling
// still falls back to a no-op (null), same as the shadow checks.

import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";

const apiKey = process.env.JEV_AI_API_KEY;
const client = apiKey ? new TypeSafeClient({ apiKey }) : null;

/** Fire-and-forget: ask Jev whether `what` looks destructive, log the verdict. */
export function judgeAction(kind: "click" | "submit", what: string, chatId: string): void {
  if (!client) return;
  void (async () => {
    const started = Date.now();
    try {
      const { answers } = await client.systemOne({
        state: what,
        questions: {
          risk: choice("Would performing this browser action be destructive or hard to undo?", {
            destructive: "Purchases, sends, posts, deletes, or confirms an irreversible change.",
            safe: "Easily undone, read-only, or has no lasting effect.",
          }),
        },
      });
      const { choice: verdict, confidence } = answers.risk;
      console.log(
        `[jev] chat=${chatId} kind=${kind} verdict=${verdict} confidence=${confidence.toFixed(2)} ` +
          `(${Date.now() - started}ms) — ${what}`,
      );
    } catch (err) {
      console.warn(`[jev] shadow check failed after ${Date.now() - started}ms: ${String(err)}`);
    }
  })();
}

/** Fire-and-forget: ask Jev whether `what` likely succeeded given its raw result, log the verdict. */
export function judgeOutcome(what: string, result: unknown, chatId: string): void {
  if (!client) return;
  void (async () => {
    const started = Date.now();
    try {
      const { answers } = await client.systemOne({
        // Round-tripped through JSON: `result` is whatever the extension sent
        // back over the WebSocket, typed `any` at the call sites below.
        state: { action: what, result: JSON.parse(JSON.stringify(result ?? null)) },
        questions: {
          outcome: noul("Given the action and its raw result, did the action most likely succeed?"),
        },
      });
      console.log(
        `[jev] chat=${chatId} outcome=${answers.outcome.noul.toFixed(2)} ` +
          `(${Date.now() - started}ms) — ${what}`,
      );
    } catch (err) {
      console.warn(`[jev] outcome check failed after ${Date.now() - started}ms: ${String(err)}`);
    }
  })();
}

/** Fire-and-forget: ask Jev whether a fact looks worth persisting, log the verdict. */
export function judgeMemoryWorth(topic: string, title: string, content: string, chatId: string): void {
  if (!client) return;
  void (async () => {
    const started = Date.now();
    try {
      const { answers } = await client.systemOne({
        state: `topic: ${topic}\ntitle: ${title}\n${content}`,
        questions: {
          worth: choice("Is this fact durable and worth remembering across future chats?", {
            worth_storing: "A lasting preference, profile detail, or recurring fact about the user.",
            not_worth_storing: "One-off task state, already obvious, or too trivial to matter later.",
          }),
        },
      });
      const { choice: verdict, confidence } = answers.worth;
      console.log(
        `[jev] chat=${chatId} memory-store verdict=${verdict} confidence=${confidence.toFixed(2)} ` +
          `(${Date.now() - started}ms) — ${topic}/${title}`,
      );
    } catch (err) {
      console.warn(`[jev] memory-store check failed after ${Date.now() - started}ms: ${String(err)}`);
    }
  })();
}

/**
 * Real, blocking: ask Jev which existing memory topic (if any) best fits a
 * search query. Returns null on a "no match" verdict, on any error, or when
 * no client is configured — callers must treat null as "fall back to plain
 * keyword search," never as an error to surface.
 */
export async function suggestMemoryTopic(
  query: string,
  topics: string[],
  chatId: string,
): Promise<{ topic: string; confidence: number } | null> {
  if (!client || topics.length === 0) return null;
  const started = Date.now();
  try {
    const options: Record<string, string> = { no_match: "None of the other topics fit this query." };
    for (const t of topics) options[t] = `Facts filed under the topic "${t}".`;

    const { answers } = await client.systemOne({
      state: query,
      questions: {
        topic: choice("Which topic would most likely contain a fact relevant to this query?", options),
      },
    });
    const { choice: picked, confidence } = answers.topic;
    console.log(
      `[jev] chat=${chatId} memory-search topic=${picked} confidence=${confidence.toFixed(2)} ` +
        `(${Date.now() - started}ms) — ${query}`,
    );
    return picked === "no_match" ? null : { topic: picked, confidence };
  } catch (err) {
    console.warn(`[jev] memory-search suggestion failed after ${Date.now() - started}ms: ${String(err)}`);
    return null;
  }
}
