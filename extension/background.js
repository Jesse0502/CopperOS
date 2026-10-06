// Service worker: WebSocket bridge to the broker + op router.
//
// The broker is either the one on this computer or the hosted CopperOS
// (backend.js); the protocol is the same, so everything below works with
// both. The hosted one needs a signed-in user (auth.js), and takes big
// results in pieces.
//
// The extension is "hands only". It owns CDP and the timing model; it holds
// no API key and makes no decisions. The broker sends high-level ops keyed by
// accessibility refs and gets structured results back.
//
// Every chat is its own agent on the broker side, and every op/event carries
// a chatId. This file's job is to keep each chat's browser state — which tab
// it drives, its own tab group, its own overlay — from ever touching another
// chat's, so several chats can run at once without interfering.

import { attach, detach, isAttached } from "./cdp.js";
import { diffSnapshots, lastSnapshot, snapshot } from "./snapshot.js";
import * as input from "./input.js";
import * as nav from "./nav.js";
import * as sheets from "./sheets.js";
import { uploadFiles } from "./upload.js";
import * as som from "./som.js";
import * as screencast from "./screencast.js";
import * as presence from "./presence.js";
import * as workspace from "./workspace.js";
import * as auth from "./auth.js";
import { LOCAL_URL, cloud, getBackend, setBackend } from "./backend.js";

// The UI lives in the side panel, not a popup: it stays open across tab
// switches within a window instead of closing the moment focus leaves.
// There is no action.default_popup in the manifest, so this is what makes
// clicking the toolbar icon open it.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// The overlay's cursor follows the agent's real pointer path.
input.observePointer(presence.pointer);

// Both follow the tab a chat is driving: the overlay marks it, the workspace
// keeps it in that chat's own group and tidies away tabs left behind.
function driving(chatId, tabId) {
  void presence.follow(chatId, tabId);
  void workspace.drive(chatId, tabId);
  if (chatId === session.chatId) announceTab();
}
function runChanged(chatId, on) {
  if (!chatId) return;
  presence.setActive(chatId, on, chatCtx(chatId).tabId);
  void workspace.setRunning(chatId, on, chatCtx(chatId).tabId);
}

const RECONNECT_MS = 2000;
// After the hosted socket has turned us away a few times in a row, try less often.
const REFUSED_BACKOFF_MS = 30000;
const PING_MS = 20000;
const KEEPALIVE_ALARM = "broker-keepalive";
const MAX_EVENTS = 80;
const TERMINAL = ["done", "error", "cancelled"];

let ws = null;
let pingTimer = null;
let reconnectTimer = null;
let connecting = false;
const panelPorts = new Set();

// Where the broker is, and who is signed in to it when it is the hosted one.
let backend = "local";
let signedIn = null; // { email } or null
// Whether this person has said where CopperOS runs. Until then the panel asks.
let chosen = true;
// "Ask before" in Settings: the approval mode new chats start with, or null
// to leave it to the broker.
let approvalDefault = null;
// Whether new chats start with the supervisor on: the last choice made with
// the composer's Supervisor button, or null to leave it to the broker.
let supervisorDefault = null;
// Connection attempts in a row that the hosted socket refused before opening
// — an expired or revoked token. The next one refreshes the token first.
let refused = 0;

// The person's brakes, enforced here whatever the broker does: an op for a
// chat under either is refused, and the broker ends that chat's run when it
// sees the refusal (Halted, in its bridge.ts). So Stop and the agent switch
// work even if the cancel never reaches the broker.
//  - agentOff: chats whose agent switch is off, until switched back on.
//    Kept across browser restarts.
//  - session.stopped: chats stopped with Stop, until their next task starts.
let agentOff = {};
// Stops clicked while the broker was out of reach, sent once it is back.
const pendingCancels = new Set();

function haltReason(chatId) {
  if (!chatId) return null;
  if (agentOff[chatId]) return "The user switched the agent off in this chat, so it cannot act in the browser.";
  if (session.stopped[chatId]) return "The user stopped this task.";
  return null;
}

/** Stop a chat's task: refuse its ops from now on, and tell the broker — now, or once it is back. */
function stopChat(chatId) {
  if (!chatId) return;
  session.stopped[chatId] = true;
  persist();
  if (ws && ws.readyState === WebSocket.OPEN) send({ type: "cancel", chatId });
  else pendingCancels.add(chatId);
}

// ── per-chat tab context ─────────────────────────────────────────────────────
//
// Every chat gets its own tab to drive, tracked here by chat id. Only `tabId`
// is persisted (a revived worker must keep driving the *original* tab rather
// than whatever is now active); `lastSnapshot` is cheap to regenerate and not
// worth persisting.
const chats = new Map(); // chatId -> { tabId, lastSnapshot }
let tabsByChat = {}; // persisted mirror of chatId -> tabId

function chatCtx(chatId) {
  let ctx = chats.get(chatId);
  if (!ctx) {
    ctx = { tabId: tabsByChat[chatId] ?? null, lastSnapshot: { interactiveRefs: [] } };
    chats.set(chatId, ctx);
  }
  return ctx;
}

function persistTabs() {
  tabsByChat = {};
  for (const [id, ctx] of chats) {
    if (ctx.tabId !== null) tabsByChat[id] = ctx.tabId;
  }
  chrome.storage.session.set({ tabsByChat }).catch(() => {});
}

// ── session state ───────────────────────────────────────────────────────────
//
// None of this can live only in memory. A side panel persists across tab
// switches, but not across a browser restart, and MV3 recycles idle service
// workers under it regardless. So this holds everything the panel needs to
// redraw itself.
//
// storage.session is in-memory and cleared when the browser closes, so page
// text in the log never reaches disk.
let session = {
  chatId: null, // which chat is currently being viewed
  running: false,
  task: null,
  approvalMode: "submits",
  supervisor: false, // whether the viewed chat's tasks get supervisor check-ins
  events: [],
  approval: null, // { id, text } while a gate is open on the viewed chat
  watching: false, // live-view toggle, restored with the panel
  // chatId -> { id, text }, for every chat with an open gate, not just the
  // viewed one — this is what lights up the history icon and its rows.
  pendingApprovals: {},
  ask: null, // { id, ask: { intro, questions } } while an ask_user form is open on the viewed chat
  // chatId -> { id, ask }, for every chat with questions waiting, like pendingApprovals.
  pendingAsks: {},
  // The last list of saved chats, shown at once when Past chats opens while
  // a fresh one loads.
  chats: null,
  // chatId -> true for chats stopped with Stop; see haltReason.
  stopped: {},
};

