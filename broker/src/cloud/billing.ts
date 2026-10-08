// Plans, their allowances, credits, the free pool, and what a model call
// costs the user — the rules of the hosted service's usage limits, with no AWS
// in them (storage is behind Ledger; ledger.ts is the DynamoDB one).
//
// A user on CopperOS's own model spends dollars of model use, as OpenRouter
// reports each call's cost. Their plan gives them an allowance of dollars for
// a stretch of time: the trial (Ore) a week, Monday 00:00 UTC to the next; a
// paid plan its billing month, from the day the subscription renews to the
// next. What goes past it comes out of their credits, which are bought and
// never expire. With neither left, the task
// stops (meter.ts's UsageLimitError). All amounts are kept in micro-dollars,
// whole numbers, so DynamoDB can add them atomically.
//
// The plans are named for copper's way from the ground to the mark on the
// logo: Ore is the free one, Ingot is refined, Facet is cut and polished.
// Foundry is the odd one out: it is not more of CopperOS's model but none of it.
// A Foundry account brings its own OpenRouter or OpenAI key and pays its provider
// directly; what it pays CopperOS for is the hosting, the storage and the
// convenience. Own-key is only for Foundry; every other account runs on
// CopperOS's model, metered.
//
// What the free plan costs is capped twice: each account by its weekly
// allowance, and all of them together by the free pool, a dollar ceiling per
// calendar month. When the pool is spent, Ore stops for everyone until the
// month turns, except on credits somebody paid for. Paid plans and credits
// never draw on it.
//
//   usage    one row per user per period (Ore's week, a paid plan's month): what was spent, in dollars and tokens
//   pool     one row per month: what the free plan has cost everyone so far
//   account  plan (and when it lapses) and the credit balance
//
// Paying for a plan or credits happens in Stripe: its webhook calls setPlan()
// and grantCredits() (stripe-events.ts), and admin.ts does the same by hand.

import { UsageLimitError, type CallUsage, type Meter } from "../meter.js";
import type { Runtime } from "./runtime.js";

export type PlanId = "ore" | "ingot" | "facet" | "foundry";

export const PLAN_NAMES: Record<PlanId, string> = { ore: "Ore", ingot: "Ingot", facet: "Facet", foundry: "Foundry" };

// What the free pool counts is the model's cost plus this much for what rides
// along with it: Jev's judgments (about 3% of the model's cost) and AWS (about
// 5%), measured on real tasks, with some room. So the pool's ceiling is what
// free users cost all in, not just what OpenRouter bills.
export const POOL_OVERHEAD = 1.1;

/**
 * Dollars of model use each plan allows in its period (Ore a week, the paid
 * plans a billing month), and the free pool's ceiling per month.
 */
export type Limits = Record<PlanId, number> & { freePool: number };

/**
 * A paid plan's monthly allowance: its price, less what running it costs
 * CopperOS besides the model. Stripe keeps 2.9% and 30 cents of every payment,
 * and AWS and Jev add about 10% to whatever the model costs (POOL_OVERHEAD).
 * So the allowance A is what satisfies A × 1.1 + fee = price: the plan pays
 * for itself even if every cent of it is used, and the margin is in what is
 * not. Ingot $10 → $8.55, Facet $25 → $21.79.
 */
export function allowanceForPrice(priceUsd: number): number {
  const fee = priceUsd * 0.029 + 0.3;
  return Math.floor(((priceUsd - fee) / POOL_OVERHEAD) * 100) / 100;
}

// Ore is the $2 a week the service is willing to spend on every account, and
// the pool is the $50 a month it is willing to spend on all of them. Ingot
// and Facet are their price less the cost of running them (allowanceForPrice):
// when that is spent the account carries on with credits, or waits for the
// plan to renew. Foundry gets none of CopperOS's model (its own key does the
// work), though credits can still buy some. The live numbers come from
// Parameter Store (ledger.ts), so none of these need a deploy to change; keep
// Ingot's and Facet's in step with their prices in stripe-setup.ts.
export const DEFAULT_LIMITS: Limits = {
  ore: 2,
  ingot: allowanceForPrice(10),
  facet: allowanceForPrice(25),
  foundry: 0,
  freePool: 50,
};

