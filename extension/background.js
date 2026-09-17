// Service worker: WebSocket bridge to the broker + op router.
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
import { snapshot } from "./snapshot.js";
import * as input from "./input.js";
import * as nav from "./nav.js";
import * as som from "./som.js";
import * as screencast from "./screencast.js";
import * as presence from "./presence.js";
import * as workspace from "./workspace.js";

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
}
function runChanged(chatId, on) {
  if (!chatId) return;
  presence.setActive(chatId, on, chatCtx(chatId).tabId);
  void workspace.setRunning(chatId, on, chatCtx(chatId).tabId);
}

const BROKER_URL = "ws://127.0.0.1:7331";
const RECONNECT_MS = 2000;
const PING_MS = 20000;
const KEEPALIVE_ALARM = "broker-keepalive";
const MAX_EVENTS = 80;
const TERMINAL = ["done", "error", "cancelled"];

let ws = null;
let pingTimer = null;
let reconnectTimer = null;
const panelPorts = new Set();

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
  events: [],
  approval: null, // { id, text } while a gate is open on the viewed chat
  watching: false, // live-view toggle, restored with the panel
  // chatId -> { id, text }, for every chat with an open gate, not just the
  // viewed one — this is what lights up the history icon and its rows.
  pendingApprovals: {},
};

const ready = (async () => {
  try {
    const { session: saved, tabsByChat: savedTabs } =
      await chrome.storage.session.get(["session", "tabsByChat"]);
    if (saved) session = { ...session, ...saved, pendingApprovals: saved.pendingApprovals ?? {} };
    if (savedTabs) tabsByChat = savedTabs;
    setBadge(Object.keys(session.pendingApprovals).length > 0);
    // A recycled worker mid-run: keep marking the tab. The broker's chat_state
    // on reconnect corrects this if the run ended while we were down.
    if (session.running) runChanged(session.chatId, true);
  } catch {
    // First run in this browser session; defaults are already correct.
  }
})();

function persist() {
  chrome.storage.session.set({ session }).catch(() => {});
}

// Visible while any chat has an open gate, so an approval waiting behind a
// closed panel — or behind a different chat than the one being viewed — is
// discoverable without the user having to guess.
function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? "!" : "" });
  if (on) chrome.action.setBadgeBackgroundColor({ color: "#c2410c" });
}

function broadcastApprovalFlags() {
  broadcastToPanels({ type: "approval_flags", chatIds: Object.keys(session.pendingApprovals) });
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

  if (msg.event === "start" && forViewed) {
    session.running = true;
    session.task = msg.text ?? null;
    runChanged(session.chatId, true);
    // The log is not cleared here: the chat is continuous across tasks, so a
    // new turn appends. MAX_EVENTS keeps it bounded.
  }

  if (TERMINAL.includes(msg.event)) {
    if (chatId !== null && session.pendingApprovals[chatId]) {
      delete session.pendingApprovals[chatId];
      broadcastApprovalFlags();
    }
    if (forViewed) {
      session.running = false;
      session.approval = null;
      runChanged(session.chatId, false);
    }
    setBadge(Object.keys(session.pendingApprovals).length > 0);
  }

  if (!forViewed) {
    persist();
    return; // bookkeeping only — never mixes another chat's events into this transcript
  }

  session.events.push({ event: msg.event, text: msg.text ?? "" });
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
async function targetTab(chatId, explicit) {
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
  await attach(ctx.tabId);
  persistTabs();
  driving(chatId, ctx.tabId);
  return ctx.tabId;
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
const NEW_TAB_WAIT_MS = 1500;
let openedTabs = []; // { tabId, openerTabId, at }

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
  openedTabs = openedTabs.filter((t) => now - t.at < NEW_TAB_WAIT_MS * 2);
  openedTabs.push({ tabId: tab.id, openerTabId: tab.openerTabId, at: now });
});

