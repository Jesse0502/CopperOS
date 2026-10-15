// The sign-in an AI app goes through to use a person's CopperOS: OAuth 2.1 with
// PKCE and dynamic client registration, which is what MCP clients such as
// Claude's expect to find at a connector's address. It is a small
// authorization server of its own. The person's identity comes from CopperOS's
// existing sign-in (Cognito, with Google), reached through `Identity`; what
// this issues are its own tokens, which work only on the MCP endpoint and are
// kept as hashes (mcp-store.ts).
//
//   app ─ /register ─► client id
//   app ─ /authorize ─► Cognito sign-in ─► /callback ─► consent page ─► /consent ─► app's redirect, with a code
//   app ─ /token ─► access token (1 hour) and refresh token (30 days, replaced each time it is used)
//
// A sign-in is tied to the browser that started it by a cookie, so a link
// carrying someone else's sign-in cannot be finished by a person who did not
// start it, and nothing is connected until the person has seen who is asking
// and pressed Allow.

import { createHash, randomBytes } from "node:crypto";
import type { AuthStore } from "./mcp-store.js";

export type HttpRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: string;
  ip: string;
  /** https://<this endpoint's host>, no trailing slash. */
  base: string;
};

export type HttpResponse = { status: number; headers?: Record<string, string>; cookies?: string[]; body?: string };

/** Who the person is, from CopperOS's sign-in. */
export interface Identity {
  loginUrl(a: { state: string; challenge: string; redirectUri: string }): Promise<string>;
  finish(a: { code: string; verifier: string; redirectUri: string }): Promise<{ userId: string; email: string }>;
}

export const ACCESS_TTL_S = 60 * 60;
export const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const CLIENT_TTL_S = 90 * 24 * 60 * 60;
const AUTHREQ_TTL_S = 10 * 60;
const CODE_TTL_S = 5 * 60;

// Requests from one address, per hour, to the endpoints anyone can reach.
const IP_LIMITS = { register: 20, authorize: 60, token: 120 } as const;

const random = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

const COOKIE = "copper_mcp";
const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

type Client = { name: string; redirectUris: string[] };
type AuthRequest = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  verifier: string;
  userId?: string;
  email?: string;
};
type CodeRecord = { clientId: string; redirectUri: string; codeChallenge: string; userId: string };
type TokenRecord = { userId: string; clientId: string };

