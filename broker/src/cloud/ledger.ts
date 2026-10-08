// The hosted service's usage ledger in DynamoDB, and the live limits.
//
//   Accounts  userId        → plan, planUntil, credits (micro-dollars)
//   Usage     userId, week  → spent (micro-dollars), tokens, calls; expires on its own
//   Usage     "_pool", "month:2026-10" → what the free plan has cost everyone that month
//
// Limits are dollars of model use per plan per week, and the free pool's
// ceiling per month. The defaults are in billing.ts; the Ore allowance and the
// pool can be set per stage at deploy (FREE_WEEKLY_USD, FREE_POOL_MONTHLY_USD),
// and anything can be changed live, with no deploy, in a Parameter Store
// parameter that holds JSON, e.g.
//   aws ssm put-parameter --name /copperos/prod/limits --type String --overwrite \
//     --value '{"ore":1.5,"ingot":4,"facet":10,"freePool":40}'
// Each Lambda picks it up within a minute.

import { ConditionalCheckFailedException, DynamoDBClient, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetParameterCommand, ParameterNotFound, SSMClient } from "@aws-sdk/client-ssm";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { useOwnKeyGate } from "../config.js";
import { useMeter } from "../meter.js";
import { DEFAULT_RUNTIME, withOverrides, type Runtime } from "./runtime.js";
import {
  allowsOwnKey,
  DEFAULT_LIMITS,
  periodStartOf,
  planOf,
  toUsd,
  UsageMeter,
  WEEK_MS,
  type Account,
  type Ledger,
  type Limits,
  type PlanId,
  type PoolAlert,
} from "./billing.js";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ssm = new SSMClient({});
const sns = new SNSClient({});

// The free pool's rows sit in the Usage table under a partition no user id can
// have (they are Cognito UUIDs), with the month as the sort key.
const POOL_USER = "_pool";
const poolKey = (month: string) => ({ userId: POOL_USER, week: `month:${month}` });

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

// A week's row is kept this long past its end, for looking back at what was spent.
const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_MS = 120 * DAY_MS;
// Stripe retries an event for up to three days; a claim is kept far past that.
const CLAIM_KEEP_MS = 45 * DAY_MS;

