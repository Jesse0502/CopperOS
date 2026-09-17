// Each agent's tabs: its own "CopperOS · <id>" group, and closing what it no
// longer uses.
//
// One group per chat. It holds the tab that chat is driving plus the tabs it
// opened along the way — its workspace, gathered in one place in your tab
// strip, visually separate from every other chat's group. An existing group
// for a chat is always reused, and any stray duplicate is merged into it or
// dissolved — but only among that chat's own groups; one chat's cleanup can
// never touch another's.
//
// Ownership is the safety line for closing. Only tabs a chat opened — with
// open_tab, or by clicking something that opened one — can ever be closed.
//  • A tab you opened stays yours even while a chat drives it. When that
//    chat moves on, it leaves the group exactly as it came in, untouched.
//  • A tab of a chat's that you switch to yourself becomes yours. You might
//    be reading it or finishing a form in it; it is no longer the chat's to
//    close.

const NONE = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE

// Chrome's tab-group palette. Picked deterministically per chat id, so two
// chats never look alike and a chat's color is stable across reconnects.
const COLORS = ["purple", "blue", "cyan", "green", "yellow", "orange", "pink", "red", "grey"];

function titleFor(chatId) {
  return `CopperOS · ${chatId.slice(-6)}`;
}

function colorFor(chatId) {
  let hash = 0;
  for (let i = 0; i < chatId.length; i++) hash = (hash * 31 + chatId.charCodeAt(i)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length];
}

function blankState() {
  return {
    groupId: null,
    driving: null,
    groupedFor: null, // tab whose grouping is known done, for the hot path
    owned: {}, // tabId -> last time this chat drove it, ms
    mru: [], // tabs this chat has driven, most recent first
  };
}

// Persisted: a recycled worker must still know which tabs belong to which
// chat, or it could never close them — and, worse, could not tell them from
// yours. Keyed by chatId.
let st = {};
let runningFlags = {}; // chatId -> bool, synchronous so a queued drive sees it
const ready = chrome.storage.session
  .get("workspace")
  .then(({ workspace }) => {
    if (workspace) st = workspace;
  })
  .catch(() => {});
const save = () => chrome.storage.session.set({ workspace: st }).catch(() => {});

function stateFor(chatId) {
  if (!st[chatId]) st[chatId] = blankState();
  return st[chatId];
}

// Every change goes through one queue: grouping, closing and the tab events
// all touch the same tabs, and interleaved they could close a tab mid-adopt or
// re-create a group being taken down. One queue for every chat is enough —
// operations for different chats never race each other in ways that matter,
// and serializing them keeps this module simple.
let chain = Promise.resolve();
const serial = (fn) =>
  (chain = chain.then(async () => {
    await ready;
    await fn();
  }).catch(() => {}));

const ownsNow = (chatId, tabId) => Object.hasOwn(stateFor(chatId).owned, String(tabId));
const isOurs = (g, chatId) => Boolean(g) && g.title === titleFor(chatId);

// ── the one group, per chat ─────────────────────────────────────────────────

async function findGroup(chatId, windowId) {
  const s = stateFor(chatId);
  if (s.groupId !== null) {
    const g = await chrome.tabGroups.get(s.groupId).catch(() => null);
    if (g) return g;
    s.groupId = null;
  }
  // Lost track (worker restart, browser restart): adopt an existing one rather
  // than making another. Prefer the one in the window we are working in.
  const found = await chrome.tabGroups.query({ title: titleFor(chatId) });
  return found.find((g) => g.windowId === windowId) ?? found[0] ?? null;
}

/** Fold every other one of this chat's groups into `keep`, or dissolve it if it cannot be. */
async function dedupe(chatId, keep) {
  const all = await chrome.tabGroups.query({ title: titleFor(chatId) });
  for (const g of all) {
    if (g.id === keep.id) continue;
    const ids = (await chrome.tabs.query({ groupId: g.id })).map((t) => t.id);
    if (!ids.length) continue;
    // A group cannot span windows, and dragging tabs between windows would
    // rearrange your desktop, so a duplicate elsewhere is dissolved instead.
    if (g.windowId === keep.windowId) await chrome.tabs.group({ groupId: keep.id, tabIds: ids });
    else await chrome.tabs.ungroup(ids);
  }
}

async function ensureGrouped(chatId, tabId) {
  const s = stateFor(chatId);
  const tab = await chrome.tabs.get(tabId);
  let g = await findGroup(chatId, tab.windowId);

  if (tab.groupId !== NONE && tab.groupId !== g?.id) {
    const current = await chrome.tabGroups.get(tab.groupId).catch(() => null);
    // One of your own groups, or another chat's: leave the tab where it is.
    if (!isOurs(current, chatId)) return;
    // A stray group for this same chat — the duplicate this module exists to
    // prevent. Use it as the one group; dedupe folds any others into it.
    g = current;
  }

  if (g && g.windowId !== tab.windowId) {
    // This chat is now working in another window. Move the group, not the
    // tabs: dissolve it there and start it here.
    const left = (await chrome.tabs.query({ groupId: g.id })).map((t) => t.id);
    if (left.length) await chrome.tabs.ungroup(left);
    g = null;
  }

  if (!g) {
    const id = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(id, { title: titleFor(chatId), color: colorFor(chatId) });
    g = await chrome.tabGroups.get(id);
  } else if (tab.groupId !== g.id) {
    await chrome.tabs.group({ groupId: g.id, tabIds: [tabId] });
  }

  s.groupId = g.id;
  s.groupedFor = tabId;
  await dedupe(chatId, g);
}

// ── closing ─────────────────────────────────────────────────────────────────

