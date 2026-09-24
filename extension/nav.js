// Navigation, readiness detection, and text extraction.

import { activityOf } from "./activity.js";
import { send } from "./cdp.js";
import { isRestrictedUrl } from "./restricted.js";

export { isRestrictedUrl };

// ── readiness ───────────────────────────────────────────────────────────────

// Knowing when a page has settled is the single biggest source of flakiness
// in browser agents. Settled here means: the main frame has finished loading
// and no request that matters (see activity.js) has been in flight for
// QUIET_MS. The quiet stretch also covers the moment between a click and the
// navigation it sets off, and lets the page's own rendering land.
const QUIET_MS = 500;
// Past this, stop holding out for an onload that a slow image or ad is
// holding back, or for a chatty page's last request or two — the same
// tolerance as Puppeteer's networkidle2. A document still on its way is
// always waited for.
const RELAX_AFTER_MS = 3000;
const POLL_MS = 100;

export async function waitForIdle(tabId, { timeoutMs = 10000, quietMs = QUIET_MS } = {}) {
  const started = Date.now();
  let quietSince = null;
  for (;;) {
    const now = Date.now();
    const waited = now - started;
    // A tab attached outside cdp.js is not tracked: all that is left to go on
    // is the quiet stretch itself.
    const a = activityOf(tabId) ?? { loading: false, navigating: false, active: 0 };
    const settled = waited < RELAX_AFTER_MS
      ? !a.loading && !a.navigating && a.active === 0
      : !a.navigating && a.active <= 2;
    if (!settled) quietSince = null;
    else if (quietSince === null) quietSince = now;
    else if (now - quietSince >= quietMs) {
      return { idle: true, timedOut: false, waitedMs: waited };
    }
    if (waited >= timeoutMs) {
      return {
        idle: false,
        timedOut: true,
        waitedMs: waited,
        stillLoading: a.loading || a.navigating,
        requestsInFlight: a.active,
      };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

export async function navigate(tabId, url, { timeoutMs = 15000, skipNavigate = false } = {}) {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`refusing to navigate to non-http(s) URL: ${url}`);
  }
  if (!skipNavigate) {
    // Answered only once the server responds, so it gets longer than the
    // usual command bound.
    const result = await send(tabId, "Page.navigate", { url }, { timeoutMs: 30_000 });
    if (result?.errorText) throw new Error(`navigation failed: ${result.errorText}`);
  }
  const idle = await waitForIdle(tabId, { timeoutMs });
  const tab = await chrome.tabs.get(tabId);
  return { url: tab.url, title: tab.title, ...idle };
}

function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") done();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// A tab freshly opened with no URL, or one sitting on chrome://newtab, a
// settings page, the Web Store, etc., cannot take a CDP attach — that's a
// Chrome restriction, not a bug. The plain tabs API has no such restriction,
// so use it to get off the restricted page and onto real content; CDP
// attaches fine once there, and `navigate` takes over as normal from then on.
export async function escapeRestrictedPage(tabId, url) {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`refusing to navigate to non-http(s) URL: ${url}`);
  }
  await chrome.tabs.update(tabId, { url });
  await waitForTabComplete(tabId);
}

export async function goBack(tabId) {
  const { currentIndex, entries } = await send(tabId, "Page.getNavigationHistory");
  if (currentIndex <= 0) throw new Error("no history entry to go back to");
  await send(tabId, "Page.navigateToHistoryEntry", {
    entryId: entries[currentIndex - 1].id,
  });
  return waitForIdle(tabId);
}

// ── text extraction ─────────────────────────────────────────────────────────

// Built from the accessibility tree rather than DOM innerText, which keeps the
// Runtime domain unused and automatically drops content that is hidden or
// aria-hidden — i.e. it returns what a user can actually perceive.
export async function readPage(tabId, { maxChars = 12000 } = {}) {
  const { nodes } = await send(tabId, "Accessibility.getFullAXTree");
  const out = [];
  let last = "";

  for (const n of nodes) {
    if (n.ignored) continue;
    const role = n.role?.value;
    const text = typeof n.name?.value === "string" ? n.name.value.trim() : "";
    if (!text || text === last) continue;

    if (role === "heading") {
      const level = n.properties?.find((p) => p.name === "level")?.value?.value ?? 2;
      out.push(`\n${"#".repeat(Math.min(Number(level) || 2, 6))} ${text}`);
    } else if (role === "StaticText" || role === "paragraph") {
      out.push(text);
    } else if (role === "link" && text.length > 2) {
      out.push(`[${text}]`);
    }
    last = text;
  }

  const body = out.join("\n");
  return body.length > maxChars
    ? `${body.slice(0, maxChars)}\n\n… truncated at ${maxChars} chars; scroll or refine the task.`
    : body;
}

// ── tabs ────────────────────────────────────────────────────────────────────

export async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({
    tabId: t.id,
    title: t.title,
    url: t.url,
    active: t.active,
  }));
}

// Tabs open in the background on purpose. CDP input and accessibility
// snapshots do not need a tab to be visible, so raising one only serves to
// yank the user out of whatever they were doing. Use the popup's live view to
// watch instead.
export async function openTab(url, { background = true } = {}) {
  const tab = await chrome.tabs.create({ url, active: !background });
  return { tabId: tab.id, url: tab.url };
}

// "Activate" here means "make this the tab the agent drives", which is not the
// same as making it the tab the human is looking at.
export async function activateTab(tabId, { background = true } = {}) {
  const tab = background
    ? await chrome.tabs.get(tabId)
    : await chrome.tabs.update(tabId, { active: true });
  return { tabId: tab.id, url: tab.url, title: tab.title };
}
