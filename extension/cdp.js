// Low-level chrome.debugger / CDP plumbing.
//
// Deliberately NOT enabling the Runtime domain: the well-known CDP-detection
// trick logs an object with a getter on `.stack` to console.debug, and that
// getter only fires when Runtime is attached. Page/DOM/Accessibility/
// Network/Input are all we need, and they leave that check silent.

import * as activity from "./activity.js";
import { isRestrictedUrl } from "./restricted.js";

const attached = new Map(); // tabId -> { cursor: {x, y} }
// Ops run concurrently, so two can reach an unattached tab at once; they
// share one attach rather than racing through setup twice.
const attaching = new Map(); // tabId -> Promise
// tabId -> { type, message } while a JavaScript dialog is open. A dialog
// blocks the page, so it is the first thing a stuck command is checked for.
const dialogs = new Map();

// chrome.debugger.attach's callback has, in practice, gone unfired for a
// discarded/frozen tab rather than erroring — which otherwise turns into an
// opaque 45s timeout three layers up at the broker, with no clue what
// happened. Bounding it here fails fast with a message that says why.
const ATTACH_TIMEOUT_MS = 10_000;

// Commands answer in milliseconds. One that has not answered in this long is
// stuck — a dialog is blocking the page, or the tab was frozen or discarded
// — and without a bound it only ever surfaced as the broker's 45s op
// timeout, on every op after it, with no clue why.
const COMMAND_TIMEOUT_MS = 15_000;

// A tab opened a moment ago by a click has no URL until its first navigation
// commits, only a pendingUrl.
const URL_WAIT_MS = 10_000;

export function send(tabId, method, params = {}, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(async () => {
      expired = true;
      reject(new Error(
        `${method} got no answer from tab ${tabId} within ${timeoutMs / 1000}s — ` +
        (await whyUnresponsive(tabId)),
      ));
    }, timeoutMs);
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      // Read even when the answer comes too late, or Chrome logs it unchecked.
      const err = chrome.runtime.lastError;
      if (expired) return;
      clearTimeout(timer);
      if (err) reject(new Error(`${method}: ${err.message}`));
      else resolve(result);
    });
  });
}

/** Why a tab might have stopped answering, in terms the model can act on. */
async function whyUnresponsive(tabId) {
  const dialog = dialogs.get(tabId);
  if (dialog) {
    return (
      `the page is showing a ${dialog.type} dialog ("${dialog.message.slice(0, 200)}") ` +
      `and is blocked until someone answers it. Ask the user to answer it in that tab.`
    );
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.discarded) return "Chrome discarded the tab to save memory. It is reloaded on the next attempt.";
    if (tab.frozen) return "Chrome froze the tab while it sat in the background. It is unfrozen on the next attempt.";
    if (tab.status === "loading") return "the page is still loading and not answering yet. Try again shortly.";
  } catch {
    return "the tab has been closed.";
  }
  return "the page is not answering (it may be busy or hung). Try again, or reload it with navigate.";
}

/**
 * The tab, once it is something CDP can drive: a tab opened a moment ago
 * gets time to commit its first URL, and a tab Chrome discarded is reloaded
 * — Chrome would reload it the moment anyone looked at it anyway.
 */
async function usableTab(tabId) {
  let tab = await chrome.tabs.get(tabId);
  if (tab.discarded) {
    await chrome.tabs.reload(tabId);
    tab = await chrome.tabs.get(tabId);
  }
  const deadline = Date.now() + URL_WAIT_MS;
  while (
    (!tab.url || tab.url === "about:blank") &&
    (tab.pendingUrl || tab.status === "loading") &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 100));
    tab = await chrome.tabs.get(tabId);
  }
  // chrome.debugger can't attach to chrome://, the Web Store, the PDF viewer,
  // etc. — check first so the failure is a clear, immediate message instead
  // of whatever raw string chrome.debugger.attach happens to reject with.
  if (isRestrictedUrl(tab.url)) {
    throw new Error(
      `cannot control ${tab.url || tab.pendingUrl || "a tab with no page yet"} — it's a ` +
      `restricted browser page (chrome://, the Web Store, a PDF viewer, …) or has not ` +
      `loaded anything yet, and extensions cannot attach to it. Navigate to an http(s) ` +
      `page first, or pick a different tab.`,
    );
  }
  return tab;
}

export async function attach(tabId) {
  if (attached.has(tabId)) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.discarded) {
      // Chrome can freeze a tab we are already on, too, once it has sat in
      // the background long enough.
      if (tab?.frozen) await unfreeze(tabId);
      return attached.get(tabId);
    }
    // Discarding took the page, and whatever we had set up on it, away.
    forgetTab(tabId);
  }
  let pending = attaching.get(tabId);
  if (!pending) {
    pending = usableTab(tabId)
      .then((tab) => connect(tabId, tab))
      .finally(() => attaching.delete(tabId));
    attaching.set(tabId, pending);
  }
  return pending;
}

// The browser answers this one itself, so it gets through to a frozen page.
function unfreeze(tabId) {
  return send(tabId, "Page.setWebLifecycleState", { state: "active" }).catch(() => {});
}

async function connect(tabId, tab) {
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

  try {
    if (tab.frozen) await unfreeze(tabId);
    await send(tabId, "Page.enable");
    await send(tabId, "DOM.enable");
    await send(tabId, "Accessibility.enable");
    // Lets waitForIdle see requests start and finish. The small buffers stop
    // Chrome holding on to response bodies nobody here will ask for.
    await send(tabId, "Network.enable", {
      maxTotalBufferSize: 1_000_000,
      maxResourceBufferSize: 100_000,
    });
    const { frameTree } = await send(tabId, "Page.getFrameTree");
    activity.track(tabId, frameTree.frame.id);
    // Enabling lifecycle events replays the ones the current document has
    // already fired — "load" among them, once it has loaded — so the tracker
    // starts out knowing whether the page is still loading.
    await send(tabId, "Page.setLifecycleEventsEnabled", { enabled: true });
  } catch (err) {
    // Half set up is worse than not attached: every later op would skip
    // straight past setup and hit the same wall. Let the next one start over.
    activity.forget(tabId);
    await new Promise((resolve) => chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError;
      resolve();
    }));
    throw err;
  }

  // A tab Chrome discards mid-task loses whatever was typed into it.
  chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});

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
  activity.forget(tabId);
  chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
  await new Promise((resolve) => chrome.debugger.detach({ tabId }, () => {
    void chrome.runtime.lastError;
    resolve();
  }));
}

export function isAttached(tabId) {
  return attached.has(tabId);
}

function forgetTab(tabId) {
  attached.delete(tabId);
  dialogs.delete(tabId);
  activity.forget(tabId);
}

chrome.debugger.onDetach.addListener(({ tabId }) => forgetTab(tabId));
chrome.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (method === "Page.javascriptDialogOpening") {
    dialogs.set(tabId, { type: params.type, message: params.message ?? "" });
  } else if (method === "Page.javascriptDialogClosed") {
    dialogs.delete(tabId);
  }
});
