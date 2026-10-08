// Taking money: what is on sale, the page that takes the payment, and the page
// that manages it afterwards. Stripe does the part that has to be Stripe's:
// the card form (Checkout), receipts and invoices, changing or cancelling a
// subscription (the customer portal). CopperOS never sees a card number.
//
// What is for sale is whatever Stripe says is, so prices and credit amounts
// change in Stripe and nowhere else. A price belongs to CopperOS when its
// metadata says `app = copperos`, and is one of:
//
//   kind = plan     plan = ingot | facet | foundry     (monthly)
//   kind = credits  credits_usd = <dollars of model use it buys>
//
// stripe-setup.ts creates them; stripe-events.ts reacts to what happens next.

import { GetParameterCommand, ParameterNotFound, SSMClient } from "@aws-sdk/client-ssm";
import Stripe from "stripe";
import { allowsOwnKey, creditsForUsd, PLAN_NAMES, planOf, type Account, type Ledger, type PlanId } from "./billing.js";

/** The parts of Stripe's client this file uses. */
export type StripeApi = Pick<Stripe, "prices" | "checkout" | "billingPortal" | "subscriptions" | "paymentIntents">;

export const PAID_PLANS = ["ingot", "facet", "foundry"] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];
const isPaidPlan = (x: unknown): x is PaidPlan => PAID_PLANS.includes(x as PaidPlan);

export type PlanOffer = {
  id: PaidPlan;
  name: string;
  blurb: string;
  /** In the currency's smallest unit: cents. */
  amount: number;
  currency: string;
  priceId: string;
};
/** A credit pack: its price, and the credits it buys (`creditsUsd` is what those pay for in model use, kept for the purchase). */
export type PackOffer = { priceId: string; amount: number; currency: string; credits: number; creditsUsd: number };
export type Catalog = { plans: PlanOffer[]; packs: PackOffer[] };

/** Something that went wrong that the person should be told, in words they can use. */
export class BillingError extends Error {}

// ── the client ──────────────────────────────────────────────────────────────

let client: Promise<Stripe | null> | null = null;

/**
 * Stripe's client, or null when billing is not set up on this stage (no key
 * stored): everything else then carries on as if nothing were for sale. The
 * key comes from the environment (a script on a developer's machine) or from
 * Parameter Store (the Lambdas). It is never sent to the browser.
 */
export function stripeClient(): Promise<Stripe | null> {
  client ??= load()
    .then((found) => {
      // No key stored yet is not an answer to remember: `stripe:setup` stores it while the service runs.
      if (!found) client = null;
      return found;
    })
    .catch((err) => {
      client = null;
      throw err;
    });
  return client;
}

async function load(): Promise<Stripe | null> {
  let key = process.env.STRIPE_SECRET_KEY;
  const param = process.env.STRIPE_SECRET_PARAM;
  if (!key && param) {
    try {
      const res = await new SSMClient({}).send(new GetParameterCommand({ Name: param, WithDecryption: true }));
      key = res.Parameter?.Value;
    } catch (err) {
      if (!(err instanceof ParameterNotFound)) throw err;
    }
  }
  return key ? new Stripe(key, { maxNetworkRetries: 2, appInfo: { name: "CopperOS", version: "1.0.0" } }) : null;
}

// ── what is for sale ────────────────────────────────────────────────────────

const CATALOG_TTL_MS = 5 * 60_000;
let catalogCache: { at: number; value: Catalog } | null = null;

