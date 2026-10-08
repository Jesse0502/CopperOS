// Makes Stripe match what CopperOS sells. Safe to run again: it finds what
// it made before (by metadata and price lookup keys) and only changes what
// differs, so it is also how a price is changed.
//
//   cd broker
//   npm run stripe:setup                                   products, prices, credit packs, the customer portal (the sandbox)
//   npm run stripe:setup -- --live                         the same, for real customers
//   npm run stripe:setup -- --stage prod --webhook <url>   also the webhook, and both secrets into Parameter Store
//
// The sandbox is STRIPE_SECRET_KEY in the environment (broker/.env); the real
// account is LIVE_STRIPE_SECRET_KEY, used only when --live is given, and --live
// refuses a key that is not a live one, and the sandbox command refuses a live
// one, so neither can be done by mistake. A restricted key (rk_) works if it may
// write products, prices, customer portal configuration and webhook endpoints.
//
// What is for sale:
//   Ingot    $10 a month     CopperOS's own model, a monthly allowance of $8.55; a task may run 5 hours
//   Facet    $25 a month     the same, $21.79 a month; a task may run 24 hours
//   Foundry  $5 a month      your own API key and model (and Jev key, optional): hosting, storage, convenience; no limit on a task
// Each allowance is the price less what running the plan costs (billing.ts's allowanceForPrice):
// change a price and the allowance with it.
//   Credits  $5 $10 $25 $50  100 credits a dollar (billing.ts's CREDITS_PER_DOLLAR); they never expire
// How long a task may run is enforced by runtime.ts: these words must say the same. Change the
// numbers below and run it again.

import { pathToFileURL } from "node:url";
import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import Stripe from "stripe";
import { CREDITS_PER_DOLLAR, MODEL_USE_PER_DOLLAR } from "./billing.js";

const SITE = "https://copper.jassydev.com";

export type PlanSpec = {
  key: "ingot" | "facet" | "foundry";
  name: string;
  description: string;
  cents: number;
};
export type PackSpec = { dollars: number; credits: number; creditsUsd: number };

export const PLANS: PlanSpec[] = [
  {
    key: "ingot",
    name: "CopperOS Ingot",
    description:
      "Regular use of CopperOS's own model, with a monthly allowance. A task can run for up to 5 hours.",
    cents: 1000,
  },
  {
    key: "facet",
    name: "CopperOS Facet",
    description:
      "Heavy use of CopperOS's own model, with the largest monthly allowance. A task can run for up to 24 hours.",
    cents: 2500,
  },
  {
    key: "foundry",
    name: "CopperOS Foundry",
    description:
      "Bring your own OpenRouter or OpenAI key and choose your own model, plus your own Jev key for the supervisor if you like. You pay your provider for the model; this covers hosting, storage and convenience. No limit on how long one task runs.",
    cents: 500,
  },
];

// Every dollar buys the same number of credits; behind them, 55 cents of model
// use per dollar: what the model costs, plus Jev, AWS and Stripe's fee, plus a
// margin (billing.ts, and the pricing notes in the README).
export const PACKS: PackSpec[] = [5, 10, 25, 50].map((dollars) => ({
  dollars,
  credits: dollars * CREDITS_PER_DOLLAR,
  creditsUsd: Math.round(dollars * MODEL_USE_PER_DOLLAR * 100) / 100,
}));

export const WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] =
  [
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "invoice.paid",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ];

const tag = { app: "copperos" };

// How Stripe treats what is sold, for tax. Every product carries one, and Stripe's
// Managed Payments (Stripe as the seller of record, which an account can turn on
// as its default in the Dashboard) refuses to open a payment page without it.
// "SaaS, personal use" is the nearest fit for a browser agent that people use for
// themselves; txcd_10103001 is the business-use version, and the AI-as-a-service
// codes (txcd_10105003) are another candidate. Confirm the choice with whoever does
// the books, then change it here and run this again.
export const TAX_CODE = "txcd_10103000";

async function allProducts(stripe: Stripe): Promise<Stripe.Product[]> {
  return stripe.products
    .list({ limit: 100 })
    .autoPagingToArray({ limit: 1000 });
}

