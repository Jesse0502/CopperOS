// Low-level chrome.debugger / CDP plumbing.
//
// Deliberately NOT enabling the Runtime domain: the well-known CDP-detection
// trick logs an object with a getter on `.stack` to console.debug, and that
// getter only fires when Runtime is attached. Page/DOM/Accessibility/Input
// are all we need, and they leave that check silent.

const attached = new Map(); // tabId -> { cursor: {x, y} }

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

  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
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