const json = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const redirect = (to: string, cookies?: string[]): HttpResponse => ({ status: 302, headers: { location: to, ...NO_STORE }, ...(cookies ? { cookies } : {}) });

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string, status = 200, cookies?: string[]): HttpResponse {
  return {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...NO_STORE,
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "x-frame-options": "DENY",
    },
    ...(cookies ? { cookies } : {}),
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
:root{color-scheme:dark light;--bg:#151515;--fg:#f1ece6;--mute:#a79d93;--line:#34302c;--copper:#d97757;--solid:#b85a33}
@media (prefers-color-scheme:light){:root{--bg:#faf7f3;--fg:#211d19;--mute:#6f655b;--line:#ddd5cc}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;display:grid;min-height:100vh;place-items:center;padding:16px}
main{max-width:30rem;width:100%}h1{font-size:1.4rem;margin:0 0 .75rem}p,li{color:var(--mute)}ul{padding-left:1.2rem}strong,b{color:var(--fg)}
.row{display:flex;gap:.75rem;margin-top:1.5rem;flex-wrap:wrap}button{font:inherit;padding:.65rem 1.2rem;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
button.allow{background:var(--solid);border-color:var(--solid);color:#fff}.small{font-size:.85rem}
</style></head><body><main>${body}</main></body></html>`,
  };
}

const problem = (message: string) => page("CopperOS", `<h1>That did not work</h1><p>${esc(message)}</p><p class="small">Close this tab and start again from the app.</p>`, 400);

/** The form fields (urlencoded) or JSON fields of a request body. */
function fields(req: HttpRequest): Record<string, unknown> {
  const type = req.headers["content-type"] ?? "";
  if (type.includes("application/json")) {
    try {
      const parsed = JSON.parse(req.body || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(req.body));
}

const text = (v: unknown, max = 2000) => (typeof v === "string" ? v.slice(0, max) : "");

const cookieOf = (req: HttpRequest, name: string): string | null => {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
};

/** Why a redirect address cannot be registered, or null if it can. */
export function redirectProblem(uri: string): string | null {
  if (uri.length > 500) return "too long";
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return "not an address";
  }
  if (url.hash) return "has a fragment";
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (["javascript", "data", "file", "vbscript", "about", "blob", "chrome", "chrome-extension"].includes(scheme)) return "not allowed";
  if (scheme === "http" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return "http is only for the computer you are on";
  return null;
}

/** An app on the same computer picks its own port, so a loopback address matches on everything but the port. */
function sameRedirect(registered: string, given: string): boolean {
  if (registered === given) return true;
  try {
    const a = new URL(registered);
    const b = new URL(given);
    const loopback = a.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(a.hostname);
    return loopback && a.protocol === b.protocol && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

function backTo(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

export function createOAuth(deps: { store: AuthStore; identity: Identity; now?: () => number }) {
  const { store, identity } = deps;

  /** Counts a request from `ip` against the hourly limit for `kind`: true if it may go on. */
  async function allowed(req: HttpRequest, kind: keyof typeof IP_LIMITS): Promise<boolean> {
    const hour = Math.floor((deps.now?.() ?? Date.now()) / 3_600_000);
    return (await store.increment(`rate:ip:${req.ip}:${kind}:${hour}`, 2 * 3600)) <= IP_LIMITS[kind];
  }

  const tooMany = () => json(429, { error: "temporarily_unavailable", error_description: "too many requests, try again later" }, { "retry-after": "600" });

  async function issue(userId: string, clientId: string) {
    const access = random();
    const refresh = random();
    await store.put(`access#${sha(access)}`, { userId, clientId }, ACCESS_TTL_S);
    await store.put(`refresh#${sha(refresh)}`, { userId, clientId }, REFRESH_TTL_S);
    return json(
      200,
      { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: "copperos" },
      NO_STORE,
    );
  }

  const handlers: Record<string, (req: HttpRequest) => Promise<HttpResponse>> = {
    async "GET /.well-known/oauth-protected-resource"(req) {
      return json(200, { resource: `${req.base}/mcp`, authorization_servers: [req.base], bearer_methods_supported: ["header"], resource_name: "CopperOS" });
    },

    async "GET /.well-known/oauth-authorization-server"(req) {
      return json(200, {
        issuer: req.base,
        authorization_endpoint: `${req.base}/authorize`,
        token_endpoint: `${req.base}/token`,
        registration_endpoint: `${req.base}/register`,
        revocation_endpoint: `${req.base}/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["copperos"],
      });
    },

    async "POST /register"(req) {
      if (!(await allowed(req, "register"))) return tooMany();
      const body = fields(req);
      const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string").slice(0, 5) : [];
      if (!uris.length) return json(400, { error: "invalid_redirect_uri", error_description: "redirect_uris is required" });
      for (const uri of uris) {
        const why = redirectProblem(uri);
        if (why) return json(400, { error: "invalid_redirect_uri", error_description: `${uri}: ${why}` });
      }
      const name = text(body.client_name, 80).replace(/[\r\n\t]+/g, " ").trim() || "An app";
      const clientId = `c_${random(16)}`;
      await store.put(`client#${clientId}`, { name, redirectUris: uris }, CLIENT_TTL_S);
      return json(201, {
        client_id: clientId,
        client_name: name,
        redirect_uris: uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        client_id_issued_at: Math.floor((deps.now?.() ?? Date.now()) / 1000),
      });
    },

    async "GET /authorize"(req) {
      if (!(await allowed(req, "authorize"))) return tooMany();
      const q = req.query;
      const clientId = q.get("client_id") ?? "";
      const client = clientId ? await store.get<Client>(`client#${clientId}`) : null;
      const redirectUri = q.get("redirect_uri") ?? "";
      // Until the app and its address are known, an error is shown here, not sent anywhere.
      if (!client) return problem("This app is not registered with CopperOS.");
      const match = client.redirectUris.find((r) => sameRedirect(r, redirectUri));
      if (!match) return problem("This app asked to return to an address it did not register.");
      const state = q.get("state") ?? undefined;
      const fail = (error: string) => redirect(backTo(redirectUri, { error, state }));
      if (q.get("response_type") !== "code") return fail("unsupported_response_type");
      const challenge = q.get("code_challenge") ?? "";
      if (!challenge || q.get("code_challenge_method") !== "S256") return fail("invalid_request");
      // The client's registration lasts as long as it is used.
      await store.put(`client#${clientId}`, client as unknown as Record<string, unknown>, CLIENT_TTL_S);

      const id = random();
      const verifier = random();
      await store.put(`authreq#${id}`, { clientId, redirectUri, codeChallenge: challenge, state, verifier } satisfies AuthRequest, AUTHREQ_TTL_S);
      const to = await identity.loginUrl({ state: id, challenge: s256(verifier), redirectUri: `${req.base}/callback` });
      return redirect(to, [`${COOKIE}=${id}; Max-Age=${AUTHREQ_TTL_S}; Path=/; HttpOnly; Secure; SameSite=Lax`]);
    },

    async "GET /callback"(req) {
      const id = req.query.get("state") ?? "";
      if (!id || cookieOf(req, COOKIE) !== id) return problem("This sign-in was started in a different browser, or has run out of time.");
      const auth = await store.get<AuthRequest>(`authreq#${id}`);
      if (!auth) return problem("This sign-in has run out of time.");
      const code = req.query.get("code");
      if (!code) {
        await store.take(`authreq#${id}`);
        return redirect(backTo(auth.redirectUri, { error: "access_denied", state: auth.state }));
      }
      let who: { userId: string; email: string };
      try {
        who = await identity.finish({ code, verifier: auth.verifier, redirectUri: `${req.base}/callback` });
      } catch (err) {
        console.warn(`[mcp-oauth] sign-in failed: ${String((err as Error)?.message ?? err)}`);
        return problem("Signing in did not work.");
      }
      await store.put(`authreq#${id}`, { ...auth, userId: who.userId, email: who.email }, AUTHREQ_TTL_S);
      const client = await store.get<Client>(`client#${auth.clientId}`);
      const host = (() => {
        const u = new URL(auth.redirectUri);
        return u.host || `${u.protocol}`;
      })();
      return page(
        "Connect to CopperOS",
        `<h1>Connect ${esc(client?.name ?? "this app")} to CopperOS?</h1>
<p>Signed in as <b>${esc(who.email)}</b>. After you allow it, you go back to <b>${esc(host)}</b>.</p>
<p><b>${esc(client?.name ?? "This app")}</b> will be able to:</p>
<ul>
<li>read your chats, memories and molds</li>
<li>start, watch and stop tasks in your Chrome, using your CopperOS plan</li>
<li>raise a chat's approvals and turn its supervisor on</li>
</ul>
<p>It will not be able to approve a task's actions for you. Lowering approvals, turning the supervisor off, and adding memories or molds stay off unless you turn them on in CopperOS Settings.</p>
<form method="post" action="/consent"><input type="hidden" name="request" value="${esc(id)}">
<div class="row"><button class="allow" name="decision" value="allow">Allow</button><button name="decision" value="deny">Cancel</button></div></form>`,
      );
    },

    async "POST /consent"(req) {
      const body = fields(req);
      const id = text(body.request, 200);
      if (!id || cookieOf(req, COOKIE) !== id) return problem("This sign-in was started in a different browser, or has run out of time.");
      const auth = await store.take<AuthRequest>(`authreq#${id}`);
      if (!auth?.userId) return problem("This sign-in has run out of time.");
      const clear = [`${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`];
      if (body.decision !== "allow") return redirect(backTo(auth.redirectUri, { error: "access_denied", state: auth.state }), clear);
      const code = random();
      await store.put(
        `code#${sha(code)}`,
        { clientId: auth.clientId, redirectUri: auth.redirectUri, codeChallenge: auth.codeChallenge, userId: auth.userId } satisfies CodeRecord,
        CODE_TTL_S,
      );
      return redirect(backTo(auth.redirectUri, { code, state: auth.state }), clear);
    },

    async "POST /token"(req) {
      if (!(await allowed(req, "token"))) return tooMany();
      const body = fields(req);
      const clientId = text(body.client_id, 200);
      const grant = text(body.grant_type, 50);
      const bad = (error: string, description?: string) => json(400, { error, ...(description ? { error_description: description } : {}) }, NO_STORE);

      if (grant === "authorization_code") {
        const code = text(body.code, 200);
        const record = code ? await store.take<CodeRecord>(`code#${sha(code)}`) : null;
        if (!record) return bad("invalid_grant", "the code is unknown, used or expired");
        const verifier = text(body.code_verifier, 200);
        if (record.clientId !== clientId || record.redirectUri !== text(body.redirect_uri, 500) || !verifier || s256(verifier) !== record.codeChallenge) {
          return bad("invalid_grant", "the code does not match this request");
        }
        return issue(record.userId, record.clientId);
      }

      if (grant === "refresh_token") {
        const refresh = text(body.refresh_token, 200);
        const record = refresh ? await store.take<TokenRecord>(`refresh#${sha(refresh)}`) : null;
        if (!record || record.clientId !== clientId) return bad("invalid_grant", "the refresh token is unknown, used or expired");
        return issue(record.userId, record.clientId);
      }

      return bad("unsupported_grant_type");
    },

    async "POST /revoke"(req) {
      const token = text(fields(req).token, 200);
      if (token) {
        await store.take(`access#${sha(token)}`);
        await store.take(`refresh#${sha(token)}`);
      }
      return { status: 200, headers: NO_STORE, body: "" };
    },
  };

  return {
    /** The response for a request to one of the sign-in endpoints, or null if the path is not one. */
    async handle(req: HttpRequest): Promise<HttpResponse | null> {
      // Clients ask for the discovery documents with the resource's path on the end too.
      const path = (req.path.startsWith("/.well-known/") ? req.path.replace(/\/mcp$/, "") : req.path).replace(/\/$/, "") || "/";
      const handler = handlers[`${req.method} ${path}`];
      return handler ? handler(req) : null;
    },

    /** Whose access token this is, or null if it is not one, or has run out. */
    async authenticate(bearer: string): Promise<{ userId: string; clientId: string } | null> {
      if (!bearer) return null;
      const record = await store.get<TokenRecord>(`access#${sha(bearer)}`);
      return record ? { userId: record.userId, clientId: record.clientId } : null;
    },
  };
}
