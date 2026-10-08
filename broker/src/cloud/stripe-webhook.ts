// Stripe's webhook, on a public URL (a Lambda function URL). Whatever arrives is
// believed only if it carries Stripe's signature, made with a secret only the
// two of us know; anything else is turned away before it is read.
//
// An event that was handled gets a 200, and so does one that is of no interest
// or names nobody we know: Stripe would only send it again. One that failed
// for a reason that may pass (a database hiccup) gets a 500, and Stripe retries
// it for days; handling is safe to repeat (see stripe-events.ts).

import { GetParameterCommand, ParameterNotFound, SSMClient } from "@aws-sdk/client-ssm";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { dynamoLedger } from "./ledger.js";
import { handleStripeEvent } from "./stripe-events.js";
import { stripeClient } from "./stripe.js";

let secret: Promise<string | null> | null = null;

function webhookSecret(): Promise<string | null> {
  secret ??= (async () => {
    if (process.env.STRIPE_WEBHOOK_SECRET) return process.env.STRIPE_WEBHOOK_SECRET;
    const name = process.env.STRIPE_WEBHOOK_PARAM;
    if (!name) return null;
    try {
      const res = await new SSMClient({}).send(new GetParameterCommand({ Name: name, WithDecryption: true }));
      return res.Parameter?.Value ?? null;
    } catch (err) {
      if (err instanceof ParameterNotFound) return null;
      throw err;
    }
  })()
    .then((found) => {
      // Not stored yet is not an answer to remember: it is stored right after the webhook is registered.
      if (!found) secret = null;
      return found;
    })
    .catch((err) => {
      secret = null;
      throw err;
    });
  return secret;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const [stripe, signing] = await Promise.all([stripeClient(), webhookSecret()]);
  if (!stripe || !signing) {
    console.error("[stripe] billing is not set up on this stage: no key or no signing secret");
    return { statusCode: 503 };
  }
  const body = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
  const signature = event.headers["stripe-signature"];
  if (!signature) return { statusCode: 400 };

  let verified;
  try {
    verified = stripe.webhooks.constructEvent(body, signature, signing);
  } catch (err) {
    console.warn(`[stripe] turned away a request: ${String((err as Error)?.message ?? err)}`);
    return { statusCode: 400 };
  }

  try {
    console.log(`[stripe] ${verified.type} ${verified.id}: ${await handleStripeEvent(verified, { stripe, ledger: dynamoLedger })}`);
    return { statusCode: 200 };
  } catch (err) {
    console.error(`[stripe] ${verified.type} ${verified.id} failed: ${String((err as Error)?.stack ?? err)}`);
    return { statusCode: 500 };
  }
}
