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
if (!/^[a-z][a-z0-9-]{1,15}$/.test(stage)) throw new Error(`stage "${stage}" must be short, lowercase letters, digits and dashes`);

if (stage === "guard") {
  const spendCap = Number(context("spendCap"));
  if (!(spendCap > 0)) throw new Error(`spendCap must be a number of dollars above 0`);
  new GuardStack(app, "CopperOS-guard", {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-1" },
    spendCap,
    alertEmail: context("alertEmail"),
  });
} else new CopperStack(app, `CopperOS-${stage}`, {
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
  testModel: context("testModel") === "true",
});
