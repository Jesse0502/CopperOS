// A mold handed over by the website's library: what the worker accepts from the page, and how long
// one waits for a panel to take it. Nothing here runs a task: the panel only fills its message box.

export const SITE_ORIGIN = "https://copper.jassydev.com";
export const BRIDGE_FILE = "website-bridge.js";

const TEXT_MAX = 12000;
export const WAIT_MS = 10 * 60 * 1000;
const MODES = new Set(["all", "submits", "none"]);

/** The mold in a message from the website's script, or null if it is not from the site's top page or is malformed. */
export function acceptMold(msg, sender, extensionId, now = Date.now()) {
  if (msg?.type !== "open_mold" || sender?.id !== extensionId || sender.frameId !== 0) return null;
  if (typeof sender.tab?.windowId !== "number") return null;
  let origin = sender.origin;
  if (!origin && sender.url) {
    try {
      origin = new URL(sender.url).origin;
    } catch {
      // Not a URL: refused below.
    }
  }
  if (origin !== SITE_ORIGIN) return null;
  // A mold cut short is worse than none, so a long one is refused, not trimmed.
  if (typeof msg.text !== "string" || !msg.text.trim() || msg.text.length > TEXT_MAX) return null;
  return {
    text: msg.text.trim(),
    approvals: MODES.has(msg.approvals) ? msg.approvals : null,
    windowId: sender.tab.windowId,
    at: now,
  };
}

/** Whether a mold that has been waiting is still worth showing. */
export function stillWaiting(mold, now = Date.now()) {
  return Boolean(mold) && typeof mold.at === "number" && now - mold.at < WAIT_MS;
}

/** Website pages already open when the extension arrives or updates, given the script so their button works without a reload. */
export async function reachOpenPages() {
  const tabs = await chrome.tabs.query({ url: `${SITE_ORIGIN}/*` }).catch(() => []);
  for (const tab of tabs) {
    if (typeof tab.id !== "number") continue;
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [BRIDGE_FILE] }).catch(() => {});
  }
}
