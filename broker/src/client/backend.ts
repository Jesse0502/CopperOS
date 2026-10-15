// What the MCP tools need from CopperOS, and how they show it. Two things
// implement it: the local broker's task API (api.ts, for the stdio server on
// your own computer) and the hosted endpoint (cloud/mcp-backend.ts, for
// connectors such as Claude's). The tools (tools.ts) know only this.

export type ChatStatus = "running" | "waiting" | "idle";
export type Waiting = { kind: "approval" | "questions"; text: string };
export type ChatBrief = { id: string; title: string; updatedAt: string; tasks: number; status: ChatStatus; waiting?: Waiting; match?: string };
export type ChatDetail = ChatBrief & {
  createdAt: string;
  currentTask?: string | null;
  lastRun?: { status: string; at: string; error?: string };
  settings: { approvalMode: "all" | "submits" | "none"; supervisor: boolean };
  supervisorAvailable: boolean;
  progress?: { status: string; done: number; skipped: number; note: string; rounds: number; loop: boolean };
  activity: { at: string; event: string; text: string }[];
  totalTurns: number;
  turns: { from: "you" | "copper"; text: string; rules?: string }[];
};
export type Memory = { key: string; topic: string; title: string; content: string; updated: string };
export type Mold = { id: string; name: string; steps: string; created: string; updated: string };

export type StartRequest = {
  text?: string;
  moldId?: string;
  chatId?: string;
  rules?: string;
  approvalMode?: "all" | "submits" | "none";
  supervisor?: boolean;
  timeoutMs?: number;
};

/** Where an account stands on the hosted service's meter. */
export type UsageView = {
  planName: string;
  /** Runs on the person's own API key, so no model use is metered. */
  ownKey: boolean;
  period: "week" | "month";
  /** Share of the period's allowance left, 0 to 100. */
  leftPct: number;
  resetsAt: number;
  credits: number;
  tokens: { input: number; output: number; cached: number };
  /** The free plan's shared monthly pool is spent. */
  poolFull: boolean;
  poolResetsAt: number;
  runtime?: { taskMinutes: number | null; weeklyHours: number | null; usedHours: number };
};

export interface Backend {
  /** The most seconds one wait_for_task call may wait. */
  maxWaitSeconds: number;
  /** Whether a connected AI may add memories and save molds, which CopperOS then treats as the person's own words. */
  canWriteTrust: boolean;
  /** What to tell the model about lowering approvals, the supervisor, and the two writes above. */
  loosenNote: string;
  startTask(req: StartRequest): Promise<{ chatId: string; status: ChatStatus }>;
  listChats(query?: string, limit?: number): Promise<{ chats: ChatBrief[] }>;
  getChat(chatId: string, turns?: number): Promise<ChatDetail>;
  /** Cheap enough to ask every couple of seconds while waiting. */
  chatStatus(chatId: string): Promise<{ status: ChatStatus; step?: string }>;
  stopChat(chatId: string): Promise<{ chatId: string; stopped: boolean }>;
  setSettings(chatId: string, patch: { approvalMode?: string; supervisor?: boolean }): Promise<{ chatId: string; settings: ChatDetail["settings"] }>;
  listMemories(): Promise<{ memories: Memory[] }>;
  addMemory(text: string): Promise<{ memories: Memory[] }>;
  deleteMemory(key: string): Promise<{ memories: Memory[] }>;
  listMolds(): Promise<{ molds: Mold[] }>;
  saveMold(mold: { id?: string; name: string; steps: string }): Promise<{ mold: Mold; total: number }>;
  deleteMold(moldId: string): Promise<{ total: number }>;
  /** Only where usage is metered (the hosted service). */
  usage?(): Promise<UsageView>;
}

/** One chat as a line in a list. */
export function chatLine(c: ChatBrief): string {
  const state = c.status === "idle" ? "" : c.status === "waiting" ? " · WAITING ON THE PERSON" : " · running";
  return `${c.id} · ${c.updatedAt.slice(0, 16).replace("T", " ")} · ${c.tasks} task${c.tasks === 1 ? "" : "s"}${state}\n  ${c.title}${c.match ? `\n  …${c.match}…` : ""}`;
}

/** A chat in full, as plain text for a model. */
export function describeChat(c: ChatDetail): string {
  const lines = [`Chat ${c.id}: ${c.title}`];
  const last = c.lastRun ? ` (last run: ${c.lastRun.status}${c.lastRun.error ? ` — ${c.lastRun.error}` : ""})` : "";
  lines.push(`Status: ${c.status === "waiting" ? "waiting on the person" : c.status}${c.status === "idle" ? last : ""}`);
  if (c.currentTask) lines.push(`Task: ${c.currentTask}`);
  lines.push(
    `Settings: approvals ${c.settings.approvalMode} · supervisor ${c.settings.supervisor ? "on" : "off"}` +
      (c.settings.supervisor && !c.supervisorAvailable ? " (no Jev key, so it will not check in)" : ""),
  );
  if (c.waiting) {
    lines.push(
      `Waiting on the person (${c.waiting.kind}): ${c.waiting.text}`,
      "Only the person can answer this, in the CopperOS panel. Tell them it is waiting.",
    );
  }
  if (c.progress) {
    const p = c.progress;
    lines.push(`Progress: ${p.status} · ${p.done} done, ${p.skipped} skipped · round ${p.rounds}${p.loop ? " · repeats until stopped" : ""}${p.note ? `\n  ${p.note}` : ""}`);
  }
  if (c.status === "running" && c.activity.length) {
    lines.push("Latest steps:", ...c.activity.slice(-8).map((a) => `  ${a.at.slice(11, 19)} ${a.event}${a.text ? `: ${a.text}` : ""}`));
  }
  if (c.turns.length) {
    lines.push("", `Conversation (last ${c.turns.length} of ${c.totalTurns}):`);
    for (const t of c.turns) lines.push(`${t.from === "you" ? "Person" : "CopperOS"}: ${t.text}${t.rules ? `\n  [supervisor rules: ${t.rules}]` : ""}`);
  }
  return lines.join("\n");
}

const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** Usage as plain text for a model. Credits are counts, never dollars. */
export function describeUsage(u: UsageView): string {
  const lines = [`Plan: ${u.planName}`];
  if (u.ownKey) {
    lines.push("Runs on the person's own API key, so model use is not metered.");
  } else if (u.poolFull) {
    lines.push(`The free trial's shared usage for this month is spent, so new tasks are refused until ${day(u.poolResetsAt)} (UTC) unless the person has credits.`);
  } else {
    lines.push(`This ${u.period}'s usage: ${u.leftPct}% left. It ${u.period === "week" ? "starts over" : "renews"} on ${day(u.resetsAt)} (UTC).`);
  }
  if (!u.ownKey) {
    lines.push(`Credits: ${u.credits}`);
    lines.push(`Tokens used this ${u.period}: ${u.tokens.input} in (${u.tokens.cached} cached), ${u.tokens.output} out`);
  }
  if (u.runtime) {
    lines.push(`Longest single task: ${u.runtime.taskMinutes === null ? "no limit" : `${u.runtime.taskMinutes} minutes`}`);
    if (u.runtime.weeklyHours !== null) lines.push(`Running time this week: ${u.runtime.usedHours} of ${u.runtime.weeklyHours} hours`);
  }
  return lines.join("\n");
}