/** Whether a plan may run on the user's own API key. Only Foundry is that. */
export const allowsOwnKey = (plan: PlanId): boolean => plan === "foundry";


export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const MICROS = 1_000_000;
export const toMicros = (usd: number): number => Math.round(usd * MICROS);
export const toUsd = (micros: number): number => micros / MICROS;

// ── credits ─────────────────────────────────────────────────────────────────
//
// What people buy and see is credits: every dollar paid buys CREDITS_PER_DOLLAR
// of them, whichever pack it is. Behind a credit is model use: a dollar of
// credits pays for MODEL_USE_PER_DOLLAR of CopperOS's model (the rest is
// Stripe's fee, Jev, AWS and a margin), so one credit is $0.0055 of it. The
// ledger keeps the balance as micro-dollars of model use; credits are how it
// is counted out to people, and nobody is shown a dollar of model use.

export const CREDITS_PER_DOLLAR = 100;
export const MODEL_USE_PER_DOLLAR = 0.55;
/** Micro-dollars of model use one credit pays for. */
export const MICROS_PER_CREDIT = Math.round((MODEL_USE_PER_DOLLAR / CREDITS_PER_DOLLAR) * MICROS);
/** A balance in micro-dollars of model use, in whole credits: rounded down, so it never shows more than there is. */
export const creditsOf = (micros: number): number => Math.floor(Math.max(0, micros) / MICROS_PER_CREDIT);
/** Dollars of model use (what a pack's price carries in Stripe), in credits. */
export const creditsForUsd = (usd: number): number => Math.round(toMicros(usd) / MICROS_PER_CREDIT);

/** The week `now` falls in: its id (Monday's date, UTC) and when the next one starts. */
export function weekOf(now: number): { id: string; resetsAt: number } {
  const d = new Date(now);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday);
  return { id: new Date(start).toISOString().slice(0, 10), resetsAt: start + WEEK_MS };
}

/** The calendar month `now` falls in (UTC): its id, "2026-10", and when the next one starts. */
export function monthOf(now: number): { id: string; resetsAt: number } {
  const d = new Date(now);
  return {
    id: new Date(now).toISOString().slice(0, 7),
    resetsAt: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
  };
}

/**
 * What a user has on file: plan (until `planUntil`, if it lapses), credits in
 * micro-dollars, and who they are to Stripe, which takes their payments.
 */
export type Account = {
  plan?: string;
  planUntil?: number;
  credits: number;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  /** When the paid plan's current billing month began (epoch ms), as Stripe says; a month is counted from it. */
  periodStart?: number;
  /** Payment pages opened and not yet seen through (Stripe Checkout session ids), so a missed webhook can be caught up with. */
  pendingCheckouts?: string[];
};

/** The stretch an allowance covers: its usage row's id, when it began and when the next begins. */
export type Period = { kind: "week" | "month"; id: string; startsAt: number; resetsAt: number };

/** `ms` moved on by `months` calendar months, on the same day where there is one (Jan 31 → Feb 28), as Stripe bills. */
export function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

/**
 * The period `now` falls in for this plan. The trial's is the week. A paid
 * plan's is its billing month, counted from when the subscription last renewed
 * (forward a month at a time, should a renewal not have been heard of yet);
 * a plan given by hand, with no billing month, has the calendar month.
 */
export function periodOf(plan: PlanId, account: Account, now: number): Period {
  if (plan === "ore") {
    const w = weekOf(now);
    return { kind: "week", id: w.id, startsAt: w.resetsAt - WEEK_MS, resetsAt: w.resetsAt };
  }
  const d = new Date(now);
  const anchor = account.periodStart && account.periodStart <= now ? account.periodStart : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  let k = 0;
  while (addMonths(anchor, k + 1) <= now && k < 1200) k++;
  const startsAt = addMonths(anchor, k);
  return { kind: "month", id: `m${new Date(startsAt).toISOString().slice(0, 10)}`, startsAt, resetsAt: addMonths(anchor, k + 1) };
}