async function closeTabs(chatId, ids) {
  if (!ids.length) return;
  const s = stateFor(chatId);
  for (const id of ids) delete s.owned[String(id)];
  s.mru = s.mru.filter((t) => !ids.includes(t));
  try {
    await chrome.tabs.remove(ids);
  } catch {
    // One already gone fails the batch; close the rest individually.
    for (const id of ids) await chrome.tabs.remove(id).catch(() => {});
  }
}

const MAX_IDLE_OWNED = 5;

async function closeExcessIdle(chatId) {
  const s = stateFor(chatId);
  const idle = Object.entries(s.owned)
    .map(([id, at]) => [Number(id), at])
    .filter(([id]) => id !== s.driving)
    .sort((a, b) => a[1] - b[1]); // least recently used first
  const excess = idle.length - MAX_IDLE_OWNED;
  if (excess > 0) await closeTabs(chatId, idle.slice(0, excess).map(([id]) => id));
}

/** This chat stopped driving `tabId`. */
async function release(chatId, tabId) {
  // One of the chat's own stays in its workspace until closed. One of yours
  // leaves the group the way it came in.
  if (ownsNow(chatId, tabId)) return;
  const s = stateFor(chatId);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && s.groupId !== null && tab.groupId === s.groupId) {
    await chrome.tabs.ungroup(tabId).catch(() => {});
  }
}

async function driveNow(chatId, tabId) {
  const s = stateFor(chatId);
  const prev = s.driving;
  s.driving = tabId;
  s.mru = [tabId, ...s.mru.filter((t) => t !== tabId)].slice(0, 30);
  if (ownsNow(chatId, tabId)) s.owned[String(tabId)] = Date.now();
  if (runningFlags[chatId]) {
    await ensureGrouped(chatId, tabId).catch(() => {});
    if (prev !== null && prev !== tabId) await release(chatId, prev);
    await closeExcessIdle(chatId);
  }
  save();
}

/**
 * A chat's run ended. Tabs it opened and moved on from are done with, so they
 * close. The tab it finished on stays open — that is usually where the result
 * is — and becomes yours. The group comes down: it marks a run in progress.
 */
async function finish(chatId) {
  const s = stateFor(chatId);
  const keep = s.driving;
  await closeTabs(chatId, Object.keys(s.owned).map(Number).filter((id) => id !== keep));
  if (keep !== null) delete s.owned[String(keep)];

  const groups = await chrome.tabGroups.query({ title: titleFor(chatId) }).catch(() => []);
  if (s.groupId !== null && !groups.some((g) => g.id === s.groupId)) {
    // Renamed or recoloured since we made it — still ours.
    const g = await chrome.tabGroups.get(s.groupId).catch(() => null);
    if (g) groups.push(g);
  }
  for (const g of groups) {
    const ids = (await chrome.tabs.query({ groupId: g.id })).map((t) => t.id);
    if (ids.length) await chrome.tabs.ungroup(ids).catch(() => {});
  }
  s.groupId = null;
  s.groupedFor = null;
  save();
}

// ── API ─────────────────────────────────────────────────────────────────────

export function setRunning(chatId, on, tabId) {
  runningFlags[chatId] = on; // synchronously, so drives already queued see it
  return serial(async () => {
    if (!on) return finish(chatId);
    if (tabId !== null && tabId !== undefined) await driveNow(chatId, tabId);
  });
}

/** The chat is now driving `tabId`. Every op calls this, so it is cheap when nothing changed. */
export function drive(chatId, tabId) {
  if (tabId === null || tabId === undefined) return chain;
  const s = stateFor(chatId);
  if (tabId === s.driving && (!runningFlags[chatId] || s.groupedFor === tabId)) return chain;
  return serial(() => driveNow(chatId, tabId));
}

/** The chat opened `tabId`, making it one it may close. */
export function adopt(chatId, tabId) {
  return serial(() => {
    stateFor(chatId).owned[String(tabId)] = Date.now();
    save();
  });
}

export async function owns(chatId, tabId) {
  await chain;
  return ownsNow(chatId, tabId);
}

export async function ownedIds(chatId) {
  await chain;
  return new Set(Object.keys(stateFor(chatId).owned).map(Number));
}

export function close(chatId, tabId) {
  return serial(async () => {
    if (!ownsNow(chatId, tabId)) return; // re-checked in the queue: you may have just taken it
    await closeTabs(chatId, [tabId]);
    const s = stateFor(chatId);
    if (s.driving === tabId) s.driving = null;
    save();
  });
}

/** The most recently driven tab of this chat's that is still open, other than `excludeId`. */
export async function previous(chatId, excludeId) {
  await chain;
  for (const id of stateFor(chatId).mru) {
    if (id === excludeId) continue;
    if (await chrome.tabs.get(id).catch(() => null)) return id;
  }
  return null;
}

/** Which chat (if any) currently owns/drives `tabId` — used to avoid two chats claiming one tab. */
export async function ownerOf(tabId) {
  await chain;
  for (const [chatId, s] of Object.entries(st)) {
    if (s.driving === tabId || Object.hasOwn(s.owned, String(tabId))) return chatId;
  }
  return null;
}

// ── tab events ──────────────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(({ tabId }) => {
  // A chat's agent works in background tabs and never activates one, so this
  // is you. Switching to the tab it is driving is watching, and changes
  // nothing. Switching to one it opened and left is taking it over.
  void serial(() => {
    for (const [chatId, s] of Object.entries(st)) {
      if (tabId === s.driving || !ownsNow(chatId, tabId)) continue;
      delete s.owned[String(tabId)];
    }
    save();
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void serial(() => {
    for (const s of Object.values(st)) {
      delete s.owned[String(tabId)];
      s.mru = s.mru.filter((t) => t !== tabId);
      if (s.driving === tabId) s.driving = null;
      if (s.groupedFor === tabId) s.groupedFor = null;
    }
    save();
  });
});
