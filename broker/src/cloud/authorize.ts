// The WebSocket's $connect check: only a signed-in CopperOS user gets a
// socket. The extension passes its Cognito access token as ?token=, since
// browsers cannot set headers on a WebSocket. The user's id (the token's
// `sub`) rides along to the relay as authorizer context.

import type { APIGatewayAuthorizerResult, APIGatewayRequestAuthorizerEvent } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";

// Created once per container; it caches Cognito's signing keys between calls.
const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID!,
  clientId: process.env.CLIENT_ID!,
  tokenUse: "access",
});

function policy(effect: "Allow" | "Deny", resource: string, userId?: string): APIGatewayAuthorizerResult {
  return {
    principalId: userId ?? "anonymous",
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{ Action: "execute-api:Invoke", Effect: effect, Resource: resource }],
    },
    ...(userId ? { context: { userId } } : {}),
  };
}

export async function handler(event: APIGatewayRequestAuthorizerEvent): Promise<APIGatewayAuthorizerResult> {
  const token = event.queryStringParameters?.token;
  if (!token) return policy("Deny", event.methodArn);
  try {
    const claims = await verifier.verify(token);
    return policy("Allow", event.methodArn, claims.sub);
  } catch (err) {
    console.warn(`[authorize] rejected a token: ${String((err as Error)?.message ?? err)}`);
    return policy("Deny", event.methodArn);
  }
}
