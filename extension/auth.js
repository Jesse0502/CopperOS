// Signing in to the hosted CopperOS. The sign-in page is Cognito's own
// (Google or an emailed code), opened in Chrome's auth window; the code it
// returns is swapped for tokens with PKCE, since an extension cannot keep a
// client secret. Tokens live in chrome.storage.local: the access token opens
// the WebSocket, and the refresh token gets a new one when it runs out
// (Cognito keeps refresh tokens valid for 30 days).

import { cloud } from "./backend.js";

const KEY = "auth";
// Refresh this long before an access token expires, not after.
const SKEW_MS = 2 * 60_000;

function base64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(bytes = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function challengeFor(verifier) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(hash));
}

function claims(jwt) {
  try {
    const part = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part + "=".repeat((4 - (part.length % 4)) % 4)));
  } catch {
    return {};
  }
}

async function tokenRequest(form) {
  const CLOUD = await cloud();
  const res = await fetch(`${CLOUD.signInUrl}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLOUD.clientId, ...form }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error_description || body.error || `sign-in failed (${res.status})`);
    err.code = body.error;
    throw err;
  }
  return body;
}

async function save(tokens, refresh) {
  await chrome.storage.local.set({
    [KEY]: {
      access: tokens.access_token,
      refresh,
      email: claims(tokens.id_token).email ?? null,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    },
  });
}

/** Who is signed in, or null. */
export async function account() {
  const { [KEY]: auth } = await chrome.storage.local.get(KEY);
  return auth ? { email: auth.email } : null;
}

/** Open the sign-in page; resolves once signed in, with who. */
export async function signIn() {
  const CLOUD = await cloud();
  const redirectUri = chrome.identity.getRedirectURL();
  const verifier = randomString(48);
  const state = randomString(16);
  const url = `${CLOUD.signInUrl}/oauth2/authorize?${new URLSearchParams({
    client_id: CLOUD.clientId,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: redirectUri,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
    state,
  })}`;
  const back = new URL(await chrome.identity.launchWebAuthFlow({ url, interactive: true }));
  if (back.searchParams.get("error")) {
    throw new Error(back.searchParams.get("error_description") || back.searchParams.get("error"));
  }
  if (back.searchParams.get("state") !== state) throw new Error("Sign-in was interrupted. Please try again.");
  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code: back.searchParams.get("code") ?? "",
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  await save(tokens, tokens.refresh_token);
  return account();
}

let refreshing = null;

/**
 * A current access token, refreshed first when it is about to run out, or
 * null when signed out. `force` refreshes regardless — for a token the socket
 * has just turned away. A refresh the server refuses signs the user out; one
 * that fails for any other reason (offline) throws, to be tried again.
 */
export async function accessToken({ force = false } = {}) {
  const { [KEY]: auth } = await chrome.storage.local.get(KEY);
  if (!auth) return null;
  if (!force && auth.expiresAt - Date.now() > SKEW_MS) return auth.access;
  refreshing ??= (async () => {
    try {
      const tokens = await tokenRequest({ grant_type: "refresh_token", refresh_token: auth.refresh });
      await save(tokens, auth.refresh);
      return tokens.access_token;
    } catch (err) {
      if (err.code === "invalid_grant") {
        await chrome.storage.local.remove(KEY);
        return null;
      }
      throw err;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Forget the tokens, revoke the refresh token, and end the sign-in page's own session. */
export async function signOut() {
  const CLOUD = await cloud();
  const { [KEY]: auth } = await chrome.storage.local.get(KEY);
  await chrome.storage.local.remove(KEY);
  if (auth?.refresh) {
    await fetch(`${CLOUD.signInUrl}/oauth2/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: auth.refresh, client_id: CLOUD.clientId }),
    }).catch(() => {});
  }
  // Without this, the next sign-in would skip straight back in as the same person.
  const logout = `${CLOUD.signInUrl}/logout?${new URLSearchParams({
    client_id: CLOUD.clientId,
    logout_uri: chrome.identity.getRedirectURL(),
  })}`;
  await chrome.identity.launchWebAuthFlow({ url: logout, interactive: false }).catch(() => {});
}
