// Who the person is, for the MCP sign-in: CopperOS's own sign-in page (Cognito,
// with Google) through an app client made for it (named "mcp" in the stack),
// the authorization code flow with PKCE.
//
// The client's id is found by its name when first needed instead of being
// handed to the function: the client's return address is this function's own
// URL, and a function cannot be told the id of a client that depends on it.

import { CognitoIdentityProviderClient, ListUserPoolClientsCommand } from "@aws-sdk/client-cognito-identity-provider";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { Identity } from "./mcp-oauth.js";

export function cognitoIdentity(config: { userPoolId: string; signInUrl: string; clientName: string }): Identity {
  const cognito = new CognitoIdentityProviderClient({});
  let found: { clientId: string; verifier: ReturnType<typeof CognitoJwtVerifier.create> } | null = null;

  async function client() {
    if (found) return found;
    let token: string | undefined;
    do {
      const res = await cognito.send(new ListUserPoolClientsCommand({ UserPoolId: config.userPoolId, MaxResults: 60, NextToken: token }));
      const hit = res.UserPoolClients?.find((c) => c.ClientName === config.clientName);
      if (hit?.ClientId) {
        found = {
          clientId: hit.ClientId,
          verifier: CognitoJwtVerifier.create({ userPoolId: config.userPoolId, clientId: hit.ClientId, tokenUse: "id" }),
        };
        return found;
      }
      token = res.NextToken;
    } while (token);
    throw new Error(`no sign-in client named "${config.clientName}" in the user pool`);
  }

  return {
    async loginUrl({ state, challenge, redirectUri }) {
      const { clientId } = await client();
      return `${config.signInUrl}/oauth2/authorize?${new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        scope: "openid email",
        redirect_uri: redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      })}`;
    },

    async finish({ code, verifier, redirectUri }) {
      const { clientId, verifier: jwt } = await client();
      const res = await fetch(`${config.signInUrl}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier }),
      });
      if (!res.ok) throw new Error(`the sign-in page answered ${res.status} to the code`);
      const { id_token } = (await res.json()) as { id_token?: string };
      if (!id_token) throw new Error("the sign-in page sent no id token");
      const claims = await jwt.verify(id_token);
      return { userId: claims.sub, email: typeof claims.email === "string" ? claims.email : "your account" };
    },
  };
}