// Each backend keeps its own panel state; switching never mixes them.
const sessionKey = () => `session:${backend}`;

const ready = (async () => {
  backend = await getBackend();
  signedIn = await auth.account().catch(() => null);
  const stored = await chrome.storage.local
    .get(["backend", "approvalDefault", "supervisorDefault", "agentOff"])
    .catch(() => ({}));
  if (stored.agentOff && typeof stored.agentOff === "object") agentOff = stored.agentOff;
  chosen = stored.backend === "local" || stored.backend === "cloud";
  approvalDefault = ["all", "submits", "none"].includes(stored.approvalDefault) ? stored.approvalDefault : null;
  supervisorDefault = typeof stored.supervisorDefault === "boolean" ? stored.supervisorDefault : null;
  try {
    const { [sessionKey()]: saved, tabsByChat: savedTabs } =
      await chrome.storage.session.get([sessionKey(), "tabsByChat"]);
    if (saved) {
      session = {
        ...session,
        ...saved,
        pendingApprovals: saved.pendingApprovals ?? {},
        pendingAsks: saved.pendingAsks ?? {},
        stopped: saved.stopped ?? {},
      };
    }
    if (savedTabs) tabsByChat = savedTabs;
    setBadge(needsAttention());
    // A recycled worker mid-run: keep marking the tab. The broker's chat_state
    // on reconnect corrects this if the run ended while we were down.
    if (session.running) runChanged(session.chatId, true);
  } catch {
    // First run in this browser session; defaults are already correct.
  }
  // A panel left open while this worker was gone has lost its connection to
  // it; this tells it to open a new one.
  chrome.runtime.sendMessage({ type: "worker_started" }).catch(() => {});
})();

function persist() {
  chrome.storage.session.set({ [sessionKey()]: session }).catch(() => {});
}

// Visible while any chat has an open gate, so an approval waiting behind a
// closed panel — or behind a different chat than the one being viewed — is
// discoverable without the user having to guess.
function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? "!" : "" });
  if (on) chrome.action.setBadgeBackgroundColor({ color: "#c2410c" });
}

/** Chats waiting on the user — an approval or questions — for the badge and the history alert. */
function waitingChatIds() {
  return [...new Set([...Object.keys(session.pendingApprovals), ...Object.keys(session.pendingAsks)])];
}

function needsAttention() {
  return waitingChatIds().length > 0;
}

function broadcastApprovalFlags() {
  broadcastToPanels({ type: "approval_flags", chatIds: waitingChatIds() });
}

function recordEvent(msg) {
  const chatId = msg.chatId ?? null;
  // `chatId: null` is a broker-wide notice (e.g. shutting down) — shown
  // regardless of which chat is on screen, since there is nowhere better.
  const forViewed = chatId === null || chatId === session.chatId;

  if (msg.event === "approval_request") {
    if (chatId !== null) {
      session.pendingApprovals[chatId] = { id: msg.id, text: msg.text ?? "" };
      broadcastApprovalFlags();
    }
    if (forViewed) session.approval = { id: msg.id, text: msg.text ?? "" };
    setBadge(true);
    persist();
    if (forViewed) broadcastToPanels(msg);
    return;
  }

  if (msg.event === "ask_request") {
    const pending = { id: msg.id, ask: msg.ask ?? { intro: "", questions: [] } };
    if (chatId !== null) {
      session.pendingAsks[chatId] = pending;
      broadcastApprovalFlags();
    }
    if (forViewed) session.ask = pending;
    setBadge(true);
    persist();
    if (forViewed) broadcastToPanels(msg);
    return;
  }

  // A chat stopped with Stop acts again once its next task starts — the run
  // before it has ended by then, since a chat runs one task at a time.
  if (msg.event === "start" && chatId !== null && session.stopped[chatId]) {
    delete session.stopped[chatId];
  }

  if (msg.event === "start" && forViewed) {
    session.running = true;
    session.task = msg.text ?? null;
    runChanged(session.chatId, true);
    // The log is not cleared here: the chat is continuous across tasks, so a
    // new turn appends. MAX_EVENTS keeps it bounded.
  }

  if (TERMINAL.includes(msg.event)) {
    if (chatId !== null && (session.pendingApprovals[chatId] || session.pendingAsks[chatId])) {
      delete session.pendingApprovals[chatId];
      delete session.pendingAsks[chatId];
      broadcastApprovalFlags();
    }
    if (forViewed) {
      session.running = false;
      session.approval = null;
      session.ask = null;
      runChanged(session.chatId, false);
    }
    setBadge(needsAttention());
  }

  if (!forViewed) {
    persist();
    return; // bookkeeping only — never mixes another chat's events into this transcript
  }

  // `at` lets a reopened panel say how long a run has taken.
  session.events.push({ event: msg.event, text: msg.text ?? "", at: Date.now() });
  if (session.events.length > MAX_EVENTS) {
    session.events.splice(0, session.events.length - MAX_EVENTS);
  }
  persist();
  broadcastToPanels(msg);
}

// ── target tab ──────────────────────────────────────────────────────────────

async function freshTab() {
  const t = await chrome.tabs.create({ active: false });
  return t.id;
}

// The ownership check here and the actual claim (via driving() below) are not
// atomic — two chats picking a first tab in the very same tick could both
// pass the check before either claims it. Not reachable from one panel
// driving one task at a time, which is the only way a chat's first action
// happens in practice; left undefended rather than adding cross-chat locking
// for a race that a human cannot actually trigger.
// Resolves which tab a chat drives without attaching — navigate needs this
// split so it can route around a restricted starting page (chrome://newtab
// on a freshly opened tab, chrome://settings, …) before CDP ever touches it.
async function resolveTabId(chatId, explicit) {
  // A revived worker has not read its stored tab ids yet; without this wait it
  // could hijack whatever the user is viewing before knowing better.
  await ready;
  const ctx = chatCtx(chatId);
  if (explicit) ctx.tabId = explicit;
  if (ctx.tabId === null) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    // Look at what you have open by default — but never hijack a tab another
    // chat is already driving or has opened; open this chat a fresh one instead.
    const owner = active ? await workspace.ownerOf(active.id) : chatId;
    ctx.tabId = active && (owner === null || owner === chatId) ? active.id : await freshTab();
  }
  // Verify the tab still exists; it may have been closed mid-run.
  try {
    await chrome.tabs.get(ctx.tabId);
  } catch {
    ctx.tabId = await freshTab();
  }
  return ctx.tabId;
}