/** When a usage row's period began, from its id: a week's Monday, or a month's first day ("m2026-10-08"). */
export const periodStartOf = (id: string): number => Date.parse(id.replace(/^m/, ""));

/** The plan a user is on right now: a lapsed or unknown one is Ore. */
export function planOf(account: Account, now: number): PlanId {
  const plan = account.plan;
  if (plan === "ingot" || plan === "facet" || plan === "foundry") {
    return !account.planUntil || account.planUntil > now ? plan : "ore";
  }
  return "ore";
}

/** A usage row: micro-dollars spent and the tokens behind them. */
export type PeriodUsage = { spent: number; input: number; output: number; cached: number };

/** Where usage, credits and the free pool are kept. */
export interface Ledger {
  account(userId: string): Promise<Account>;
  /** What was spent in a period so far (a usage row: Ore's week, a paid plan's month): micro-dollars and tokens. */
  usageIn(userId: string, period: string): Promise<PeriodUsage>;
  /** Ms the user's tasks have been working in the week so far (runtime.ts). */
  weekActive(userId: string, week: string): Promise<number>;
  /** Adds to the week's working time, atomically. */
  addActive(userId: string, week: string, ms: number): Promise<void>;
  /** Adds to the period's row, atomically; returns the period's total after. */
  addUsage(
    userId: string,
    period: string,
    add: { spent: number; input: number; output: number; cached: number },
  ): Promise<number>;
  /** Adds to (or, negative, takes from) the credit balance, atomically; returns it after. */
  addCredits(userId: string, delta: number): Promise<number>;
  /** `until` is when a plan lapses (none: until changed); `periodStart`, when its billing month began. */
  setPlan(userId: string, plan: PlanId, until?: number, periodStart?: number): Promise<void>;
  /** Remembers who a user is to Stripe, and the subscription they have there (none, once it ends). */
  linkStripe(userId: string, link: { customerId: string; subscriptionId?: string | null }): Promise<void>;
  /** The user a Stripe customer is, or null for one nobody here has linked. */
  userByCustomer(customerId: string): Promise<string | null>;
  /** Notes a payment page that was opened (`open`), or forgets one that was paid or expired. */
  pendingCheckout(userId: string, sessionId: string, open: boolean): Promise<void>;
  /**
   * Adds bought credits to the balance, exactly once per `key` (the purchase):
   * true the first time, false every time after, however many times Stripe
   * sends the event. Claiming the key and adding the credits are one step, so
   * a failure between them cannot lose or double them.
   */
  grantCredits(userId: string, micros: number, key: string): Promise<boolean>;
  /** Micro-dollars the free plan has cost everyone this month. */
  poolSpent(month: string): Promise<number>;
  /** Adds to the month's pool, atomically; returns the month's total after. */
  addPool(month: string, micros: number): Promise<number>;
}

/** Told, after each add to the pool, where it stands: for warning the owner as it fills. */
export type PoolAlert = (month: string, total: number, ceiling: number) => Promise<void>;

// What a call is charged when the provider does not say what it cost
// (OpenRouter always does). Deliberately above what the cheap models cost:
// a missing figure should never mean free.
const ESTIMATE_PER_M_TOKENS = { input: 0.3, cached: 0.05, output: 1.5 };

export function estimateCost(call: CallUsage): number {
  const fresh = Math.max(0, call.input - call.cached);
  return (
    (fresh * ESTIMATE_PER_M_TOKENS.input + call.cached * ESTIMATE_PER_M_TOKENS.cached + call.output * ESTIMATE_PER_M_TOKENS.output) /
    MICROS
  );
}

