// What Stripe tells us, and what it means for an account: a subscription began
// or ended, a month was paid, a credit pack was bought. This is the only place
// a plan or a credit balance changes because money moved.
//
// Stripe sends an event at least once and sometimes more, in any order, so
// everything here can be done twice with the same result. A plan is set from
// the subscription as it stands, never from "one more month". Credits are the
// one thing that must not happen twice: they are granted through the ledger's
// grantCredits, which claims the purchase and adds the credits in one step.
//
// A paid plan lasts until the end of what was paid for, plus a few days, so a
// webhook that never arrives costs a little goodwill and not a permanent plan.
// And a webhook that never arrives is caught up with: syncFromStripe() asks
// Stripe what an account has and applies it the same way, when the person
// looks at their plan.

import type Stripe from "stripe";
import { creditsForUsd, toMicros, type Ledger } from "./billing.js";
import { idOf, periodEnd, periodStart, type StripeApi } from "./stripe.js";

export const GRACE_MS = 3 * 24 * 60 * 60 * 1000;

export type EventDeps = { stripe: StripeApi; ledger: Ledger };

/** What was done, in a line, for the logs. */
export async function handleStripeEvent(event: Stripe.Event, deps: EventDeps): Promise<string> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return onCheckout(event.data.object as Stripe.Checkout.Session, deps);
    case "invoice.paid":
      return onInvoicePaid(event.data.object as Stripe.Invoice, deps);
    case "customer.subscription.created":
    case "customer.subscription.updated":
      return onSubscription(event.data.object as Stripe.Subscription, deps);
    case "customer.subscription.deleted":
      return onSubscriptionEnded(event.data.object as Stripe.Subscription, deps);
    default:
      return `ignored ${event.type}`;
  }
}

async function onCheckout(session: Stripe.Checkout.Session, { stripe, ledger }: EventDeps): Promise<string> {
  const userId = session.client_reference_id ?? session.metadata?.userId ?? null;
  if (!userId) return "ignored a checkout that names no user";
  const customerId = idOf(session.customer);
  // A payment that is still on its way (a bank debit) comes again when it lands.
  if (session.payment_status === "unpaid") return `waiting: ${session.id} is not paid yet`;

  if (session.mode === "subscription") {
    const subscriptionId = idOf(session.subscription);
    if (!subscriptionId) return "ignored a subscription checkout with no subscription";
    if (customerId) await ledger.linkStripe(userId, { customerId, subscriptionId });
    return onSubscription(await stripe.subscriptions.retrieve(subscriptionId), { stripe, ledger }, userId);
  }

  if (session.mode === "payment" && session.metadata?.kind === "credits") {
    const dollars = Number(session.metadata.credits_usd);
    if (!Number.isFinite(dollars) || dollars <= 0) return `ignored ${session.id}: no credit amount on it`;
    if (customerId) await ledger.linkStripe(userId, { customerId });
    const granted = await ledger.grantCredits(userId, toMicros(dollars), `session:${session.id}`);
    return granted ? `granted ${creditsForUsd(dollars)} credits to ${userId}` : `already granted for ${session.id}`;
  }
  return `ignored a ${session.mode} checkout`;
}

async function onInvoicePaid(invoice: Stripe.Invoice, { stripe, ledger }: EventDeps): Promise<string> {
  // The newer API says which subscription an invoice is for under `parent`, the older at the top.
  const raw = invoice as unknown as {
    subscription?: string | { id: string } | null;
    parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null;
  };
  const subscriptionId = idOf(raw.parent?.subscription_details?.subscription ?? raw.subscription);
  if (!subscriptionId) return "ignored an invoice that is not for a subscription";
  return onSubscription(await stripe.subscriptions.retrieve(subscriptionId), { stripe, ledger });
}

/** The account a subscription belongs to: named on it, else found by its customer. */
async function ownerOf(sub: Stripe.Subscription, ledger: Ledger): Promise<string | null> {
  return sub.metadata?.userId || (await ledger.userByCustomer(idOf(sub.customer) ?? "")) || null;
}

