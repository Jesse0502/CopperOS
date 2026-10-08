// What a run on CopperOS's own model costs, and when it has to stop.
//
// On the hosted service, a user without an API key of their own runs on
// CopperOS's model and key, within a weekly allowance from their plan plus
// any credits they have bought (cloud/billing.ts): the trial's is a week, a paid
// plan's its billing month. agent.ts only knows this
// interface: it asks check() before each model call and tells charge() what
// the call cost afterwards. A broker on someone's own computer has no meter,
// and neither does a hosted user on their own key.

/** What one model call used and cost, as the provider reported it. */
export type CallUsage = {
  /** Dollars the provider charged — null when it did not say, and charge() estimates. */
  cost: number | null;
  input: number;
  output: number;
  cached: number;
  model: string;
};

/** Where the user stands, for the message that says why a task stopped. */
export type LimitInfo = {
  /** Their own allowance is spent, or the free plan's shared pool is. */
  reason: "allowance" | "pool";
  plan: string;
  planName: string;
  /** Dollars of model use the plan allows in its period. */
  allowanceUsd: number;
  /** Credits left, in dollars. */
  creditsUsd: number;
  /** When the allowance — or, for the pool, the month — starts over (epoch ms). */
  resetsAt: number;
  /** What the allowance covers: the trial's week, or a paid plan's billing month. */
  period?: "week" | "month";
};

/** Nothing is left to spend: the period's allowance is used up and there are no credits. */
export class UsageLimitError extends Error {
  constructor(readonly info: LimitInfo) {
    super(limitMessage(info));
  }
}

export function limitMessage(info: LimitInfo): string {
  const resets = new Date(info.resetsAt).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const more = "To keep going now, open Settings and choose a plan or buy credits.";
  if (info.reason === "pool") {
    return `CopperOS's trial usage for this month has run out, for everyone. It comes back on ${resets} (UTC). ${more}`;
  }
  // Foundry runs on the person's own key: the model's allowance is none by design.
  if (info.plan === "foundry") {
    return "Foundry runs on your own API key. Open Settings and add yours, or buy credits to use CopperOS's model.";
  }
  if (info.plan === "ore" || info.period === "week") {
    return `You have used all of this week's trial usage. It starts over on ${resets} (UTC). ${more}`;
  }
  return `You have used all of this month's ${info.planName} usage. It renews on ${resets} (UTC). To keep going now, open Settings → Plans & credits and buy credits.`;
}

export interface Meter {
  /** Throws UsageLimitError when there is nothing left to spend. */
  check(): Promise<void>;
  /** Records what one call cost. Never throws: a failed write is carried to the next one. */
  charge(call: CallUsage): Promise<void>;
}

let make: ((userId: string) => Meter) | null = null;

/** Set once at startup by the hosted agent; a local broker never sets one. */
export function useMeter(factory: (userId: string) => Meter): void {
  make = factory;
}

export function meterFor(userId: string): Meter | null {
  return make ? make(userId) : null;
}