async function targetTab(chatId, explicit) {
  const tabId = await resolveTabId(chatId, explicit);
  await attach(tabId);
  persistTabs();
  driving(chatId, tabId);
  return tabId;
}

// ── tabs opened by our own actions ──────────────────────────────────────────
//
// "Apply now" buttons open the real form in a new tab. Nothing about the
// controlled tab changes, so the button is still sitting there in the next
// snapshot and the model clicks it again, and again. Following the new tab is
// what a person does, and it is the only way the model can tell the click
// worked.
//
// Tracked by the exact opener tab id, not by chat — several chats can each be
// mid-action at once, and this way each only ever claims the tab its own
// action opened.
let openedTabs = []; // { tabId, openerTabId, at }

// How long an action waits for what it set off — a navigation, data loading
// into the page, a new tab — before reporting back. Most settle far sooner:
// an action that sets off nothing is back after the quiet stretch alone.
const SETTLE_MS = 8000;
const SETTLE_QUIET_MS = 300;

// The agent works in background tabs. Chrome itself decides to raise a window
// when a page calls window.open, and an extension cannot veto that — but it
// can put things back straight away, which is the difference between a flicker
// and a Chrome window parked on top of whatever you were doing.
const KEEP_BACKGROUND = true;

async function focusSnapshot() {
  try {
    const win = await chrome.windows.getLastFocused();
    const [active] = await chrome.tabs.query({ active: true, windowId: win.id });
    return {
      windowId: win.id,
      activeTabId: active?.id ?? null,
      // There is no API for "is Chrome the frontmost app". A last-focused
      // window that is not focused is a good proxy for the user being in
      // another app entirely — and in that case re-focusing a Chrome window
      // is itself the thing that would drag Chrome over their work.
      chromeHadFocus: Boolean(win.focused),
    };
  } catch {
    return null;
  }
}

async function keepInBackground(newTabId, before) {
  if (!KEEP_BACKGROUND || !before) return;
  try {
    const tab = await chrome.tabs.get(newTabId);

    // A window.open popup arrives as its own window, sitting on top of
    // everything. Folding it back into the window it came from leaves the
    // popup window empty, so Chrome closes it and the intruder is gone.
    if (tab.windowId !== before.windowId) {
      try {
        await chrome.tabs.move(newTabId, { windowId: before.windowId, index: -1 });
      } catch {
        // Popup and normal windows cannot always be merged. Nothing else to do.
      }
    }

    // tabs.update silently ignores active:false, so the only way to send the
    // new tab to the background is to re-activate the tab the user was on.
    if (before.activeTabId !== null && before.activeTabId !== newTabId) {
      await chrome.tabs.update(before.activeTabId, { active: true });
    }
    if (before.chromeHadFocus) {
      await chrome.windows.update(before.windowId, { focused: true });
    }
  } catch {
    // The tab went away, or the window did. Nothing left to put back.
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId === undefined) return;
  const now = Date.now();
  openedTabs = openedTabs.filter((t) => now - t.at < SETTLE_MS * 2);
  openedTabs.push({ tabId: tab.id, openerTabId: tab.openerTabId, at: now });
});

function takeOpenedTab(openerId) {
  const idx = openedTabs.findIndex((t) => t.openerTabId === openerId);
  return idx === -1 ? null : openedTabs.splice(idx, 1)[0].tabId;
}

/**
 * Wait until the action's effects have played out: the page went quiet, or
 * it opened a new tab (returned, to be followed). A fixed wait used to sit
 * here — 1.5s after every click and every field filled, whether or not
 * anything could happen.
 */
