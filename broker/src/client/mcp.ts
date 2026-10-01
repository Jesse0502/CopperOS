// MCP server (stdio) so other agents — Claude Code, Cursor, etc. — can hand
// browser work to CopperOS. Wraps the broker's task API; stdout is the
// protocol, so all logging goes to stderr.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { describe, health, runTask } from "./api.js";

const server = new McpServer({ name: "copperos", version: "0.1.0" });

server.registerTool(
  "browser_task",
  {
    title: "Run a browser task",
    description:
      "Hand a task to the CopperOS browser agent, which drives the user's real Chrome (signed-in accounts included) and returns what it found or did. " +
      "Describe the goal in plain words, not clicks. One task runs at a time, in a fresh chat. It can take minutes. " +
      "A task that needs approval or an answer it can't get comes back as blocked.",
    inputSchema: {
      task: z.string().min(1).describe("What to do, e.g. 'open example.com and tell me the main heading'"),
      rules: z.string().optional().describe("Constraints for the run, e.g. 'read only, never submit forms'"),
      approval_mode: z
        .enum(["all", "submits", "none"])
        .optional()
        .describe("Which actions need approval: all, submits (default), or none. Nobody can approve during an MCP call, so a task that asks is ended as blocked."),
      timeout_seconds: z.number().int().min(30).max(1800).optional().describe("Active-time limit, default 600"),
    },
  },
  async ({ task, rules, approval_mode, timeout_seconds }, extra) => {
    // Some clients reset their tool timeout on progress; a task can run for minutes.
    const token = extra._meta?.progressToken;
    let tick = 0;
    const beat = token === undefined ? null : setInterval(() => {
      void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++tick, message: "browser task running" } }).catch(() => {});
    }, 10_000);
    try {
      const r = await runTask({ text: task, rules, approvalMode: approval_mode, timeoutMs: timeout_seconds ? timeout_seconds * 1000 : undefined });
      return { content: [{ type: "text" as const, text: describe(r) }], isError: r.status === "error" };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    } finally {
      if (beat) clearInterval(beat);
    }
  },
);

server.registerTool(
  "browser_status",
  {
    title: "Browser agent status",
    description: "Check whether the CopperOS broker is up, Chrome's extension is connected, and a task is already running.",
    inputSchema: {},
  },
  async () => {
    try {
      const h = await health();
      return { content: [{ type: "text" as const, text: `broker up · extension ${h.extension ? "connected" : "NOT connected"} · ${h.busy ? "busy" : "idle"} · ${h.model}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  },
);

await server.connect(new StdioServerTransport());
console.error("[copperos-mcp] ready");
