// The hosted CopperOS backend, one stack per stage:
//
//   npx cdk deploy -c stage=dev --profile jassydev
//
// and the account's spending guard (lib/guard-stack.ts), deployed once:
//
//   npx cdk deploy -c stage=guard --profile jassydev
//
// Settings live in cdk.json's context and can be overridden with -c, e.g.
// -c google=true once the Google OAuth client is stored in Parameter Store.

import { existsSync, readFileSync } from "node:fs";
import { App } from "aws-cdk-lib";
import { CopperStack } from "../lib/copperos-stack.js";
import { GuardStack } from "../lib/guard-stack.js";

const app = new App();
const context = (key: string): string => {
  const value = app.node.tryGetContext(key);
  if (value === undefined || value === "") throw new Error(`missing context "${key}" — see cdk.json`);
  return String(value);
};

const stage = context("stage");

// Kept out of the public repo (git-ignored): who may sign up on non-prod stages, and addresses
// refused everywhere. { "devSignUpAllow": ["me@x.com", "@mydomain.com"], "blockedIps": ["1.2.3.4"] }
const privatePath = new URL("../private.json", import.meta.url);
const priv: { devSignUpAllow?: string[]; blockedIps?: string[] } = existsSync(privatePath)
  ? JSON.parse(readFileSync(privatePath, "utf8"))
  : {};
if (!/^[a-z][a-z0-9-]{1,15}$/.test(stage)) throw new Error(`stage "${stage}" must be short, lowercase letters, digits and dashes`);

if (stage === "guard") {
  const spendCap = Number(context("spendCap"));
  if (!(spendCap > 0)) throw new Error(`spendCap must be a number of dollars above 0`);
  new GuardStack(app, "CopperOS-guard", {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-1" },
    spendCap,
    alertEmail: context("alertEmail"),
  });
} else {
  const mcpReserved = Number(app.node.tryGetContext("mcpReservedConcurrency") ?? (stage === "prod" ? 100 : 0));
  new CopperStack(app, `CopperOS-${stage}`, {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-1" },
    stage,
    google: context("google") === "true",
    extensionId: context("extensionId"),
    devExtensionIds: String(app.node.tryGetContext("devExtensionIds") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
    emailDomain: context("emailDomain"),
    // Stages whose sign-in page offers an emailed code; add prod once SES
    // production access is approved.
    emailSignIn: context("emailSignIn").split(",").map((s) => s.trim()).includes(stage),
    alertEmail: context("alertEmail"),
    feedbackEmail: context("feedbackEmail"),
    // Prod is open to anyone with Google; every other stage only to the listed people (nobody
    // if infra/private.json is missing).
    ...(stage === "prod" ? {} : { signUpAllow: priv.devSignUpAllow ?? [] }),
    blockedIps: priv.blockedIps ?? [],
    freeWeeklyUsd: Number(app.node.tryGetContext("freeWeeklyUsd") ?? 2),
    freePoolMonthlyUsd: Number(app.node.tryGetContext("freePoolMonthlyUsd") ?? 50),
    testModel: context("testModel") === "true",
    // Lambda concurrency kept for the public MCP endpoint. Prod keeps 100 of the account's 1000, so a
    // flood at its address cannot starve the agent; other stages keep none. Override with
    // -c mcpReservedConcurrency=<n> (0 for none).
    ...(mcpReserved > 0 ? { mcpReservedConcurrency: mcpReserved } : {}),
  });
}