async function settleOrOpen(openerId) {
  let decided = false;
  const watch = (async () => {
    while (!decided) {
      const id = takeOpenedTab(openerId);
      if (id !== null) return id;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  })();
  const idle = nav
    .waitForIdle(openerId, { timeoutMs: SETTLE_MS, quietMs: SETTLE_QUIET_MS })
    .then(() => null);
  const opened = await Promise.race([watch, idle]);
  decided = true;
  // A tab can appear in the very moment the page went quiet.
  return opened ?? takeOpenedTab(openerId);
}

// ── what the model sees after an action ─────────────────────────────────────
//
// Every action reports the page as it is afterwards, so the model does not
// spend a whole turn on a snapshot to find out whether it worked. Refs are
// stable (see snapshot.js), so on the same page that report is just what
// changed; after a navigation, or a change too big to read as a list, it is
// the whole page.

// Past this many changed lines, the whole page reads better than the list.
const DIFF_MAX_LINES = 40;

/** A snapshot's text with site-specific help added: on a Google Sheet, the cells a snapshot cannot show. */
async function fullPage(tabId, snap) {
  if (!sheets.sheetOf(snap.url)) return { text: snap.text, weak: snap.weak };
  const header = await sheets.sheetHeader(tabId);
  const [title, url, ...rest] = snap.text.split("\n");
  // No screenshot: the header shows the cells, and a picture of the grid
  // gives the model nothing it can act on.
  return { text: [title, url, header, ...rest].join("\n"), weak: null };
}

/** Snapshot `tabId` and describe it against the previous snapshot of that tab. */
async function observe(chatId, tabId, { full = false } = {}) {
  const prev = lastSnapshot(tabId);
  let next;
  try {
    next = await snapshot(tabId);
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
  chatCtx(chatId).lastSnapshot = next;
  const base = { url: next.url, title: next.title, interactiveCount: next.interactiveRefs.length };

  if (!full && prev && prev.loaderId === next.loaderId && prev.url === next.url) {
    const changes = diffSnapshots(prev, next);
    const big = changes.length > DIFF_MAX_LINES ||
      (changes.length > 8 && changes.length > next.entries.length / 2);
    if (!big) {
      return { ...base, full: false, changes: changes.length, text: changes.join("\n"), snapshot: next.text, weak: null };
    }
  }
  const page = await fullPage(tabId, next);
  return { ...base, full: true, text: page.text, snapshot: page.text, weak: page.weak };
}

/**
 * Run an input op on `openerId`, let its effects settle, take over any tab it
 * opened, and report the page afterwards. `settle: false` is for filling a
 * field: nothing to load and nothing to open, so it is reported straight away.
 */
async function afterAction(chatId, openerId, act, { settle = true } = {}) {
  // Captured before the action, because the action is what disturbs it.
  const before = settle ? await focusSnapshot() : null;
  const result = await act();
  const opened = settle ? await settleOrOpen(openerId) : null;
  if (opened === null) return { ...result, page: await observe(chatId, openerId) };

  await keepInBackground(opened, before);
  // This chat opened it, so it is one this chat may close when done with it.
  void workspace.adopt(chatId, opened);

  // Attached before it becomes the tab this chat drives. One that cannot be
  // controlled (it never loaded, or landed on a page extensions may not
  // touch) would otherwise fail every op after this one — while the action
  // that opened it, which did work, got reported as an error.
  try {
    await attach(opened);
  } catch (err) {
    const t = await chrome.tabs.get(opened).catch(() => null);
    return {
      ...result,
      newTabNotFollowed: {
        tabId: opened,
        url: t?.url || t?.pendingUrl || "",
        reason: String(err?.message ?? err),
      },
      page: await observe(chatId, openerId),
    };
  }

  const ctx = chatCtx(chatId);
  ctx.tabId = opened;
  persistTabs();
  driving(chatId, ctx.tabId); // the highlight and the group move with the agent
  try {
    await nav.waitForIdle(ctx.tabId, { timeoutMs: 10000 });
  } catch {
    // Still loading is fine — the model can wait again.
  }
  let info = {};
  try {
    const t = await chrome.tabs.get(ctx.tabId);
    info = { url: t.url, title: t.title };
  } catch {
    // Opened and closed again already.
  }
  return {
    ...result,
    followedNewTab: { tabId: ctx.tabId, ...info },
    page: await observe(chatId, ctx.tabId, { full: true }),
  };
}

// ── op router ───────────────────────────────────────────────────────────────
//
// Every handler takes one params object, always including `chatId` — merged
// in by the dispatcher below whether the call came from the broker or was
// made locally (e.g. resuming the live view for whichever chat is viewed).

const OPS = {
  async list_tabs({ chatId }) {
    await ready;
    const [tabs, owned] = await Promise.all([nav.listTabs(), workspace.ownedIds(chatId)]);
    const ctx = chatCtx(chatId);
    // openedByYou tells the model which tabs close_tab will accept.
    return tabs.map((t) => ({
      ...t,
      openedByYou: owned.has(t.tabId),
      controlling: t.tabId === ctx.tabId,
    }));
  },

  async close_tab({ chatId, tabId }) {
    await ready;
    const ctx = chatCtx(chatId);
    const id = tabId ?? ctx.tabId;
    if (id === null || id === undefined) throw new Error("there is no tab to close");
    if (!(await workspace.owns(chatId, id))) {
      throw new Error(
        `tab ${id} was not opened by you — it is the user's, so it stays open`,
      );
    }
    const wasControlling = id === ctx.tabId;
    await workspace.close(chatId, id);
    if (!wasControlling) return { closed: id };

    // Hand control back to the tab driven before this one, so the agent is
    // never left pointing at nothing — or silently at whatever tab you have
    // in front of you.
    const next = await workspace.previous(chatId, id);
    ctx.tabId = next;
    persistTabs();
    if (next === null) return { closed: id, nowControlling: null };
    await attach(next);
    driving(chatId, next);
    const t = await chrome.tabs.get(next).catch(() => null);
    return { closed: id, nowControlling: { tabId: next, url: t?.url, title: t?.title } };
  },

  async open_tab({ chatId, url }) {
    await ready;
    const r = await nav.openTab(url);
    const ctx = chatCtx(chatId);
    ctx.tabId = r.tabId;
    await attach(ctx.tabId);
    persistTabs();
    void workspace.adopt(chatId, r.tabId);
    driving(chatId, ctx.tabId);
    await nav.waitForIdle(ctx.tabId);
    return { ...r, page: await observe(chatId, ctx.tabId, { full: true }) };
  },

  async activate_tab({ chatId, tabId }) {
    await ready;
    const r = await nav.activateTab(tabId);
    const ctx = chatCtx(chatId);
    ctx.tabId = tabId;
    await attach(ctx.tabId);
    persistTabs();
    driving(chatId, ctx.tabId);
    return { ...r, page: await observe(chatId, ctx.tabId, { full: true }) };
  },

  async navigate({ chatId, url, tabId }) {
    const id = await resolveTabId(chatId, tabId);
    const tab = await chrome.tabs.get(id).catch(() => null);
    // A fresh tab defaults to chrome://newtab, and the active tab may well be
    // a chrome://, Web Store, or PDF-viewer page — none of which CDP can
    // attach to. Get off it with the plain tabs API first; attach() then
    // succeeds normally on the real page escapeRestrictedPage() already
    // navigated to, so navigate() below must skip re-navigating to it.
    const wasRestricted = Boolean(tab && nav.isRestrictedUrl(tab.url));
    if (wasRestricted) {
      await nav.escapeRestrictedPage(id, url);
    }
    await attach(id);
    persistTabs();
    driving(chatId, id);
    const r = await nav.navigate(id, url, { skipNavigate: wasRestricted });
    return { ...r, page: await observe(chatId, id, { full: true }) };
  },

  async go_back({ chatId, tabId }) {
    const id = await targetTab(chatId, tabId);
    const r = await nav.goBack(id);
    return { ...r, page: await observe(chatId, id, { full: true }) };
  },

  async wait_for_idle({ chatId, tabId, timeoutMs }) {
    const id = await targetTab(chatId, tabId);
    const r = await nav.waitForIdle(id, { timeoutMs });
    return { ...r, page: await observe(chatId, id) };
  },

  async snapshot({ chatId, tabId }) {
    const id = await targetTab(chatId, tabId);
    const snap = await snapshot(id);
    chatCtx(chatId).lastSnapshot = snap;
    const page = await fullPage(id, snap);
    return {
      text: page.text,
      weak: page.weak,
      interactiveCount: snap.interactiveRefs.length,
    };
  },

  // Captures are taken with the overlay hidden, so the model sees the page
  // and not our frame and cursor.
  async badged_screenshot({ chatId, tabId }) {
    const id = await targetTab(chatId, tabId);
    const refs = chatCtx(chatId).lastSnapshot.interactiveRefs ?? [];
    return presence.hiddenDuring(id, () => som.badgedScreenshot(id, refs));
  },

  async screenshot({ chatId, tabId }) {
    const id = await targetTab(chatId, tabId);
    return { data: await presence.hiddenDuring(id, () => som.screenshot(id)) };
  },

  async read_page({ chatId, tabId, maxChars }) {
    return { text: await nav.readPage(await targetTab(chatId, tabId), { maxChars }) };
  },

  async click({ chatId, ref, tabId, button, clickCount }) {
    const id = await targetTab(chatId, tabId);
    return afterAction(chatId, id, () => input.click(id, ref, { button, clickCount }));
  },

  async hover({ chatId, ref, tabId }) {
    const id = await targetTab(chatId, tabId);
    return afterAction(chatId, id, () => input.hover(id, ref));
  },

  // Filling a field sets nothing off, so only a submit waits to see what
  // happens — and it can open results in a new tab just like a click can.
  async type({ chatId, ref, text, submit, tabId }) {
    const id = await targetTab(chatId, tabId);
    return afterAction(chatId, id, () => input.typeText(id, ref, text, { submit }), {
      settle: Boolean(submit),
    });
  },

  async paste({ chatId, ref, text, submit, tabId }) {
    const id = await targetTab(chatId, tabId);
    return afterAction(chatId, id, () => input.pasteText(id, ref, text, { submit }), {
      settle: Boolean(submit),
    });
  },

  // The bytes come from the broker, which only sends files from folders the
  // user allowed (UPLOAD_DIRS). See upload.js for why no path is used.
  async upload_file({ chatId, ref, files, tabId }) {
    const id = await targetTab(chatId, tabId);
    return afterAction(chatId, id, () => uploadFiles(id, ref, files));
  },

  async select_option({ chatId, ref, value, tabId }) {
    const id = await targetTab(chatId, tabId);
    return afterAction(chatId, id, () => input.selectOption(id, ref, value));
  },

  async press_key({ chatId, key, repeat, tabId }) {
    const id = await targetTab(chatId, tabId);
    return afterAction(chatId, id, () => input.pressKey(id, key, { repeat }));
  },

  async scroll({ chatId, direction, amount, tabId }) {
    const id = await targetTab(chatId, tabId);
    return afterAction(chatId, id, () => input.scroll(id, { direction, amount }));
  },

  async sheet_read({ chatId, range, tabId }) {
    const id = await targetTab(chatId, tabId);
    const { text } = await sheets.readRange(id, { range });
    return { text };
  },

  // Both wait for what they need themselves: the write for Sheets to save,
  // the selection for the Name box to take it.
  async sheet_write({ chatId, start, rows, tabId }) {
    const id = await targetTab(chatId, tabId);
    return afterAction(chatId, id, () => sheets.writeCells(id, { start, rows }), { settle: false });
  },

  async sheet_select({ chatId, range, tabId }) {
    const id = await targetTab(chatId, tabId);
    return afterAction(chatId, id, () => sheets.gotoCell(id, range), { settle: false });
  },

  async screencast_start({ chatId, tabId }) {
    const id = await targetTab(chatId, tabId);
    return screencast.start(id, (data) => {
      broadcastToPanels({ type: "frame", data });
    });
  },

  async screencast_stop() {
    return screencast.stop();
  },

  async release({ chatId, tabId }) {
    await ready;
    const ctx = chatCtx(chatId);
    const id = tabId ?? ctx.tabId;
    await screencast.stop();
    if (id !== null && isAttached(id)) await detach(id);
    if (id === ctx.tabId) ctx.tabId = null;
    persistTabs();
    return { released: true };
  },
};

// ── websocket bridge ────────────────────────────────────────────────────────

function socketAlive() {
  return ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN);
}

/** Where to connect now, or null when there is nothing to connect to (hosted, signed out). */
async function socketUrl() {
  if (backend === "local") return LOCAL_URL;
  let token;
  try {
    token = await auth.accessToken({ force: refused > 0 });
  } catch {
    // Could not refresh right now (offline): the saved token may still do;
    // if not, the socket turns it away and we try again.
    token = (await chrome.storage.local.get("auth").catch(() => ({}))).auth?.access ?? null;
  }
  if (!token) {
    signedIn = await auth.account().catch(() => null);
    return null;
  }
  return `${(await cloud()).socketUrl}?token=${encodeURIComponent(token)}`;
}

async function connect() {
  // Several paths ask to reconnect — onclose, the keepalive alarm, and a fresh
  // service worker running this file top to bottom. Without this guard they
  // can open a second socket, and because the broker keeps only the newest
  // client and closes the older one, that older socket's onclose reconnects
  // and supersedes the other, whose onclose reconnects… a permanent
  // connected/disconnected flap.
  if (socketAlive() || connecting) return;
  connecting = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  try {
    await ready;
    const url = await socketUrl();
    if (!url) {
      // Signed out of the hosted broker: nothing to do until sign-in.
      announce(false);
      return;
    }
    if (socketAlive()) return;
    let sock;
    try {
      sock = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = sock;
    wire(sock);
  } finally {
    connecting = false;
  }
}

function wire(sock) {
  let opened = false;

  // Every handler below is bound to `sock` and checks it is still the current
  // socket, so a superseded one cannot clear the live ping timer or trigger
  // reconnects on its way out.
  sock.onopen = () => {
    if (ws !== sock) {
      try { sock.close(); } catch { /* already closing */ }
      return;
    }
    opened = true;
    refused = 0;
    announce(true);
    void (async () => {
      await ready;
      // The chat we already knew about, if any — the broker resumes it (or
      // falls back to the last-viewed chat on a true cold start) and answers
      // with a chat_state.
      send({ type: "hello", client: "extension", version: chrome.runtime.getManifest().version, chatId: session.chatId });
      for (const chatId of pendingCancels) send({ type: "cancel", chatId });
      pendingCancels.clear();
    })();
    clearInterval(pingTimer);
    // MV3 kills idle service workers; steady WebSocket traffic keeps this one
    // alive for the length of a run.
    pingTimer = setInterval(() => send({ type: "ping" }), PING_MS);
  };

  sock.onmessage = async (event) => {
    if (ws !== sock) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    // Agent progress events destined for the panel, not ops for us. Recorded
    // first so a panel that opens later can still see them.
    if (msg.type === "agent_event") {
      recordEvent(msg);
      return;
    }


    // A chat's full status: sent in answer to hello, and after a reset or a
    // successful switch_chat. Replaces the transcript on screen only when the
    // chat actually changed — a reconnect blip that lands back on the same
    // chat just refreshes running/task, leaving the richer live log (with
    // step-by-step actions the broker never persists) alone.
    if (msg.type === "chat_state") {
      const changedChat = session.chatId !== msg.id;
      session.chatId = msg.id;
      session.running = Boolean(msg.running);
      session.task = msg.task ?? null;
      session.approvalMode = msg.approvalMode ?? "submits";
      session.supervisor = msg.supervisor === true;
      if (!session.running) {
        session.approval = null;
        session.ask = null;
      }
      // A gate or questions opened on this chat while it was in the
      // background — surface them now that the chat is the one being viewed.
      if (session.pendingApprovals[msg.id]) session.approval = session.pendingApprovals[msg.id];
      if (session.pendingAsks[msg.id]) session.ask = session.pendingAsks[msg.id];
      runChanged(session.chatId, session.running);
      setBadge(needsAttention());

      if (changedChat) {
        session.events = msg.events ?? [];
        // A chat nothing has been asked in yet starts with "Ask before".
        if (approvalDefault && !session.running && session.events.length === 0 && session.approvalMode !== approvalDefault) {
          session.approvalMode = approvalDefault;
          send({ type: "set_approval_mode", chatId: session.chatId, mode: approvalDefault });
        }
        // And with the supervisor as it was last left.
        if (supervisorDefault !== null && !session.running && session.events.length === 0 && session.supervisor !== supervisorDefault) {
          session.supervisor = supervisorDefault;
          send({ type: "set_supervisor", chatId: session.chatId, on: supervisorDefault });
        }
        persist();
        broadcastToPanels({ ...restoreMessage(), connected: true });
        announceTab();
        // The live view follows whichever chat is now being viewed.
        if (session.watching) {
          const ctx = chatCtx(session.chatId);
          if (ctx.tabId !== null) void OPS.screencast_start({ chatId: session.chatId }).catch(() => {});
        }
      } else {
        persist();
        broadcastToPanels({ type: "run_state", running: session.running, task: session.task });
      }
      return;
    }

    // "Delete my account" is done: everything on the server is gone,
    // including the sign-in, so sign out here too.
    if (msg.type === "account_deleted") {
      disconnect();
      await auth.signOut().catch(() => {});
      signedIn = null;
      await clearSession();
      announce(false);
      broadcastToPanels({ type: "account_deleted" });
      return;
    }

    // The saved-chats list, sent in answer to a "chats" request from the panel.
    if (msg.type === "chats") {
      session.chats = msg.chats ?? [];
      persist();
      broadcastToPanels({ type: "chats", chats: session.chats });
      return;
    }

    // LLM settings: sent in answer to get_config/set_config from the Settings page.
    if (msg.type === "config") {
      broadcastToPanels({ type: "config", config: msg.config });
      return;
    }
    // Saved memories, in answer to listing, adding or deleting one.
    if (msg.type === "memories") {
      broadcastToPanels({ type: "memories", memories: msg.memories, error: msg.error, done: msg.done });
      return;
    }
    // Model list for one provider, sent in answer to a "list_models" request.
    if (msg.type === "models") {
      broadcastToPanels({ type: "models", provider: msg.provider, models: msg.models, error: msg.error });
      return;
    }
    if (msg.type === "pong") return;
    if (!msg.id || !msg.op) return;

    const halt = haltReason(msg.chatId);
    if (halt) {
      sendResult({ id: msg.id, ok: false, error: halt, halt: true });
      return;
    }

    const handler = OPS[msg.op];
    if (!handler) {
      sendResult({ id: msg.id, ok: false, error: `unknown op "${msg.op}"` });
      return;
    }

    try {
      const data = await handler({ ...(msg.params ?? {}), chatId: msg.chatId });
      sendResult({ id: msg.id, ok: true, data });
    } catch (err) {
      // Errors go back as values, not dropped connections — the model reads
      // them as tool results and recovers (e.g. re-snapshots on a stale ref).
      sendResult({ id: msg.id, ok: false, error: String(err?.message ?? err) });
    }
  };

  sock.onclose = () => {
    if (ws !== sock) return; // superseded socket closing; not our problem
    clearInterval(pingTimer);
    pingTimer = null;
    ws = null;
    // The hosted socket refuses a bad token before it ever opens.
    if (!opened && backend === "cloud") refused++;
    announce(false);
    scheduleReconnect();
  };

  sock.onerror = () => {
    // Close `sock`, not `ws` — by now they may be different objects, and
    // closing the live one would cause the very flap this guards against.
    try { sock.close(); } catch { /* already closing */ }
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return; // at most one pending attempt
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, refused >= 3 ? REFUSED_BACKOFF_MS : RECONNECT_MS);
}

/** Close the socket on purpose — switching backend, or signing out — without reconnecting. */
function disconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearInterval(pingTimer);
  pingTimer = null;
  const sock = ws;
  ws = null;
  try { sock?.close(); } catch { /* already closing */ }
}

/** Tell the panels whether the broker is reachable, which one it is, and who is signed in. */
function announce(connected) {
  broadcastToPanels({ type: "connection", connected, backend, account: signedIn });
}

// setTimeout does not survive service-worker termination, so it cannot be the
// only way back. An alarm both wakes a recycled worker and gives the reconnect
// a floor: whatever else happened, we are connected again within ~30s.
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  // connect() is a no-op unless the socket is genuinely gone.
  void connect();
});

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// API Gateway takes WebSocket frames of at most 32 KB, and Chrome sends each
// message as one frame. A bigger op result — a screenshot, a long page —
// goes to the hosted broker as numbered pieces instead. 8000 characters is
// at most 24 KB even at three UTF-8 bytes a character.
const WHOLE_MAX_BYTES = 28000;
const PIECE_CHARS = 8000;
const utf8 = new TextEncoder();

