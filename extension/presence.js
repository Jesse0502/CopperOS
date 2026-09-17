// Agent presence: the in-page overlay on the tab(s) each chat is driving.
//
// overlay.js draws a glowing frame, a status pill, and a cursor that follows
// the agent's pointer. This module decides which tab(s) carry it: one per
// running chat, moving as that chat switches tabs, and only while that
// chat's run is in progress. Its host element is visible in the page's DOM,
// so PAGE_OVERLAY switches it off — worth doing on sites that watch their DOM
// for automation.
//
// The "CopperOS · <id>" tab group is workspace.js's job. It lives in Chrome's tab
// strip, where the page cannot see it, and is unaffected by PAGE_OVERLAY.

import { isAttached, stateFor as cdpStateFor } from "./cdp.js";

export const PAGE_OVERLAY = true;

// Long enough for the page to repaint without the overlay before a capture.
const CAPTURE_SETTLE_MS = 60;

// Per chat: whether it is active (a run in progress) and which tab it wants
// the overlay on. Two chats can each have their own tab lit up at once.
let active = {}; // chatId -> bool
let wantTabId = {}; // chatId -> tabId | null

// Persisted, so a recycled worker can still take down what it put up.
// { [chatId]: tabId } — one shown tab per chat.
let shown = {};
const ready = chrome.storage.session
  .get("presence")
  .then(({ presence }) => {
    if (presence) shown = presence;
  })
  .catch(() => {});
const save = () => chrome.storage.session.set({ presence: shown }).catch(() => {});

// Derived from `shown`: which tabs currently carry the overlay, regardless of
// which chat put it there. Capture/pointer events are tab-scoped and do not
// need to know the chat.
function isShown(tabId) {
  return Object.values(shown).includes(tabId);
}

// Show and hide both do several awaits against Chrome; interleaved, a run that
// ends while the frame is still being drawn could leave it behind.
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn).catch(() => {}));

/** Resolve with the reply, or undefined if nothing is listening in the tab. */
function tell(tabId, msg, timeoutMs = 300) {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, msg).catch(() => undefined),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
}

async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["overlay.js"] });
  } catch {
    return; // chrome:// pages, the Web Store, PDFs — places extensions may not draw
  }
  // A fresh document (after a navigation) starts with the cursor hidden; put
  // it back where the agent's pointer actually is.
  if (isAttached(tabId)) {
    const { cursor } = cdpStateFor(tabId);
    if (cursor.x || cursor.y) await tell(tabId, { tact: "at", x: cursor.x, y: cursor.y });
  }
}

async function hideFrom(chatId, tabId) {
  // Another chat may also be showing on this same tab (a rare but possible
  // collision) — only actually remove the overlay once nobody wants it there.
  delete shown[chatId];
  if (!isShown(tabId)) await tell(tabId, { tact: "remove" });
  save();
}

async function showOn(chatId, tabId) {
  if (!active[chatId]) return;
  const was = shown[chatId];
  if (was !== undefined && was !== tabId) await hideFrom(chatId, was);
  if (PAGE_OVERLAY) await inject(tabId);
  shown[chatId] = tabId;
  save();
}

async function clear(chatId) {
  if (shown[chatId] !== undefined) await hideFrom(chatId, shown[chatId]);
}

/** A chat's run started or stopped. `tabId` is the tab it drives, if known yet. */
export function setActive(chatId, on, tabId) {
  // Set synchronously, so a follow() arriving before this queue entry runs
  // already knows whether to draw.
  active[chatId] = on;
  if (tabId !== null && tabId !== undefined) wantTabId[chatId] = tabId;
  return serial(async () => {
    await ready;
    if (active[chatId] && wantTabId[chatId] != null) await showOn(chatId, wantTabId[chatId]);
    else if (!active[chatId]) await clear(chatId);
  });
}

/** This chat is now driving `tabId`. Cheap when nothing changed: every op calls it. */
export function follow(chatId, tabId) {
  if (tabId === null || tabId === undefined) return chain;
  if (tabId === wantTabId[chatId] && tabId === shown[chatId]) return chain;
  wantTabId[chatId] = tabId;
  if (!active[chatId]) return chain;
  return serial(async () => {
    await ready;
    await showOn(chatId, tabId);
  });
}

/** Pointer events from input.js. Fire-and-forget: never slows the input. */
export function pointer(evt) {
  if (!PAGE_OVERLAY || !isShown(evt.tabId)) return;
  if (evt.type === "move") {
    void tell(evt.tabId, { tact: "move", points: evt.points, delays: evt.delays });
  } else if (evt.type === "press") {
    void tell(evt.tabId, { tact: "press", x: evt.x, y: evt.y });
  }
}

/**
 * Run a capture with the overlay out of the picture.
 *
 * The model must see the page, not our frame and cursor: a glowing border or an
 * arrow labelled "CopperOS" in a screenshot is exactly the kind of thing it would
 * try to read or click.
 */
export async function hiddenDuring(tabId, capture) {
  if (!PAGE_OVERLAY || !isShown(tabId)) return capture();
  await tell(tabId, { tact: "suspend" });
  // Waited out here, not in the page: a background tab never runs
  // requestAnimationFrame, so waiting for a frame there could hang forever.
  await new Promise((r) => setTimeout(r, CAPTURE_SETTLE_MS));
  try {
    return await capture();
  } finally {
    void tell(tabId, { tact: "resume" });
  }
}

// A navigation replaces the document and the overlay with it; draw it again
// once the new page has loaded.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!PAGE_OVERLAY || info.status !== "complete" || !isShown(tabId)) return;
  void serial(() => inject(tabId));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void serial(() => {
    for (const chatId of Object.keys(shown)) {
      if (shown[chatId] === tabId) delete shown[chatId];
    }
    save();
  });
});