/** The product with this key, made if there is none, with its words brought up to date. */
export async function ensureProduct(
  stripe: Stripe,
  known: Stripe.Product[],
  spec: {
    key: string;
    name: string;
    description: string;
    metadata: Record<string, string>;
  },
): Promise<Stripe.Product> {
  const metadata = { ...tag, copperos_key: spec.key, ...spec.metadata };
  const found = known.find((p) => p.metadata?.copperos_key === spec.key);
  if (!found)
    return stripe.products.create({
      name: spec.name,
      description: spec.description,
      tax_code: TAX_CODE,
      metadata,
    });
  const taxCode =
    typeof found.tax_code === "string"
      ? found.tax_code
      : (found.tax_code?.id ?? null);
  const same =
    found.active &&
    found.name === spec.name &&
    found.description === spec.description &&
    taxCode === TAX_CODE &&
    Object.entries(metadata).every(([k, v]) => found.metadata?.[k] === v);
  return same
    ? found
    : stripe.products.update(found.id, {
        name: spec.name,
        description: spec.description,
        tax_code: TAX_CODE,
        active: true,
        metadata,
      });
}

/**
 * The price with this lookup key. If the amount changed, a new price takes the
 * key over and the old one is archived: a price in Stripe cannot be edited,
 * and people already subscribed keep paying the price they signed up to.
 */
export async function ensurePrice(
  stripe: Stripe,
  product: Stripe.Product,
  spec: {
    lookupKey: string;
    cents: number;
    monthly: boolean;
    metadata: Record<string, string>;
  },
): Promise<Stripe.Price> {
  const metadata = { ...tag, ...spec.metadata };
  const [found] = (
    await stripe.prices.list({
      lookup_keys: [spec.lookupKey],
      active: true,
      limit: 1,
    })
  ).data;
  const same =
    found &&
    found.unit_amount === spec.cents &&
    found.currency === "usd" &&
    (found.product === product.id ||
      (found.product as Stripe.Product | undefined)?.id === product.id) &&
    Boolean(found.recurring) === spec.monthly &&
    (!spec.monthly || found.recurring?.interval === "month");
  if (same) {
    const stale = Object.entries(metadata).some(
      ([k, v]) => found.metadata?.[k] !== v,
    );
    return stale ? stripe.prices.update(found.id, { metadata }) : found;
  }
  const made = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: spec.cents,
    lookup_key: spec.lookupKey,
    transfer_lookup_key: Boolean(found),
    ...(spec.monthly ? { recurring: { interval: "month" as const } } : {}),
    metadata,
  });
  if (found) await stripe.prices.update(found.id, { active: false });
  return made;
}

export type Made = {
  plans: Array<{
    plan: string;
    productId: string;
    priceId: string;
    cents: number;
  }>;
  packs: Array<{ priceId: string; cents: number; credits: number }>;
  portalId: string;
};

/** Products, prices, credit packs and the customer portal, all as CopperOS wants them. */
export async function ensureCatalog(stripe: Stripe): Promise<Made> {
  const known = await allProducts(stripe);
  const plans: Made["plans"] = [];
  for (const p of PLANS) {
    const product = await ensureProduct(stripe, known, {
      key: p.key,
      name: p.name,
      description: p.description,
      metadata: { kind: "plan", plan: p.key },
    });
    const price = await ensurePrice(stripe, product, {
      lookupKey: `copperos_${p.key}_monthly`,
      cents: p.cents,
      monthly: true,
      metadata: { kind: "plan", plan: p.key },
    });
    plans.push({
      plan: p.key,
      productId: product.id,
      priceId: price.id,
      cents: p.cents,
    });
  }

  const credits = await ensureProduct(stripe, known, {
    key: "credits",
    name: "CopperOS credits",
    description:
      "Credits for CopperOS's own model, used once your plan's allowance is spent. Every dollar buys 100 credits, and they never expire.",
    metadata: { kind: "credits" },
  });
  const packs: Made["packs"] = [];
  for (const pack of PACKS) {
    const price = await ensurePrice(stripe, credits, {
      lookupKey: `copperos_credits_${pack.dollars}`,
      cents: pack.dollars * 100,
      monthly: false,
      metadata: { kind: "credits", credits: String(pack.credits), credits_usd: String(pack.creditsUsd) },
    });
    packs.push({
      priceId: price.id,
      cents: pack.dollars * 100,
      credits: pack.credits,
    });
  }

  // Everything else a subscriber needs to do themselves, on Stripe's page.
  const portal: Stripe.BillingPortal.ConfigurationCreateParams = {
    business_profile: {
      headline: "Manage your CopperOS billing",
      privacy_policy_url: `${SITE}/privacy/`,
      terms_of_service_url: `${SITE}/terms/`,
    },
    features: {
      customer_update: {
        enabled: true,
        allowed_updates: ["email", "name", "address"],
      },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: {
        enabled: true,
        mode: "at_period_end",
        cancellation_reason: {
          enabled: true,
          options: [
            "too_expensive",
            "missing_features",
            "switched_service",
            "unused",
            "other",
          ],
        },
      },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ["price"],
        proration_behavior: "create_prorations",
        products: plans.map((p) => ({
          product: p.productId,
          prices: [p.priceId],
        })),
      },
    },
    metadata: tag,
  };
  const existing = (
    await stripe.billingPortal.configurations.list({ limit: 20 })
  ).data.find((c) => c.metadata?.app === "copperos");
  const config = existing
    ? await stripe.billingPortal.configurations.update(existing.id, {
        ...portal,
        active: true,
      })
    : await stripe.billingPortal.configurations.create(portal);
  return { plans, packs, portalId: config.id };
}

