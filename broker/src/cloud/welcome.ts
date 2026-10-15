// Sends the welcome email (welcome-email.ts) to a new account, once. Cognito runs this after a
// person has signed up and confirmed: with an emailed code, and on the first sign-in with
// Google, which is a sign-up too.
//
// It is a trigger in the sign-up itself, and Cognito refuses a sign-up whose trigger fails, so
// nothing here may throw or stall: every problem is logged, and the person signs in regardless.
// An account is marked as welcomed before the email goes, so a trigger that runs twice cannot
// send it twice.

import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { PostConfirmationTriggerEvent } from "aws-lambda";
import { sendMail } from "./mail.js";
import { welcomeEmail } from "./welcome-email.js";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Cognito waits five seconds for a trigger; stop well before that.
const BUDGET_MS = 3500;

/** Marks the account as welcomed. False if it already was. */
async function claim(userId: string): Promise<boolean> {
  try {
    await db.send(
      new UpdateCommand({
        TableName: process.env.ACCOUNTS_TABLE,
        Key: { userId },
        UpdateExpression: "SET #w = :now",
        ConditionExpression: "attribute_not_exists(#w)",
        ExpressionAttributeNames: { "#w": "welcomedAt" },
        ExpressionAttributeValues: { ":now": Date.now() },
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

async function release(userId: string): Promise<void> {
  await db
    .send(
      new UpdateCommand({
        TableName: process.env.ACCOUNTS_TABLE,
        Key: { userId },
        UpdateExpression: "REMOVE #w",
        ExpressionAttributeNames: { "#w": "welcomedAt" },
      }),
    )
    .catch(() => {});
}

/** Sends the welcome email to `email` now, with no record kept (the admin tool's `welcome` uses it). */
export async function sendWelcome(email: string): Promise<void> {
  const mail = welcomeEmail({ support: process.env.REPLY_TO ?? "hello@jassydev.com" });
  await sendMail({ to: email, ...mail });
}

async function welcome(userId: string, email: string): Promise<void> {
  if (!(await claim(userId))) {
    console.log("[welcome] already welcomed");
    return;
  }
  try {
    await sendWelcome(email);
    console.log("[welcome] sent");
  } catch (err) {
    // Not sent: the mark goes, so the admin tool or a later trigger can try again.
    await release(userId);
    throw err;
  }
}

export async function handler(event: PostConfirmationTriggerEvent): Promise<PostConfirmationTriggerEvent> {
  try {
    // Not a password reset, which is also a confirmation.
    if (event.triggerSource !== "PostConfirmation_ConfirmSignUp") return event;
    const { sub, email } = event.request.userAttributes;
    if (!sub || !email) return event;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      welcome(sub, email),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.warn("[welcome] gave up waiting; sign-up goes on");
          resolve();
        }, BUDGET_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  } catch (err) {
    console.error(`[welcome] not sent: ${String((err as Error)?.message ?? err)}`);
  }
  return event;
}
