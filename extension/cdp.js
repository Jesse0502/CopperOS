// Low-level chrome.debugger / CDP plumbing.
//
// Deliberately NOT enabling the Runtime domain: the well-known CDP-detection
// trick logs an object with a getter on `.stack` to console.debug, and that
// getter only fires when Runtime is attached. Page/DOM/Accessibility/Input
// are all we need, and they leave that check silent.

import { isRestrictedUrl } from "./restricted.js";

const attached = new Map(); // tabId -> { cursor: {x, y} }

// chrome.debugger.attach's callback has, in practice, gone unfired for a
// discarded/frozen tab rather than erroring — which otherwise turns into an
// opaque 45s timeout three layers up at the broker, with no clue what
// happened. Bounding it here fails fast with a message that says why.
const ATTACH_TIMEOUT_MS = 10_000;

export function send(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(`${method}: ${err.message}`));
      else resolve(result);
    });
  });
}

export async function attach(tabId) {
  if (attached.has(tabId)) return attached.get(tabId);

  // chrome.debugger can't attach to chrome://, the Web Store, the PDF viewer,
  // etc. — check first so the failure is a clear, immediate message instead
  // of whatever raw string chrome.debugger.attach happens to reject with.
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && isRestrictedUrl(tab.url)) {
    throw new Error(
      `cannot control ${tab.url} — it's a restricted browser page ` +
      `(chrome://, the Web Store, a PDF viewer, …) that extensions cannot ` +
      `attach to. Navigate to an http(s) page first, or pick a different tab.`,
    );
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `chrome.debugger.attach on tab ${tabId} did not respond within ` +
        `${ATTACH_TIMEOUT_MS}ms — the tab may be discarded/frozen or ` +
        `already has DevTools open on it`,
      ));
    }, ATTACH_TIMEOUT_MS);
    chrome.debugger.attach({ tabId }, "1.3", () => {
      clearTimeout(timer);
      const err = chrome.runtime.lastError;
      // Re-attaching an already-attached tab is not a real failure.
      if (err && !/already attached/i.test(err.message)) reject(new Error(err.message));
      else resolve();
    });
  });

  await send(tabId, "Page.enable");
  await send(tabId, "DOM.enable");
  await send(tabId, "Accessibility.enable");

  const state = { cursor: { x: 0, y: 0 } };
  attached.set(tabId, state);
  return state;
}

export function stateFor(tabId) {
  const s = attached.get(tabId);
  if (!s) throw new Error(`tab ${tabId} is not attached`);
  return s;
}

export async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  await new Promise((resolve) => chrome.debugger.detach({ tabId }, () => {
    void chrome.runtime.lastError;
    resolve();
  }));
}

export function isAttached(tabId) {
  return attached.has(tabId);
}

chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId));
chrome.tabs.onRemoved.addListener((tabId) => attached.delete(tabId));