function sendResult(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const text = JSON.stringify(obj);
  if (backend !== "cloud" || utf8.encode(text).length <= WHOLE_MAX_BYTES) {
    ws.send(text);
    return;
  }
  const of = Math.ceil(text.length / PIECE_CHARS);
  for (let seq = 0; seq < of; seq++) {
    const data = text.slice(seq * PIECE_CHARS, (seq + 1) * PIECE_CHARS);
    ws.send(JSON.stringify({ type: "chunk", id: obj.id, seq, of, data }));
  }
}

// ── side panel wiring ────────────────────────────────────────────────────────

function broadcastToPanels(msg) {
  for (const port of panelPorts) {
    try { port.postMessage(msg); } catch { panelPorts.delete(port); }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sidepanel") return;
  panelPorts.add(port);

  // A freshly opened panel starts blank, so hand it the whole session: an
  // in-flight run stays visible, and a gate that opened while it was closed
  // is still answerable instead of expiring into a phantom denial. Unlike a
  // popup, the panel usually stays open across tab switches within a
  // window — this mainly matters right after install, or once the service
  // worker has been recycled out from under an already-open panel.
  void (async () => {
    await ready;
    try {
      port.postMessage(restoreMessage());
    } catch {
      panelPorts.delete(port);
      return;
    }
    announceTab({ force: true });
    // The live view was on when the panel last closed; pick it back up.
    if (session.watching && !screencast.isStreaming() && session.chatId) {
      try {
        await OPS.screencast_start({ chatId: session.chatId });
      } catch {
        session.watching = false;
        persist();
      }
    }
  })();

  port.onDisconnect.addListener(() => {
    panelPorts.delete(port);
    // Nobody is watching, so stop paying for frames. The intent is remembered
    // in session.watching and resumes when a panel comes back.
    if (panelPorts.size === 0) void screencast.stop();
  });
  port.onMessage.addListener(async (msg) => {
    // A worker just woken by this message has not read back which chat is
    // on screen yet; a Stop sent before that would name no chat at all.
    await ready;
    if (msg.type === "set_backend" && (msg.backend === "local" || msg.backend === "cloud")) {
      await switchBackend(msg.backend);
      return;
    }
    // The first-run choice, which may be where it already is.
    if (msg.type === "choose_backend" && (msg.backend === "local" || msg.backend === "cloud")) {
      await ready;
      await setBackend(msg.backend);
      chosen = true;
      if (msg.backend !== backend) await switchBackend(msg.backend);
      else broadcastToPanels(restoreMessage());
      return;
    }
    if (msg.type === "set_approval_default" && ["all", "submits", "none"].includes(msg.mode)) {
      approvalDefault = msg.mode;
      await chrome.storage.local.set({ approvalDefault }).catch(() => {});
      // The chat on screen counts as new until something is asked in it.
      if (session.chatId && !session.running && session.events.length === 0 && session.approvalMode !== approvalDefault) {
        session.approvalMode = approvalDefault;
        persist();
        send({ type: "set_approval_mode", chatId: session.chatId, mode: approvalDefault });
        broadcastToPanels({ type: "approval_mode", mode: approvalDefault });
      }
      return;
    }
    if (msg.type === "sign_in") {
      try {
        signedIn = await auth.signIn();
        refused = 0;
        disconnect();
        announce(false);
        void connect();
      } catch (err) {
        const text = String(err?.message ?? err);
        // Closing the sign-in window is not an error worth a red line.
        broadcastToPanels({
          type: "auth_error",
          text: /did not approve|cancell?ed/i.test(text) ? "Sign-in was closed before it finished." : text,
        });
      }
      return;
    }
    if (msg.type === "suggest") {
      port.postMessage({ type: "suggest_result", ...(await sendSuggestion(msg.text)) });
      return;
    }
    if (msg.type === "sign_out") {
      disconnect();
      await auth.signOut();
      signedIn = null;
      await clearSession();
      announce(false);
      return;
    }
    if (msg.type === "delete_account" && backend === "cloud") send({ type: "delete_account" });
    if (msg.type === "task" && agentOff[session.chatId]) {
      recordEvent({
        type: "agent_event",
        event: "error",
        chatId: session.chatId,
        text: "The agent is switched off in this chat. Switch it on to send it a task.",
      });
      return;
    }
    if (msg.type === "task") {
      // The tab it starts on, so "this page" means something to the agent,
      // and any rules the person set for its supervisor.
      const tab = await viewedTab().catch(() => null);
      send({
        type: "task",
        text: msg.text,
        chatId: session.chatId,
        tab: tab && { url: tab.url, title: tab.title },
        ...(typeof msg.rules === "string" && msg.rules.trim() ? { rules: msg.rules.trim() } : {}),
      });
    }
    if (msg.type === "cancel") stopChat(typeof msg.chatId === "string" ? msg.chatId : session.chatId);
    // The chat's agent switch. Off stops whatever it is doing — a run, or a
    // question or approval it waits on — and refuses its ops until it is on.
    if (msg.type === "set_agent" && typeof msg.chatId === "string") {
      const id = msg.chatId;
      if (msg.on === false) {
        agentOff[id] = true;
        const busy =
          id === session.chatId
            ? session.running || Boolean(session.approval || session.ask)
            : Boolean(session.pendingApprovals[id] || session.pendingAsks[id] || session.chats?.find((c) => c.id === id)?.running);
        if (busy) stopChat(id);
        runChanged(id, false);
      } else {
        delete agentOff[id];
      }
      await chrome.storage.local.set({ agentOff }).catch(() => {});
      broadcastToPanels({ type: "agent_switch", chatId: id, on: msg.on !== false });
    }
    if (msg.type === "reset") send({ type: "reset" });
    if (msg.type === "chats") send({ type: "list_chats" });
    if (msg.type === "list_memories") send({ type: "list_memories" });
    if (msg.type === "add_memory" && typeof msg.text === "string") send({ type: "add_memory", text: msg.text });
    if (msg.type === "delete_memory" && typeof msg.key === "string") send({ type: "delete_memory", key: msg.key });
    if (msg.type === "switch_chat" && msg.id) send({ type: "switch_chat", id: msg.id });
    if (msg.type === "get_config") send({ type: "get_config" });
    if (msg.type === "set_config" && msg.patch) send({ type: "set_config", patch: msg.patch });
    if (msg.type === "list_models" && msg.provider) send({ type: "list_models", provider: msg.provider });
    if (msg.type === "set_approval_mode" && msg.mode) {
      session.approvalMode = msg.mode; // optimistic; the broker is the source of truth
      persist();
      send({ type: "set_approval_mode", chatId: session.chatId, mode: msg.mode });
    }
    if (msg.type === "set_supervisor" && typeof msg.on === "boolean") {
      session.supervisor = msg.on; // optimistic, like the approval mode
      persist();
      send({ type: "set_supervisor", chatId: session.chatId, on: msg.on });
      // New chats start the way it was last left.
      supervisorDefault = msg.on;
      chrome.storage.local.set({ supervisorDefault }).catch(() => {});
    }
    if (msg.type === "approval") {
      send({ type: "approval", id: msg.id, approved: msg.approved });
      session.approval = null;
      if (session.chatId) delete session.pendingApprovals[session.chatId];
      setBadge(needsAttention());
      broadcastApprovalFlags();
      persist();
    }
    if (msg.type === "answers") {
      send({
        type: "answers",
        id: msg.id,
        answers: Array.isArray(msg.answers) ? msg.answers : [],
        dismissed: Boolean(msg.dismissed),
      });
      session.ask = null;
      if (session.chatId) delete session.pendingAsks[session.chatId];
      setBadge(needsAttention());
      broadcastApprovalFlags();
      persist();
    }
    if (msg.type === "control") {
      try {
        if (msg.action === "watch") {
          session.watching = true;
          persist();
          if (session.chatId) await OPS.screencast_start({ chatId: session.chatId });
        }
        if (msg.action === "unwatch") {
          session.watching = false;
          persist();
          await OPS.screencast_stop({});
        }
      } catch (err) {
        broadcastToPanels({
          type: "agent_event", event: "error", chatId: session.chatId,
          text: String(err?.message ?? err),
        });
      }
    }
  });
});