export async function loadCatalog(stripe: StripeApi, now = Date.now()): Promise<Catalog> {
  if (catalogCache && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.value;
  const found = await stripe.prices.list({ active: true, limit: 100, expand: ["data.product"] });
  const plans: PlanOffer[] = [];
  const packs: PackOffer[] = [];
  for (const price of found.data) {
    if (price.metadata?.app !== "copperos" || price.unit_amount == null) continue;
    const product = typeof price.product === "object" && "name" in price.product ? price.product : null;
    if (price.metadata.kind === "plan" && isPaidPlan(price.metadata.plan) && price.recurring?.interval === "month") {
      plans.push({
        id: price.metadata.plan,
        name: PLAN_NAMES[price.metadata.plan],
        blurb: product?.description ?? "",
        amount: price.unit_amount,
        currency: price.currency,
        priceId: price.id,
      });
    } else if (price.metadata.kind === "credits" && !price.recurring) {
      const creditsUsd = Number(price.metadata.credits_usd);
      if (Number.isFinite(creditsUsd) && creditsUsd > 0) {
        packs.push({ priceId: price.id, amount: price.unit_amount, currency: price.currency, credits: creditsForUsd(creditsUsd), creditsUsd });
      }
    }
  }
  plans.sort((a, b) => a.amount - b.amount);
  packs.sort((a, b) => a.amount - b.amount);
  catalogCache = { at: now, value: { plans, packs } };
  return catalogCache.value;
}

// ── what a user can do ──────────────────────────────────────────────────────

export type BillingDeps = {
  stripe: StripeApi;
  ledger: Ledger;
  /** Where Stripe sends people back to: a page on the website. */
  returnUrl: string;
  now?: () => number;
};

const idOf = (x: string | { id: string } | null | undefined): string | null => (typeof x === "string" ? x : (x?.id ?? null));

/** The end of what a subscription has been paid for, in ms. The newer API keeps it on the item, the older on the subscription. */
export function periodEnd(sub: Stripe.Subscription): number | null {
  const seconds =
    (sub as { current_period_end?: number }).current_period_end ??
    sub.items?.data?.[0]?.current_period_end ??
    null;
  return seconds ? seconds * 1000 : null;
}

/** When the subscription's current billing month began, in ms: the day a paid plan's allowance starts over. */
export function periodStart(sub: Stripe.Subscription): number | null {
  const seconds =
    (sub as { current_period_start?: number }).current_period_start ??
    sub.items?.data?.[0]?.current_period_start ??
    null;
  return seconds ? seconds * 1000 : null;
}

export type BillingState = {
  plan: PlanId;
  planName: string;
  /** The paid plan stops at this time, if the person has cancelled it. */
  endsAt: number | null;
  /** They have bought something, so there is a billing page to open. */
  hasCustomer: boolean;
  plans: PlanOffer[];
  packs: PackOffer[];
  ownKeyAllowed: boolean;
};

export async function billingState(userId: string, deps: BillingDeps): Promise<BillingState> {
  const now = (deps.now ?? Date.now)();
  const [account, catalog] = await Promise.all([deps.ledger.account(userId), loadCatalog(deps.stripe, now)]);
  const plan = planOf(account, now);
  let endsAt: number | null = null;
  if (plan !== "ore" && account.stripeSubscriptionId) {
    try {
      const sub = await deps.stripe.subscriptions.retrieve(account.stripeSubscriptionId);
      if (sub.cancel_at_period_end) endsAt = periodEnd(sub);
    } catch {
      // Not knowing when it ends costs a line of text, not the page.
    }
  }
  return {
    plan,
    planName: PLAN_NAMES[plan],
    endsAt,
    hasCustomer: Boolean(account.stripeCustomerId),
    ...catalog,
    ownKeyAllowed: allowsOwnKey(plan),
  };
}

export type Purchase = { kind: "plan"; plan: string } | { kind: "credits"; priceId: string };

/**
 * The page to pay on. Someone who already has a plan is sent to the portal
 * instead, where changing it is prorated and nothing is paid for twice.
 */
export async function startCheckout(
  userId: string,
  email: string | null,
  purchase: Purchase,
  deps: BillingDeps,
): Promise<{ url: string; kind: "checkout" | "portal" }> {
  const now = (deps.now ?? Date.now)();
  const [account, catalog] = await Promise.all([deps.ledger.account(userId), loadCatalog(deps.stripe, now)]);
  const have = planOf(account, now);
  const back = (status: string) => `${deps.returnUrl}${deps.returnUrl.includes("?") ? "&" : "?"}status=${status}`;
  // An existing customer is reused, so a person has one place for every invoice.
  const who = account.stripeCustomerId ? { customer: account.stripeCustomerId } : { customer_email: email ?? undefined };

  if (purchase.kind === "plan") {
    const offer = catalog.plans.find((p) => p.id === purchase.plan);
    if (!offer) throw new BillingError("That plan is not on sale right now.");
    if (have === offer.id) throw new BillingError(`You are already on ${offer.name}.`);
    if (have !== "ore" && account.stripeSubscriptionId) return { url: await portalUrl(account, deps), kind: "portal" };
    const session = await deps.stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: offer.priceId, quantity: 1 }],
      client_reference_id: userId,
      metadata: { userId, kind: "plan", plan: offer.id },
      // Later events (a renewal, a cancellation) name the subscription, not the session.
      subscription_data: { metadata: { userId, plan: offer.id } },
      allow_promotion_codes: true,
      // A card is asked for whenever something is due. When a promotion code takes
      // the whole price off (a reviewer's, a gift), there is nothing to pay and no card.
      payment_method_collection: "if_required",
      success_url: back("success"),
      cancel_url: back("cancelled"),
      ...who,
    });
    if (!session.url) throw new BillingError("Could not open the payment page. Try again in a moment.");
    await notePending(userId, session.id, deps);
    return { url: session.url, kind: "checkout" };
  }

  const pack = catalog.packs.find((p) => p.priceId === purchase.priceId);
  if (!pack) throw new BillingError("That credit pack is not on sale right now.");
  const meta = { userId, kind: "credits", credits_usd: String(pack.creditsUsd) };
  const session = await deps.stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: pack.priceId, quantity: 1 }],
    client_reference_id: userId,
    metadata: meta,
    payment_intent_data: { metadata: meta },
    // So a credit purchase has an invoice, like a subscription's payments do. No
    // invoice_data on it: Stripe refuses that when Managed Payments is on, and the
    // invoice already names the product.
    invoice_creation: { enabled: true },
    // No custom_text saying how many credits it buys: Stripe refuses it under
    // Managed Payments. The product's description says a dollar buys 100.
    ...(account.stripeCustomerId ? {} : { customer_creation: "always" as const }),
    allow_promotion_codes: true,
    success_url: back("success"),
    cancel_url: back("cancelled"),
    ...who,
  });
  if (!session.url) throw new BillingError("Could not open the payment page. Try again in a moment.");
  await notePending(userId, session.id, deps);
  return { url: session.url, kind: "checkout" };
}