/**
 * The endpoint Stripe calls with payment events. The signing secret is only ever
 * shown when it is made. Events are sent in the API version this code was written
 * against, not whatever the account's default happens to be, so their shape
 * does not change under it.
 */
export async function registerWebhook(
  stripe: Stripe,
  url: string,
): Promise<{ id: string; secret: string | null }> {
  const found = (await stripe.webhookEndpoints.list({ limit: 100 })).data.find(
    (w) => w.url === url,
  );
  if (found) {
    await stripe.webhookEndpoints.update(found.id, {
      enabled_events: WEBHOOK_EVENTS,
      disabled: false,
    });
    return { id: found.id, secret: null };
  }
  const made = await stripe.webhookEndpoints.create({
    url,
    enabled_events: WEBHOOK_EVENTS,
    api_version:
      Stripe.API_VERSION as Stripe.WebhookEndpointCreateParams.ApiVersion,
    description: "CopperOS: plans and credits",
  });
  return { id: made.id, secret: made.secret ?? null };
}

async function store(
  stage: string,
  name: string,
  value: string,
): Promise<void> {
  await new SSMClient({}).send(
    new PutParameterCommand({
      Name: `/copperos/${stage}/${name}`,
      Type: "SecureString",
      Value: value,
      Overwrite: true,
    }),
  );
}

/** Which of Stripe's two worlds a key belongs to: secret keys are sk_, restricted ones rk_. */
export function modeOf(key: string): "live" | "test" | null {
  if (/^[sr]k_live_/.test(key)) return "live";
  if (/^[sr]k_test_/.test(key)) return "test";
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) =>
    args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const live = args.includes("--live");
  const name = live ? "LIVE_STRIPE_SECRET_KEY" : "STRIPE_SECRET_KEY";
  const key = process.env[name];
  if (!key) throw new Error(`${name} is not set. Put it in broker/.env.`);
  const kind = modeOf(key);
  if (live && kind !== "live")
    throw new Error(
      "--live needs a live key (sk_live_ or rk_live_), and LIVE_STRIPE_SECRET_KEY is not one.",
    );
  if (!live && kind !== "test")
    throw new Error(
      "Without --live this is the sandbox, and STRIPE_SECRET_KEY is not a test key. Pass --live to use the real account.",
    );
  const mode = live ? "LIVE" : "test";
  console.log(
    `Stripe ${mode} mode${mode === "LIVE" ? ": this makes real products for real customers" : " (the sandbox: nothing here is real)"}`,
  );

  const stripe = new Stripe(key, {
    maxNetworkRetries: 2,
    appInfo: { name: "CopperOS setup", version: "1.0.0" },
  });
  const made = await ensureCatalog(stripe);
  for (const p of made.plans)
    console.log(
      `  ${p.plan.padEnd(8)} $${(p.cents / 100).toFixed(2)}/month  ${p.priceId}`,
    );
  for (const p of made.packs)
    console.log(
      `  credits  $${(p.cents / 100).toFixed(2)} buys ${p.credits.toLocaleString("en-US")} credits  ${p.priceId}`,
    );
  console.log(`  portal   ${made.portalId}`);

  const stage = flag("--stage");
  const url = flag("--webhook");
  if (url) {
    const hook = await registerWebhook(stripe, url);
    console.log(`  webhook  ${hook.id}  ${url}`);
    if (stage && hook.secret) {
      await store(stage, "stripe-webhook-secret", hook.secret);
      console.log(
        `  stored the signing secret at /copperos/${stage}/stripe-webhook-secret`,
      );
    } else if (!hook.secret) {
      console.log(
        "  (already registered: Stripe shows its signing secret only once, when it is made)",
      );
    } else {
      console.log(
        "  no --stage given, so the signing secret was not kept. Delete the endpoint in Stripe and run again with --stage.",
      );
    }
  }
  if (stage) {
    await store(stage, "stripe-secret-key", key);
    console.log(
      `  stored the secret key at /copperos/${stage}/stripe-secret-key`,
    );
    if (stage === "prod" && mode !== "LIVE")
      console.log(
        "  note: prod now holds a TEST key. Use the live key for real customers.",
      );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err) => {
    console.error(String((err as Error)?.message ?? err));
    process.exit(1);
  });
}
