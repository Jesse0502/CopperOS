// The WebSocket's $connect check. Two kinds of caller get a socket:
//   - a signed-in CopperOS user's extension, with its Cognito access token;
//   - a running task's agent Lambda, with the one-time pass the relay made
//     for it ("worker:<pass>").
// Browsers cannot set headers on a WebSocket, so either comes as ?token=.
// Who it is rides along to the relay as authorizer context.

import type { APIGatewayAuthorizerResult, APIGatewayRequestAuthorizerEvent } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { useGrant } from "./connections.js";

// Created once per container; it caches Cognito's signing keys between calls.
const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID!,
  clientId: process.env.CLIENT_ID!,
  tokenUse: "access",
});

const WORKER = "worker:";

function allow(
  resource: string,
  context: { userId: string; kind: "extension" | "worker"; chatId?: string },
): APIGatewayAuthorizerResult {
  return {
    principalId: context.userId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{ Action: "execute-api:Invoke", Effect: "Allow", Resource: resource }],
    },
    context,
  };
}

function deny(resource: string): APIGatewayAuthorizerResult {
  return {
    principalId: "anonymous",
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{ Action: "execute-api:Invoke", Effect: "Deny", Resource: resource }],
    },
  };
}

export async function handler(event: APIGatewayRequestAuthorizerEvent): Promise<APIGatewayAuthorizerResult> {
  const token = event.queryStringParameters?.token;
  if (!token) return deny(event.methodArn);

  if (token.startsWith(WORKER)) {
    const grant = await useGrant(token.slice(WORKER.length));
    if (!grant) {
      console.warn("[authorize] rejected an unknown or spent worker pass");
      return deny(event.methodArn);
    }
    return allow(event.methodArn, { userId: grant.userId, kind: "worker", chatId: grant.chatId });
  }

  try {
    const claims = await verifier.verify(token);
    return allow(event.methodArn, { userId: claims.sub, kind: "extension" });
  } catch (err) {
    console.warn(`[authorize] rejected a token: ${String((err as Error)?.message ?? err)}`);
    return deny(event.methodArn);
  }
}