/** Where a user stands in their period (the trial's week, a paid plan's month), for the Settings page. Dollars. */
export type UsageSummary = {
  plan: PlanId;
  planName: string;
  /** When a paid plan lapses (epoch ms), if it does. */
  planUntil?: number;
  /** What the allowance below covers: the trial's week, or a paid plan's billing month. */
  period: "week" | "month";
  allowanceUsd: number;
  /** Everything used this period, including what credits covered. */
  spentUsd: number;
  /** What the allowance still has — nothing, while the free pool is spent. */
  leftUsd: number;
  /** The same as a share of the allowance, 0 to 100 (0 for a plan with none). */
  leftPct: number;
  /** Tokens used on CopperOS's model this period: what was sent, what came back, and how much of what was sent was cached. */
  tokens: { input: number; output: number; cached: number };
  /** Credits left, as people see them (see CREDITS_PER_DOLLAR). */
  credits: number;
  /** The same in dollars of model use, for the admin tool; never shown to the person. */
  creditsUsd: number;
  /** When the period starts over (epoch ms): Monday for the trial, the renewal for a paid plan. */
  resetsAt: number;
  /** Ore only: the free pool is spent, so the allowance is out of reach until `poolResetsAt`. */
  poolFull: boolean;
  poolResetsAt: number;
  /** The plan may run on the user's own API key (Foundry). */
  ownKeyAllowed: boolean;
  /** How long a task may run on this plan, and the week's working time (runtime.ts); absent where it is not asked for. */
  runtime?: {
    /** Minutes one task may run, or null for no limit. */
    taskMinutes: number | null;
    /** Hours of working time a week, or null for no limit. */
    weeklyHours: number | null;
    usedHours: number;
  };
};

export async function usageSummary(
  userId: string,
  ledger: Ledger,
  limits: () => Promise<Limits>,
  now = Date.now(),
  runtime?: () => Promise<Runtime>,
): Promise<UsageSummary> {
  const week = weekOf(now);
  const month = monthOf(now);
  const [account, all, active, rules] = await Promise.all([
    ledger.account(userId),
    limits(),
    runtime ? ledger.weekActive(userId, week.id) : Promise.resolve(0),
    runtime ? runtime() : Promise.resolve(null),
  ]);
  const plan = planOf(account, now);
  const period = periodOf(plan, account, now);
  const used = await ledger.usageIn(userId, period.id);
  const poolFull = plan === "ore" && (await ledger.poolSpent(month.id)) >= toMicros(all.freePool);
  const allowanceUsd = all[plan];
  const leftUsd = poolFull ? 0 : Math.max(0, allowanceUsd - toUsd(used.spent));
  return {
    plan,
    planName: PLAN_NAMES[plan],
    ...(plan !== "ore" && account.planUntil ? { planUntil: account.planUntil } : {}),
    period: period.kind,
    allowanceUsd,
    spentUsd: toUsd(used.spent),
    leftUsd,
    leftPct: allowanceUsd > 0 ? Math.round((leftUsd / allowanceUsd) * 100) : 0,
    tokens: { input: used.input, output: used.output, cached: used.cached },
    credits: creditsOf(account.credits),
    creditsUsd: toUsd(Math.max(0, account.credits)),
    resetsAt: period.resetsAt,
    poolFull,
    poolResetsAt: month.resetsAt,
    ownKeyAllowed: allowsOwnKey(plan),
    ...(rules
      ? {
          runtime: {
            taskMinutes: rules[plan].taskMinutes,
            weeklyHours: rules[plan].weeklyHours,
            usedHours: Math.round((active / 3_600_000) * 10) / 10,
          },
        }
      : {}),
  };
}

