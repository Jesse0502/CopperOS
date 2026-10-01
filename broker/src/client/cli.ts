#!/usr/bin/env -S npx tsx
// copper — run browser tasks through the already-running broker.
//   copper "open example.com and tell me the heading"
//   copper --rules "read only" --approval none "check my inbox count"
//   echo "find the pricing page" | copper
//   copper status
import { parseArgs } from "node:util";
import { describe, health, runTask } from "./api.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rules: { type: "string", short: "r" },
    approval: { type: "string", short: "a" },
    timeout: { type: "string", short: "t" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const usage = `usage: copper [options] "<task>"      run a task and print the result
       copper status                 is the broker up and the extension connected?

  -r, --rules <text>      supervisor rules for this task
  -a, --approval <mode>   all | submits (default) | none
  -t, --timeout <secs>    active-time limit, 30-1800 (default 600)
      --json              print the full result as JSON

Needs TASK_API_TOKEN in broker/.env (restart the broker after adding it).
exit codes: 0 done · 1 error · 2 blocked or timed out`;

async function main(): Promise<number> {
  if (values.help) return console.log(usage), 0;

  if (positionals[0] === "status" && positionals.length === 1) {
    const h = await health();
    console.log(values.json ? JSON.stringify(h) : `broker up · extension ${h.extension ? "connected" : "NOT connected"} · ${h.busy ? "busy" : "idle"} · ${h.model}`);
    return h.extension ? 0 : 1;
  }

  let text = positionals.join(" ").trim();
  if (!text && !process.stdin.isTTY) {
    for await (const chunk of process.stdin) text += chunk;
    text = text.trim();
  }
  if (!text) return console.error(usage), 1;

  const approvalMode = values.approval as "all" | "submits" | "none" | undefined;
  if (approvalMode && !["all", "submits", "none"].includes(approvalMode)) return console.error("--approval must be all, submits or none"), 1;

  console.error("[copper] running…");
  const result = await runTask({
    text,
    rules: values.rules,
    approvalMode,
    timeoutMs: values.timeout ? Number(values.timeout) * 1000 : undefined,
  });
  console.log(values.json ? JSON.stringify(result, null, 2) : describe(result));
  return result.status === "done" ? 0 : result.status === "error" ? 1 : 2;
}

main().then(
  (code) => process.exit(code),
  (err) => (console.error(`copper: ${(err as Error).message}`), process.exit(1)),
);
