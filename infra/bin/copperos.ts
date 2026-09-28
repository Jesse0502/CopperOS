// The hosted CopperOS backend, one stack per stage:
//
//   npx cdk deploy -c stage=dev --profile jassydev
//
// Settings live in cdk.json's context and can be overridden with -c, e.g.
// -c google=true once the Google OAuth client is stored in Secrets Manager.

import { App } from "aws-cdk-lib";
import { CopperStack } from "../lib/copperos-stack.js";

const app = new App();
const context = (key: string): string => {
  const value = app.node.tryGetContext(key);
  if (value === undefined || value === "") throw new Error(`missing context "${key}" — see cdk.json`);
  return String(value);
};

const stage = context("stage");
if (!/^[a-z][a-z0-9-]{1,15}$/.test(stage)) throw new Error(`stage "${stage}" must be short, lowercase letters, digits and dashes`);

new CopperStack(app, `CopperOS-${stage}`, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-1" },
  stage,
  google: context("google") === "true",
  extensionId: context("extensionId"),
  emailDomain: context("emailDomain"),
  alertEmail: context("alertEmail"),
  testModel: context("testModel") === "true",
});