/** One user's meter for one run. */
export class UsageMeter implements Meter {
  // Where the user stood at the last check, in micro-dollars.
  private cap: number | null = null;
  // The usage row this run's calls are added to: the trial's week, or a paid plan's month.
  private period: string | null = null;
  private credits = 0;
  private ore = false;
  private poolFull = false;
  // What failed writes left owing, added to the next charge.
  private owed = { usage: 0, credits: 0, pool: 0 };
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly userId: string,
    private readonly ledger: Ledger,
    private readonly limits: () => Promise<Limits>,
    private readonly now: () => number = Date.now,
    private readonly alert: PoolAlert | null = null,
  ) {}

  private async standing() {
    const now = this.now();
    const month = monthOf(now);
    const [account, all] = await Promise.all([this.ledger.account(this.userId), this.limits()]);
    const plan = planOf(account, now);
    const period = periodOf(plan, account, now);
    const { spent } = await this.ledger.usageIn(this.userId, period.id);
    const pool = toMicros(all.freePool);
    // Only Ore draws on the pool, so only Ore is held to it.
    const poolFull = plan === "ore" && (await this.ledger.poolSpent(month.id)) >= pool;
    return { plan, period, month, pool, poolFull, cap: toMicros(all[plan]), spent, credits: Math.max(0, account.credits) };
  }

  private remember(s: Awaited<ReturnType<UsageMeter["standing"]>>): void {
    this.cap = s.cap;
    this.period = s.period.id;
    this.credits = s.credits;
    this.ore = s.plan === "ore";
    this.poolFull = s.poolFull;
  }

  async check(): Promise<void> {
    const s = await this.standing();
    this.remember(s);
    // With the pool spent the allowance is out of reach, and the week's spending
    // so far does not count against credits: they are all that is left.
    if ((s.poolFull ? 0 : s.cap - s.spent) + s.credits > 0) return;
    throw new UsageLimitError({
      reason: s.poolFull ? "pool" : "allowance",
      plan: s.plan,
      planName: PLAN_NAMES[s.plan],
      allowanceUsd: toUsd(s.cap),
      creditsUsd: toUsd(s.credits),
      resetsAt: s.poolFull ? s.month.resetsAt : s.period.resetsAt,
      period: s.period.kind,
    });
  }

  /** Charges go through one at a time, in order, so a run's calls cannot interleave their credit draws. */
  charge(call: CallUsage): Promise<void> {
    const run = () => this.record(call);
    const done = this.queue.then(run, run);
    this.queue = done;
    return done;
  }

  private async record(call: CallUsage): Promise<void> {
    const cost = call.cost !== null && Number.isFinite(call.cost) && call.cost >= 0 ? call.cost : estimateCost(call);
    const usage = toMicros(cost) + this.owed.usage;
    if (usage > 0 || call.input || call.output) {
      try {
        if (this.cap === null) this.remember(await this.standing());
        const total = await this.ledger.addUsage(this.userId, this.period ?? weekOf(this.now()).id, {
          spent: usage,
          input: call.input,
          output: call.output,
          cached: call.cached,
        });
        this.owed.usage = 0;
        // The part of this call past the allowance is paid for with credits:
        // all of it with the pool spent. The period's total after the add says
        // how much that is, however many runs are adding to it at once. Only
        // what the user has can be taken: the last call of an allowance can run
        // a little over, and that is not a debt to be taken from credits bought
        // later. Whatever credits did not pay for is the service's cost.
        const over = this.poolFull ? usage : Math.min(usage, Math.max(0, total - (this.cap ?? 0)));
        const draw = Math.min(over, this.credits);
        this.credits -= draw;
        this.owed.credits += draw;
        if (this.ore) this.owed.pool += Math.round((usage - draw) * POOL_OVERHEAD);
      } catch (err) {
        // Not lost: the next charge adds it. Failing the run over a write that
        // may well work a second later would cost the user more than it saves.
        this.owed.usage = usage;
        console.error(`[billing] could not record ${usage} µ$ for ${this.userId}: ${String(err)}`);
        return;
      }
    }
    if (this.owed.credits > 0) {
      try {
        await this.ledger.addCredits(this.userId, -this.owed.credits);
        this.owed.credits = 0;
      } catch (err) {
        console.error(`[billing] could not take ${this.owed.credits} µ$ of credits from ${this.userId}: ${String(err)}`);
      }
    }
    if (this.owed.pool > 0) {
      try {
        const month = monthOf(this.now()).id;
        const total = await this.ledger.addPool(month, this.owed.pool);
        this.owed.pool = 0;
        if (this.alert) {
          const ceiling = toMicros((await this.limits()).freePool);
          await this.alert(month, total, ceiling).catch((err) => console.error(`[billing] pool alert failed: ${String(err)}`));
        }
      } catch (err) {
        console.error(`[billing] could not add ${this.owed.pool} µ$ to the free pool: ${String(err)}`);
      }
    }
  }
}