export const dynamoLedger: Ledger = {
  async account(userId): Promise<Account> {
    const res = await db.send(
      new GetCommand({
        TableName: env("ACCOUNTS_TABLE"),
        Key: { userId },
        ProjectionExpression: "#plan, #until, #credits, #cust, #sub, #period, #pend",
        ExpressionAttributeNames: {
          "#period": "periodStart",
          "#pend": "pendingCheckouts",
          "#plan": "plan",
          "#until": "planUntil",
          "#credits": "credits",
          "#cust": "stripeCustomerId",
          "#sub": "stripeSubscriptionId",
        },
        ConsistentRead: true,
      }),
    );
    return {
      plan: res.Item?.plan as string | undefined,
      planUntil: res.Item?.planUntil as number | undefined,
      credits: (res.Item?.credits as number | undefined) ?? 0,
      stripeCustomerId: res.Item?.stripeCustomerId as string | undefined,
      stripeSubscriptionId: res.Item?.stripeSubscriptionId as string | undefined,
      periodStart: res.Item?.periodStart as number | undefined,
      pendingCheckouts: res.Item?.pendingCheckouts ? [...(res.Item.pendingCheckouts as Set<string>)] : undefined,
    };
  },

  async usageIn(userId, period) {
    const res = await db.send(
      new GetCommand({
        TableName: env("USAGE_TABLE"),
        // The table's sort key is still called `week`; a paid plan's month is a row like any other ("m2026-10-08").
        Key: { userId, week: period },
        ProjectionExpression: "#spent, #in, #out, #cached",
        ExpressionAttributeNames: { "#spent": "spent", "#in": "inTokens", "#out": "outTokens", "#cached": "cachedTokens" },
        ConsistentRead: true,
      }),
    );
    const n = (k: string) => (res.Item?.[k] as number | undefined) ?? 0;
    return { spent: n("spent"), input: n("inTokens"), output: n("outTokens"), cached: n("cachedTokens") };
  },

  async weekActive(userId, week) {
    const res = await db.send(
      new GetCommand({
        TableName: env("USAGE_TABLE"),
        Key: { userId, week },
        ProjectionExpression: "#active",
        ExpressionAttributeNames: { "#active": "activeMs" },
        ConsistentRead: true,
      }),
    );
    return (res.Item?.activeMs as number | undefined) ?? 0;
  },

  async addActive(userId, week, ms) {
    const weekStart = Date.parse(week);
    await db.send(
      new UpdateCommand({
        TableName: env("USAGE_TABLE"),
        Key: { userId, week },
        UpdateExpression: "ADD #active :ms SET #ttl = :ttl",
        ExpressionAttributeNames: { "#active": "activeMs", "#ttl": "expiresAt" },
        ExpressionAttributeValues: { ":ms": Math.max(0, Math.round(ms)), ":ttl": Math.floor((weekStart + WEEK_MS + KEEP_MS) / 1000) },
      }),
    );
  },

  async addUsage(userId, period, add) {
    const startedAt = periodStartOf(period);
    const res = await db.send(
      new UpdateCommand({
        TableName: env("USAGE_TABLE"),
        Key: { userId, week: period },
        // Every name is an alias, so none can collide with a DynamoDB reserved word.
        UpdateExpression: "ADD #spent :s, #in :i, #out :o, #cached :c, #calls :one SET #ttl = :ttl",
        ExpressionAttributeNames: {
          "#spent": "spent",
          "#in": "inTokens",
          "#out": "outTokens",
          "#cached": "cachedTokens",
          "#calls": "calls",
          "#ttl": "expiresAt",
        },
        ExpressionAttributeValues: {
          ":s": add.spent,
          ":i": add.input,
          ":o": add.output,
          ":c": add.cached,
          ":one": 1,
          // A month's row lives as long as a week's does after it ends: a month and four months.
          ":ttl": Math.floor((startedAt + (period.startsWith("m") ? 31 * DAY_MS : WEEK_MS) + KEEP_MS) / 1000),
        },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return res.Attributes?.spent as number;
  },

  async addCredits(userId, delta) {
    const res = await db.send(
      new UpdateCommand({
        TableName: env("ACCOUNTS_TABLE"),
        Key: { userId },
        UpdateExpression: "ADD #credits :d",
        ExpressionAttributeNames: { "#credits": "credits" },
        ExpressionAttributeValues: { ":d": delta },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return res.Attributes?.credits as number;
  },

  async linkStripe(userId, link) {
    const sub = link.subscriptionId;
    await db.send(
      new UpdateCommand({
        TableName: env("ACCOUNTS_TABLE"),
        Key: { userId },
        UpdateExpression: sub === undefined ? "SET #cust = :c" : sub === null ? "SET #cust = :c REMOVE #sub" : "SET #cust = :c, #sub = :s",
        ExpressionAttributeNames: { "#cust": "stripeCustomerId", ...(sub !== undefined ? { "#sub": "stripeSubscriptionId" } : {}) },
        ExpressionAttributeValues: { ":c": link.customerId, ...(sub ? { ":s": sub } : {}) },
      }),
    );
    // So an event that names only the customer finds its user. The key cannot be
    // a user's id: those are Cognito UUIDs.
    await db.send(
      new PutCommand({ TableName: env("ACCOUNTS_TABLE"), Item: { userId: `stripe#${link.customerId}`, owner: userId } }),
    );
  },

  async pendingCheckout(userId, sessionId, open) {
    await db.send(
      new UpdateCommand({
        TableName: env("ACCOUNTS_TABLE"),
        Key: { userId },
        // A string set: adding one twice, or taking away one that is not there, changes nothing.
        UpdateExpression: open ? "ADD #pend :s" : "DELETE #pend :s",
        ExpressionAttributeNames: { "#pend": "pendingCheckouts" },
        ExpressionAttributeValues: { ":s": new Set([sessionId]) },
      }),
    );
  },

  async userByCustomer(customerId) {
    const res = await db.send(
      new GetCommand({ TableName: env("ACCOUNTS_TABLE"), Key: { userId: `stripe#${customerId}` }, ConsistentRead: true }),
    );
    return (res.Item?.owner as string | undefined) ?? null;
  },

  async grantCredits(userId, micros, key) {
    try {
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              // The purchase, marked as handled. It goes only if it never was.
              Put: {
                TableName: env("ACCOUNTS_TABLE"),
                Item: { userId: `claim#${key}`, owner: userId, expiresAt: Math.floor((Date.now() + CLAIM_KEEP_MS) / 1000) },
                ConditionExpression: "attribute_not_exists(userId)",
              },
            },
            {
              Update: {
                TableName: env("ACCOUNTS_TABLE"),
                Key: { userId },
                UpdateExpression: "ADD #credits :d",
                ExpressionAttributeNames: { "#credits": "credits" },
                ExpressionAttributeValues: { ":d": micros },
              },
            },
          ],
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof TransactionCanceledException && err.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed") return false;
      throw err;
    }
  },

  async poolSpent(month) {
    const res = await db.send(
      new GetCommand({
        TableName: env("USAGE_TABLE"),
        Key: poolKey(month),
        ProjectionExpression: "#spent",
        ExpressionAttributeNames: { "#spent": "spent" },
        ConsistentRead: true,
      }),
    );
    return (res.Item?.spent as number | undefined) ?? 0;
  },

  async addPool(month, micros) {
    const res = await db.send(
      new UpdateCommand({
        TableName: env("USAGE_TABLE"),
        Key: poolKey(month),
        UpdateExpression: "ADD #spent :s SET #ttl = :ttl",
        ExpressionAttributeNames: { "#spent": "spent", "#ttl": "expiresAt" },
        // Kept past the month's end for as long as a week's row is.
        ExpressionAttributeValues: { ":s": micros, ":ttl": Math.floor((Date.parse(`${month}-01`) + 31 * DAY_MS + KEEP_MS) / 1000) },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return res.Attributes?.spent as number;
  },

  async setPlan(userId, plan, until, periodStart) {
    const set = ["#plan = :p", ...(until ? ["#until = :u"] : []), ...(periodStart ? ["#period = :s"] : [])];
    const remove = [...(until ? [] : ["#until"]), ...(periodStart ? [] : ["#period"])];
    await db.send(
      new UpdateCommand({
        TableName: env("ACCOUNTS_TABLE"),
        Key: { userId },
        UpdateExpression: `SET ${set.join(", ")}${remove.length ? ` REMOVE ${remove.join(", ")}` : ""}`,
        ExpressionAttributeNames: { "#plan": "plan", "#until": "planUntil", "#period": "periodStart" },
        ExpressionAttributeValues: { ":p": plan, ...(until ? { ":u": until } : {}), ...(periodStart ? { ":s": periodStart } : {}) },
      }),
    );
  },
};

const LIMITS_TTL_MS = 60_000;
let limitsCache: { at: number; value: Limits } | null = null;

function fromEnv(): Limits {
  const limits = { ...DEFAULT_LIMITS };
  const set = (key: keyof Limits, name: string) => {
    const dollars = Number(process.env[name]);
    if (process.env[name] && Number.isFinite(dollars) && dollars >= 0) limits[key] = dollars;
  };
  set("ore", "FREE_WEEKLY_USD");
  set("freePool", "FREE_POOL_MONTHLY_USD");
  return limits;
}

/** The limits in force: the defaults and the stage's free numbers, with whatever the parameter overrides. */
export async function loadLimits(): Promise<Limits> {
  if (limitsCache && Date.now() - limitsCache.at < LIMITS_TTL_MS) return limitsCache.value;
  let value = fromEnv();
  const name = process.env.LIMITS_PARAM;
  if (name) {
    try {
      const res = await ssm.send(new GetParameterCommand({ Name: name }));
      const set = JSON.parse(res.Parameter?.Value ?? "{}") as Partial<Record<keyof Limits, unknown>>;
      for (const key of Object.keys(value) as Array<keyof Limits>) {
        const dollars = set[key];
        if (typeof dollars === "number" && Number.isFinite(dollars) && dollars >= 0) value[key] = dollars;
      }
    } catch (err) {
      if (!(err instanceof ParameterNotFound)) {
        // Keep the last limits seen rather than snapping back to the defaults.
        console.error(`[billing] could not read ${name}: ${String(err)}`);
        if (limitsCache) value = limitsCache.value;
      }
    }
  }
  limitsCache = { at: Date.now(), value };
  return value;
}

let runtimeCache: { at: number; value: Runtime } | null = null;

/** How long tasks may run on each plan: the defaults, with whatever the stage's parameter overrides (runtime.ts). */
export async function loadRuntime(): Promise<Runtime> {
  if (runtimeCache && Date.now() - runtimeCache.at < LIMITS_TTL_MS) return runtimeCache.value;
  let value = DEFAULT_RUNTIME;
  const name = process.env.RUNTIME_PARAM;
  if (name) {
    try {
      const res = await ssm.send(new GetParameterCommand({ Name: name }));
      value = withOverrides(DEFAULT_RUNTIME, JSON.parse(res.Parameter?.Value ?? "{}"));
    } catch (err) {
      if (!(err instanceof ParameterNotFound)) {
        console.error(`[runtime] could not read ${name}: ${String(err)}`);
        if (runtimeCache) value = runtimeCache.value;
      }
    }
  }
  runtimeCache = { at: Date.now(), value };
  return value;
}

/**
 * Whether this is the first time `mark` ("warn", "full") was set on the
 * month's pool — only the first caller gets true, however many runs cross the
 * line at once, so each warning is sent once a month.
 */
export async function markPoolAlert(month: string, mark: "warn" | "full"): Promise<boolean> {
  try {
    await db.send(
      new UpdateCommand({
        TableName: env("USAGE_TABLE"),
        Key: poolKey(month),
        UpdateExpression: "SET #mark = :now",
        ConditionExpression: "attribute_not_exists(#mark)",
        ExpressionAttributeNames: { "#mark": `alert_${mark}` },
        ExpressionAttributeValues: { ":now": Date.now() },
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

// Emails the owner as the free pool fills: once at 80%, once when it is spent
// (and free users are stopped until the month turns).
const ALERT_WARN_AT = 0.8;

export const poolAlert: PoolAlert = async (month, total, ceiling) => {
  const topic = process.env.ALERTS_TOPIC_ARN;
  if (!topic || ceiling <= 0) return;
  const money = (micros: number) => `$${toUsd(micros).toFixed(2)}`;
  let subject: string | null = null;
  let body = "";
  if (total >= ceiling) {
    if (await markPoolAlert(month, "full")) {
      await markPoolAlert(month, "warn");
      subject = "CopperOS: the free pool is spent";
      body =
        `The free plan has used ${money(total)} of its ${money(ceiling)} for ${month}. Free accounts are stopped until the month turns; ` +
        `people with credits, a paid plan or their own key are not affected. To let free usage carry on, raise "freePool" in the ` +
        `limits parameter; to make it last, lower "ore".`;
    }
  } else if (total >= ceiling * ALERT_WARN_AT) {
    if (await markPoolAlert(month, "warn")) {
      subject = "CopperOS: the free pool is 80% spent";
      body = `The free plan has used ${money(total)} of its ${money(ceiling)} for ${month}. At the ceiling, free accounts stop until the month turns.`;
    }
  }
  if (subject) await sns.send(new PublishCommand({ TopicArn: topic, Subject: subject, Message: body }));
};

/**
 * What the hosted entry points set up at startup: a meter for each user on
 * CopperOS's model, and the rule that only a plan that allows it (Foundry)
 * may run on the user's own API key.
 */
export function installBilling(): void {
  useMeter((userId) => new UsageMeter(userId, dynamoLedger, loadLimits, Date.now, poolAlert));
  useOwnKeyGate(async (userId) => allowsOwnKey(planOf(await dynamoLedger.account(userId), Date.now())));
}