// Anyone updating from 0.1 used the broker on their own computer — it was
// the only kind. Keep them there; only new installs start on the cloud.
chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  if (reason !== "update" || !previousVersion?.startsWith("0.1.")) return;
  void (async () => {
    const { backend: stored } = await chrome.storage.local.get("backend").catch(() => ({}));
    if (stored) return;
    await setBackend("local");
    chosen = true;
    await switchBackend("local");
  })();
});

// ── suggestions ─────────────────────────────────────────────────────────────

/** Emails a suggestion to the CopperOS team, signed with the sign-in when there is one. */
async function sendSuggestion(text) {
  if (typeof text !== "string" || !text.trim()) return { ok: false, error: "Write a suggestion first." };
  try {
    const token = backend === "cloud" ? await auth.accessToken().catch(() => null) : null;
    const res = await fetch((await cloud()).feedbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ text: text.trim(), version: chrome.runtime.getManifest().version, backend }),
    });
    const body = await res.json().catch(() => ({}));
    return res.ok ? { ok: true } : { ok: false, error: body.error || `It didn't go through (${res.status}).` };
  } catch {
    return { ok: false, error: "It didn't go through — check your connection and try again." };
  }
}

/** The panel as a freshly opened one would get it. */
function restoreMessage() {
  return {
    type: "restore",
    connected: Boolean(ws && ws.readyState === WebSocket.OPEN),
    backend,
    account: signedIn,
    chats: session.chats,
    chatId: session.chatId,
    running: session.running,
    task: session.task,
    events: session.events,
    approval: session.approval,
    ask: session.ask,
    watching: session.watching,
    approvalMode: session.approvalMode,
    supervisor: session.supervisor,
    agentOn: !agentOff[session.chatId],
    pendingApprovalChatIds: waitingChatIds(),
    welcome: !chosen,
    approvalDefault,
  };
}

