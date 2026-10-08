// How long a task may run, by plan. Two limits, both in the plan's hands and
// both changeable without a deploy (ledger.ts reads them from Parameter Store):
//
//   taskMinutes   the longest one task runs, in minutes of working time. Time
//                 spent waiting on the person never counts. null: no limit.
//   weeklyHours   the working time all of an account's tasks share in a week
//                 (Monday to Monday, UTC). null: no limit.
//
// Why these numbers. A user on CopperOS's own model pays for every step in
// dollars: the weekly allowance, then credits (billing.ts). A task cannot run
// for long on money it does not have, so for those plans the task limit is a
// backstop and the dollars are the real ceiling, which is why the hour budget
// is left off them. A Foundry account runs on its own key, so nothing meters
// its model, and the only thing that bounds what it costs CopperOS is time.
// An hour of a task running costs about
//
//     $0.024   the agent Lambda (512 MB, arm64) waiting on the model and the browser
//     $0.010   the socket, DynamoDB, S3 and logs
//     $0.050   Jev's checks on every step (about 3% of a model call's cost, at
//              720 steps an hour; this is the part that grows with the number of steps)
//     ------
//     $0.085   an hour
//
// Foundry is $5 a month, $4.55 after Stripe's fee. Eight hours a week is 35 hours
// a month, $3 at the very most, if somebody uses every minute: that is 65% of
// what it brings in, and few will. Tasks on Foundry can be as long as they
// like (the limit is the week, not the task), and a week with more to do
// than that is told when it starts again. Raise the number and the price
// together: the arithmetic above is all there is to it.
//
// To run longer than a Lambda's 15 minutes a task is handed from one Lambda to
// the next (agent-run.ts). That is all a longer limit needs; a task that would
// outgrow Lambda (days, or heavy browsers) would move to Fargate behind the
// same two numbers, with nothing else changing.

import type { PlanId } from "./billing.js";

export type RuntimeRules = {
  taskMinutes: number | null;
  weeklyHours: number | null;
};

export type Runtime = Record<PlanId, RuntimeRules>;

export const DEFAULT_RUNTIME: Runtime = {
  ore: { taskMinutes: 15, weeklyHours: null },
  ingot: { taskMinutes: 5 * 60, weeklyHours: null },
  facet: { taskMinutes: 24 * 60, weeklyHours: null },
  foundry: { taskMinutes: null, weeklyHours: 8 },
};

const HOUR_MS = 60 * 60_000;

/** A plan's rules with whatever a stored override sets: a number, or null for no limit. Anything else is ignored. */
export function withOverrides(base: Runtime, set: unknown): Runtime {
  const next = structuredClone(base);
  if (!set || typeof set !== "object") return next;
  for (const plan of Object.keys(next) as PlanId[]) {
    const mine = (set as Record<string, unknown>)[plan];
    if (!mine || typeof mine !== "object") continue;
    for (const field of ["taskMinutes", "weeklyHours"] as const) {
      const value = (mine as Record<string, unknown>)[field];
      if (value === null) next[plan][field] = null;
      else if (typeof value === "number" && Number.isFinite(value) && value > 0) next[plan][field] = value;
    }
  }
  return next;
}

/** What a run may do right now: the task's limit, and how much of the week's working time is left. */
export type RunBudget = {
  /** Ms a task may run in all, or null for no limit. */
  taskMs: number | null;
  /** Ms of the week left, or null for no limit. Never negative. */
  weekLeftMs: number | null;
};

export function budgetOf(rules: RuntimeRules, weekActiveMs: number): RunBudget {
  return {
    taskMs: rules.taskMinutes === null ? null : rules.taskMinutes * 60_000,
    weekLeftMs: rules.weeklyHours === null ? null : Math.max(0, rules.weeklyHours * HOUR_MS - weekActiveMs),
  };
}

/**
 * The limit a run is under, in ms of working time across the whole task:
 * whichever of the task's own limit and the week's remainder comes first, and
 * which that was, for saying why it stopped.
 */
export function limitFor(
  budget: RunBudget,
  usedBeforeMs: number,
): { limitMs: number | null; why: "task" | "week" } {
  const byWeek = budget.weekLeftMs === null ? null : usedBeforeMs + budget.weekLeftMs;
  if (budget.taskMs === null) return { limitMs: byWeek, why: "week" };
  if (byWeek === null || budget.taskMs <= byWeek) return { limitMs: budget.taskMs, why: "task" };
  return { limitMs: byWeek, why: "week" };
}

/** "5 hours", "15 minutes", "1 hour 30 minutes": for telling a person how long. */
export function spanText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = h ? `${h} hour${h === 1 ? "" : "s"}` : "";
  const mins = m ? `${m} minute${m === 1 ? "" : "s"}` : "";
  return [hours, mins].filter(Boolean).join(" ");
}