async function claimOpenedTab(openerId) {
  const deadline = Date.now() + NEW_TAB_WAIT_MS;
  while (Date.now() < deadline) {
    const idx = openedTabs.findIndex((t) => t.openerTabId === openerId);
    if (idx !== -1) return openedTabs.splice(idx, 1)[0].tabId;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** Run an input op on `openerId`, then take over any tab that op opened. */
async function actThenFollow(chatId, openerId, act) {
  // Captured before the action, because the action is what disturbs it.
  const before = await focusSnapshot();
  const result = await act();
  const opened = await claimOpenedTab(openerId);
  if (opened === null) return result;

  await keepInBackground(opened, before);

  const ctx = chatCtx(chatId);
  ctx.tabId = opened;
  await attach(ctx.tabId);
  persistTabs();
  // This chat opened it, so it is one this chat may close when done with it.
  void workspace.adopt(chatId, opened);
  driving(chatId, ctx.tabId); // the highlight and the group move with the agent
  try {
    await nav.waitForIdle(ctx.tabId, { timeoutMs: 15000 });
  } catch {
    // Still loading is fine — the model snapshots next and can wait again.
  }
  let info = {};
  try {
    const t = await chrome.tabs.get(ctx.tabId);
    info = { url: t.url, title: t.title };
  } catch {
    // Opened and closed again already.
  }
  return { ...result, followedNewTab: { tabId: ctx.tabId, ...info } };
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
    return r;
  },

  async activate_tab({ chatId, tabId }) {
    await ready;
    const r = await nav.activateTab(tabId);
    const ctx = chatCtx(chatId);
    ctx.tabId = tabId;
    await attach(ctx.tabId);
    persistTabs();
    driving(chatId, ctx.tabId);
    return r;
  },

  async navigate({ chatId, url, tabId }) {
    const id = await targetTab(chatId, tabId);
    return nav.navigate(id, url);
  },

  async go_back({ chatId, tabId }) {
    return nav.goBack(await targetTab(chatId, tabId));
  },

  async wait_for_idle({ chatId, tabId, timeoutMs }) {
    return nav.waitForIdle(await targetTab(chatId, tabId), { timeoutMs });
  },

  async snapshot({ chatId, tabId }) {
    const id = await targetTab(chatId, tabId);
    const snap = await snapshot(id);
    chatCtx(chatId).lastSnapshot = snap;
    return {
      text: snap.text,
      weak: snap.weak,
      interactiveCount: snap.interactiveRefs.length,
      generation: snap.generation,
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
    return actThenFollow(chatId, id, () => input.click(id, ref, { button, clickCount }));
  },

  async hover({ chatId, ref, tabId }) {
    return input.hover(await targetTab(chatId, tabId), ref);
  },

  async type({ chatId, ref, text, submit, clear, tabId }) {
    const id = await targetTab(chatId, tabId);
    // Submitting a search can open results in a new tab just like a click can.
    return actThenFollow(chatId, id, () => input.typeText(id, ref, text, { submit, clear }));
  },

  async paste({ chatId, ref, text, submit, clear, tabId }) {
    const id = await targetTab(chatId, tabId);
    // Same new-tab following as type: submitting a pasted value can open one.
    return actThenFollow(chatId, id, () => input.pasteText(id, ref, text, { submit, clear }));
  },

  async select_option({ chatId, ref, value, tabId }) {
    return input.selectOption(await targetTab(chatId, tabId), ref, value);
  },

  async press_key({ chatId, key, tabId }) {
    const id = await targetTab(chatId, tabId);
    return actThenFollow(chatId, id, () => input.pressKey(id, key));
  },

  async scroll({ chatId, direction, amount, tabId }) {
    return input.scroll(await targetTab(chatId, tabId), { direction, amount });
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

function connect() {
  // Several paths ask to reconnect — onclose, the keepalive alarm, and a fresh
  // service worker running this file top to bottom. Without this guard they
  // can open a second socket, and because the broker keeps only the newest
  // client and closes the older one, that older socket's onclose reconnects
  // and supersedes the other, whose onclose reconnects… a permanent
  // connected/disconnected flap.
  if (socketAlive()) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  let sock;
  try {
    sock = new WebSocket(BROKER_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  ws = sock;

  // Every handler below is bound to `sock` and checks it is still the current
  // socket, so a superseded one cannot clear the live ping timer or trigger
  // reconnects on its way out.
  sock.onopen = () => {
    if (ws !== sock) {
      try { sock.close(); } catch { /* already closing */ }
      return;
    }
    broadcastToPanels({ type: "connection", connected: true });
    void (async () => {
      await ready;
      // The chat we already knew about, if any — the broker resumes it (or
      // falls back to the last-viewed chat on a true cold start) and answers
      // with a chat_state.
      send({ type: "hello", client: "extension", version: "0.1.0", chatId: session.chatId });
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
      if (!session.running) session.approval = null;
      // A gate opened on this chat while it was in the background — surface
      // it now that the chat is the one being viewed.
      if (session.pendingApprovals[msg.id]) session.approval = session.pendingApprovals[msg.id];
      runChanged(session.chatId, session.running);
      setBadge(Object.keys(session.pendingApprovals).length > 0);

      if (changedChat) {
        session.events = msg.events ?? [];
        persist();
        broadcastToPanels({
          type: "restore",
          connected: true,
          chatId: session.chatId,
          running: session.running,
          task: session.task,
          events: session.events,
          approval: session.approval,
          watching: session.watching,
          approvalMode: session.approvalMode,
          pendingApprovalChatIds: Object.keys(session.pendingApprovals),
        });
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

    // The saved-chats list, sent in answer to a "chats" request from the panel.
    if (msg.type === "chats") {
      broadcastToPanels({ type: "chats", chats: msg.chats ?? [] });
      return;
    }

    // LLM settings: sent in answer to get_config/set_config from the Settings page.
    if (msg.type === "config") {
      broadcastToPanels({ type: "config", config: msg.config });
      return;
    }
    // Model list for one provider, sent in answer to a "list_models" request.
    if (msg.type === "models") {
      broadcastToPanels({ type: "models", provider: msg.provider, models: msg.models, error: msg.error });
      return;
    }
    if (msg.type === "pong") return;
    if (!msg.id || !msg.op) return;

    const handler = OPS[msg.op];
    if (!handler) {
      send({ id: msg.id, ok: false, error: `unknown op "${msg.op}"` });
      return;
    }

    try {
      const data = await handler({ ...(msg.params ?? {}), chatId: msg.chatId });
      send({ id: msg.id, ok: true, data });
    } catch (err) {
      // Errors go back as values, not dropped connections — the model reads
      // them as tool results and recovers (e.g. re-snapshots on a stale ref).
      send({ id: msg.id, ok: false, error: String(err?.message ?? err) });
    }
  };

  sock.onclose = () => {
    if (ws !== sock) return; // superseded socket closing; not our problem
    clearInterval(pingTimer);
    pingTimer = null;
    broadcastToPanels({ type: "connection", connected: false });
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
    connect();
  }, RECONNECT_MS);
}

// setTimeout does not survive service-worker termination, so it cannot be the
// only way back. An alarm both wakes a recycled worker and gives the reconnect
// a floor: whatever else happened, we are connected again within ~30s.
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  // connect() is a no-op unless the socket is genuinely gone.
  connect();
});

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
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
      port.postMessage({
        type: "restore",
        connected: Boolean(ws && ws.readyState === WebSocket.OPEN),
        chatId: session.chatId,
        running: session.running,
        task: session.task,
        events: session.events,
        approval: session.approval,
        watching: session.watching,
        approvalMode: session.approvalMode,
        pendingApprovalChatIds: Object.keys(session.pendingApprovals),
      });
    } catch {
      panelPorts.delete(port);
      return;
    }
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
    if (msg.type === "task") send({ type: "task", text: msg.text, chatId: session.chatId });
    if (msg.type === "cancel") send({ type: "cancel", chatId: session.chatId });
    if (msg.type === "reset") send({ type: "reset" });
    if (msg.type === "chats") send({ type: "list_chats" });
    if (msg.type === "switch_chat" && msg.id) send({ type: "switch_chat", id: msg.id });
    if (msg.type === "get_config") send({ type: "get_config" });
    if (msg.type === "set_config" && msg.patch) send({ type: "set_config", patch: msg.patch });
    if (msg.type === "list_models" && msg.provider) send({ type: "list_models", provider: msg.provider });
    if (msg.type === "set_approval_mode" && msg.mode) {
      session.approvalMode = msg.mode; // optimistic; the broker is the source of truth
      persist();
      send({ type: "set_approval_mode", chatId: session.chatId, mode: msg.mode });
    }
    if (msg.type === "approval") {
      send({ type: "approval", id: msg.id, approved: msg.approved });
      session.approval = null;
      if (session.chatId) delete session.pendingApprovals[session.chatId];
      setBadge(Object.keys(session.pendingApprovals).length > 0);
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

connect();