// ── the tab the panel names ─────────────────────────────────────────────────
//
// The panel's header says which tab the viewed chat acts on: the one it is
// driving, or, before it has one, the tab a task would start in.

let lastTab = null;
let tabTimer = null;

async function viewedTab() {
  await ready;
  const id = session.chatId ? chatCtx(session.chatId).tabId : null;
  let tab = id !== null ? await chrome.tabs.get(id).catch(() => null) : null;
  if (!tab) [tab] = (await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => null)) ?? [];
  return tab ? { url: tab.url || tab.pendingUrl || "", title: tab.title ?? "", favIconUrl: tab.favIconUrl ?? "" } : null;
}

/** Tell the panels about the tab, when it changed (or always, for a panel that just opened). */
function announceTab({ force = false } = {}) {
  clearTimeout(tabTimer);
  tabTimer = setTimeout(async () => {
    if (panelPorts.size === 0) return;
    const tab = await viewedTab();
    const json = JSON.stringify(tab);
    if (!force && json === lastTab) return;
    lastTab = json;
    broadcastToPanels({ type: "tab", tab });
  }, 50);
}

chrome.tabs.onActivated.addListener(() => announceTab());
chrome.windows.onFocusChanged.addListener(() => announceTab());
chrome.tabs.onUpdated.addListener((_tabId, change) => {
  if (change.url || change.title || change.favIconUrl) announceTab();
});

function blankSession() {
  return {
    chatId: null, running: false, task: null, approvalMode: "submits", supervisor: false, events: [],
    approval: null, watching: false, pendingApprovals: {}, ask: null, pendingAsks: {}, chats: null,
    stopped: {},
  };
}

/** Forget this backend's panel state — after signing out, it belongs to nobody. */
async function clearSession() {
  session = blankSession();
  await chrome.storage.session.remove(sessionKey()).catch(() => {});
  setBadge(false);
  broadcastToPanels(restoreMessage());
}

/**
 * Move to the other broker. Its chats and panel state are its own: this
 * backend's are put away as they are, and the other's come back.
 */
async function switchBackend(next) {
  await ready;
  if (next === backend) return;
  persist();
  disconnect();
  void screencast.stop();
  backend = next;
  await setBackend(next);
  chosen = true;
  refused = 0;
  signedIn = await auth.account().catch(() => null);
  const { [sessionKey()]: saved } = await chrome.storage.session.get(sessionKey()).catch(() => ({}));
  session = { ...blankSession(), ...(saved ?? {}), watching: false };
  setBadge(needsAttention());
  broadcastToPanels(restoreMessage());
  announceTab();
  announce(false);
  void connect();
}

void connect();
