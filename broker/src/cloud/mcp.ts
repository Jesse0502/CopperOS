// The hosted MCP endpoint: where an AI app (Claude's custom connectors, and any
// other MCP client) is pointed to use a person's CopperOS. One Lambda behind a
// Function URL:
//
//   /mcp                          the tools, as MCP over HTTP (stateless, JSON answers)
//   /register /authorize /callback /consent /token /revoke
//   /.well-known/…                the sign-in (mcp-oauth.ts), which is how a client
//                                 finds out how to get a token
//
// A request to /mcp must carry the access token that sign-in issued; the tools
// then act as that person (mcp-backend.ts).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import type { Backend } from "../client/backend.js";
import { INSTRUCTIONS, registerTools } from "../client/tools.js";
import { CloudStore } from "../store/cloud.js";
import { useStore } from "../store/store.js";
import { aiLoosening } from "./ai-apps.js";
import { installBilling } from "./ledger.js";
import { cloudBackend, requestAllowed } from "./mcp-backend.js";
import { cognitoIdentity } from "./mcp-cognito.js";
import { createOAuth, type HttpRequest, type HttpResponse, type Identity } from "./mcp-oauth.js";
import { dynamoAuthStore, type AuthStore } from "./mcp-store.js";

useStore(new CloudStore());
// The usage meter the tools ask before starting a task (mcp-backend.ts).
installBilling();

function toRequest(event: LambdaFunctionURLEvent): HttpRequest {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) if (typeof v === "string") headers[k.toLowerCase()] = v;
  // The Function URL hands cookies over apart from the headers.
  if (event.cookies?.length) headers.cookie = event.cookies.join("; ");
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : "";
  return {
    method: event.requestContext.http.method,
    path: event.rawPath,
    query: new URLSearchParams(event.rawQueryString ?? ""),
    headers,
    body,
    ip: event.requestContext.http.sourceIp,
    base: `https://${event.requestContext.domainName}`,
  };
}

const result = (r: HttpResponse): LambdaFunctionURLResult => ({
  statusCode: r.status,
  headers: r.headers,
  ...(r.cookies ? { cookies: r.cookies } : {}),
  body: r.body ?? "",
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

export type McpDeps = {
  auth: AuthStore;
  identity: Identity;
  backend?: (userId: string, auth: AuthStore, opts: { loosening?: boolean }) => Backend;
};

export function createHandler(deps: McpDeps) {
  const oauth = createOAuth({ store: deps.auth, identity: deps.identity });
  const backendFor = deps.backend ?? cloudBackend;

  async function serve(req: HttpRequest): Promise<HttpResponse> {
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1] ?? "";
    const who = await oauth.authenticate(bearer);
    if (!who) {
      return json(401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${req.base}/.well-known/oauth-protected-resource"` });
    }
    if (!(await requestAllowed(deps.auth, who.userId))) {
      return json(429, { error: "rate_limited", error_description: "too many requests, slow down" }, { "retry-after": "30" });
    }

    // A fresh server for each request: nothing is kept between them, so any Lambda can answer any request.
    const server = new McpServer({ name: "copperos", version: "0.2.0" }, { instructions: INSTRUCTIONS });
    // Read each time, so turning it off in Settings takes effect on the app's next request.
    registerTools(server, backendFor(who.userId, deps.auth, { loosening: await aiLoosening(who.userId) }));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const answer = await transport.handleRequest(
      new Request(`${req.base}${req.path}`, { method: req.method, headers: req.headers, ...(hasBody ? { body: req.body } : {}) }),
    );
    const headers: Record<string, string> = {};
    answer.headers.forEach((v, k) => (headers[k] = v));
    return { status: answer.status, headers, body: await answer.text() };
  }

  return async (event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> => {
    const req = toRequest(event);
    try {
      if (req.path === "/mcp") return result(await serve(req));
      const answered = await oauth.handle(req);
      if (answered) return result(answered);
      if (req.method === "GET" && req.path === "/") {
        return result({
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: `CopperOS connector. In your AI app, add a custom connector with this address:\n${req.base}/mcp\n`,
        });
      }
      return result(json(404, { error: "not_found" }));
    } catch (err) {
      console.error(`[mcp] ${req.method} ${req.path}: ${String((err as Error)?.stack ?? err)}`);
      return result(json(500, { error: "server_error" }));
    }
  };
}

let real: ReturnType<typeof createHandler> | null = null;

export const handler = (event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> => {
  real ??= createHandler({
    auth: dynamoAuthStore(),
    identity: cognitoIdentity({
      userPoolId: process.env.USER_POOL_ID!,
      signInUrl: process.env.SIGN_IN_URL!,
      clientName: "mcp",
    }),
  });
  return real(event);
};