/** Remembers a payment page, so what is paid on it reaches the account even if Stripe's webhook does not. */
async function notePending(userId: string, sessionId: string, deps: BillingDeps): Promise<void> {
  try {
    await deps.ledger.pendingCheckout(userId, sessionId, true);
  } catch (err) {
    // The webhook still brings the purchase; this is the second way, not the only one.
    console.error(`[billing] could not note checkout ${sessionId}: ${String((err as Error)?.message ?? err)}`);
  }
}

// The portal's own settings (which plans can be switched between, that
// invoices show) are CopperOS's when stripe-setup.ts has made them.
let portalConfig: string | null | undefined;

async function portalUrl(account: Account, deps: BillingDeps): Promise<string> {
  if (!account.stripeCustomerId) throw new BillingError("There is nothing to manage yet: nothing has been bought.");
  if (portalConfig === undefined) {
    const found = await deps.stripe.billingPortal.configurations.list({ active: true, limit: 20 });
    portalConfig = found.data.find((c) => c.metadata?.app === "copperos")?.id ?? null;
  }
  const session = await deps.stripe.billingPortal.sessions.create({
    customer: account.stripeCustomerId,
    return_url: deps.returnUrl,
    ...(portalConfig ? { configuration: portalConfig } : {}),
  });
  return session.url;
}

/** Stripe's page for invoices, payment methods, changing a plan or cancelling it. */
export async function openPortal(userId: string, deps: BillingDeps): Promise<string> {
  return portalUrl(await deps.ledger.account(userId), deps);
}

/** When an account is deleted its subscription must stop, or it would go on being charged for nothing. */
export async function cancelSubscription(userId: string, deps: Pick<BillingDeps, "stripe" | "ledger">): Promise<boolean> {
  const { stripeSubscriptionId } = await deps.ledger.account(userId);
  if (!stripeSubscriptionId) return false;
  try {
    await deps.stripe.subscriptions.cancel(stripeSubscriptionId);
    return true;
  } catch (err) {
    // Already gone is what was wanted.
    if ((err as { code?: string }).code === "resource_missing") return false;
    throw err;
  }
}

export { idOf };
