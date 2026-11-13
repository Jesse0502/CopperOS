// Cognito runs this before any new account is made: through the sign-in page, through the
// SignUp API called directly with the client id (which ships inside the extension), or on a
// first sign-in with Google. Throwing refuses the sign-up.
//
// SIGN_UP_ALLOW, when set, is the only people who may sign up on the stage (dev): exact
// addresses, or "@domain" for a whole domain. EMAIL_SIGN_UP=off refuses accounts made with an
// email and code, so only Google can make one (prod, whose page shows only Google).

import type { PreSignUpTriggerEvent } from "aws-lambda";

const allowList = (process.env.SIGN_UP_ALLOW ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const allowListed = process.env.SIGN_UP_ALLOW !== undefined;

export async function handler(event: PreSignUpTriggerEvent): Promise<PreSignUpTriggerEvent> {
  // Accounts made by an admin (the AWS console or CLI) are always ours.
  if (event.triggerSource === "PreSignUp_AdminCreateUser") return event;

  const email = String(event.request.userAttributes?.email ?? "").trim().toLowerCase();
  const domain = email.includes("@") ? email.slice(email.lastIndexOf("@")) : "";

  if (allowListed && !(allowList.includes(email) || (domain && allowList.includes(domain)))) {
    console.warn(`[pre-sign-up] refused ${event.triggerSource}: not on this stage's list`);
    throw new Error("Sign-up is closed.");
  }
  if (process.env.EMAIL_SIGN_UP === "off" && event.triggerSource !== "PreSignUp_ExternalProvider") {
    console.warn(`[pre-sign-up] refused ${event.triggerSource}: only Google sign-up is open`);
    throw new Error("Sign up with Google.");
  }
  return event;
}