async function onSubscription(sub: Stripe.Subscription, { ledger }: EventDeps, owner?: string): Promise<string> {
  const userId = owner ?? (await ownerOf(sub, ledger));
  if (!userId) return `ignored ${sub.id}: no account is linked to it`;
  const customerId = idOf(sub.customer);
  if (customerId) await ledger.linkStripe(userId, { customerId, subscriptionId: sub.id });

  // Paid, or paid up to the end of the month and still being retried: the plan stays.
  // Anything else (cancelled, unpaid, never completed) is not a plan.
  if (sub.status === "incomplete") return `waiting: ${sub.id} has not been paid yet`;
  if (!["active", "trialing", "past_due"].includes(sub.status)) return endPlan(userId, sub, ledger);

  const plan = sub.items.data[0]?.price?.metadata?.plan ?? sub.metadata?.plan;
  if (plan !== "ingot" && plan !== "facet" && plan !== "foundry") return `ignored ${sub.id}: its price is not a CopperOS plan`;
  const end = periodEnd(sub);
  if (!end) return `ignored ${sub.id}: no period end on it`;
  // The billing month the allowance counts in starts when the subscription last renewed.
  await ledger.setPlan(userId, plan, end + GRACE_MS, periodStart(sub) ?? undefined);
  return `${userId} is on ${plan} until ${new Date(end).toISOString()}${sub.cancel_at_period_end ? " (ends then)" : ""}`;
}

async function onSubscriptionEnded(sub: Stripe.Subscription, { ledger }: EventDeps): Promise<string> {
  const userId = await ownerOf(sub, ledger);
  if (!userId) return `ignored ${sub.id}: no account is linked to it`;
  return endPlan(userId, sub, ledger);
}

async function endPlan(userId: string, sub: Stripe.Subscription, ledger: Ledger): Promise<string> {
  // Events come in any order: the end of an old subscription can land after the
  // start of a new one, and must not take the new plan away.
  const current = (await ledger.account(userId)).stripeSubscriptionId;
  if (current && current !== sub.id) return `ignored the end of ${sub.id}: ${current} is the current subscription`;
  const customerId = idOf(sub.customer);
  if (customerId) await ledger.linkStripe(userId, { customerId, subscriptionId: null });
  await ledger.setPlan(userId, "ore");
  return `${userId} is back on ore: ${sub.id} is ${sub.status}`;
}

// ── catching up ─────────────────────────────────────────────────────────────

/** Only ids this service made (Cognito's, or a test's) go into a search query. */
const SEARCHABLE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/**
 * Credit purchases older than this are left alone: the claim that stops a
 * purchase being granted twice is kept for 45 days (ledger.ts), so anything
 * looked at again must be well inside that.
 */
const CATCH_UP_DAYS = 30;

/**
 * What Stripe holds for an account, applied as the webhook would have: for an
 * event that was missed or is late (no webhook registered yet, an outage, the
 * moments between paying and the event). Everything it does can be done twice
 * with the same result, so it is safe to run whenever the plan is looked at.
 * Stripe's search can trail a new purchase by up to a minute; the panel keeps
 * asking for a few minutes after a payment page is opened.
 */
export async function syncFromStripe(userId: string, deps: EventDeps, now = Date.now()): Promise<string[]> {
  if (!SEARCHABLE_ID.test(userId)) return [];
  const done: string[] = [];
  const named = `metadata['userId']:'${userId}'`;
  const account = await deps.ledger.account(userId);

  // Payment pages this account opened: each is looked at directly, so a purchase
  // shows the moment it is paid, before search has caught up with it.
  for (const id of (account.pendingCheckouts ?? []).slice(-10)) {
    const session = await deps.stripe.checkout.sessions.retrieve(id).catch(() => null);
    if (session?.status === "complete") done.push(await onCheckout(session, deps));
    // Paid (or only waiting on a bank), expired, or no longer there: nothing left to wait for.
    if (!session || session.status !== "open") await deps.ledger.pendingCheckout(userId, id, false);
  }

  // The newest subscription that is still paid for; else whatever the account last had, as it stands now.
  const subs = await deps.stripe.subscriptions.search({ query: named, limit: 20 });
  const live = subs.data
    .filter((s) => ["active", "trialing", "past_due"].includes(s.status))
    .sort((a, b) => b.created - a.created)[0];
  if (live) done.push(await onSubscription(live, deps, userId));
  else if (account.stripeSubscriptionId) {
    done.push(await onSubscription(await deps.stripe.subscriptions.retrieve(account.stripeSubscriptionId), deps, userId));
  }

  const since = Math.floor(now / 1000) - CATCH_UP_DAYS * 24 * 60 * 60;
  const paid = await deps.stripe.paymentIntents.search({
    query: `${named} AND status:'succeeded' AND created>${since}`,
    limit: 50,
  });
  for (const intent of paid.data) {
    if (intent.metadata?.kind !== "credits") continue;
    // Credits are granted against the checkout, as the webhook grants them, so one purchase is one claim.
    const session = (await deps.stripe.checkout.sessions.list({ payment_intent: intent.id, limit: 1 })).data[0];
    if (session) done.push(await onCheckout(session, deps));
  }
  return done;
}
