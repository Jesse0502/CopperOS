// What each attached tab is doing right now — whether its main frame is
// loading, and which requests that matter are in flight — kept current from
// CDP events. nav.js's waitForIdle reads it to tell when a page has settled.
//
// Chrome's own "networkAlmostIdle" lifecycle event cannot do this alone. It
// fires once per document load, so it never comes after a click that only
// fetches data into the page (an Indeed job pane), after a back navigation
// served from the back/forward cache, or for a page that finished loading
// before anyone started listening — and waiting for it then burned the whole
// timeout every time.

// Requests that change what the page shows. Images, fonts, media, beacons
// and sockets do not hold up reading it.
const RELEVANT = new Set(["Document", "Script", "Stylesheet", "XHR", "Fetch"]);

// In flight longer than this is a long poll, a stream, or a stuck request —
// not something the page is about to finish rendering from.
const LONG_LIVED_MS = 5000;

// Nothing legitimately goes this long unanswered; dropping it keeps a missed
// loadingFinished from leaking.
const FORGET_MS = 60_000;

// tabId -> { mainFrameId, loading, requests: Map<requestId, { at, mainDoc }> }
const tabs = new Map();

/** Start tracking a tab that was just attached. It counts as loading until an event says otherwise. */
export function track(tabId, mainFrameId) {
  tabs.set(tabId, { mainFrameId, loading: true, requests: new Map() });
}

export function forget(tabId) {
  tabs.delete(tabId);
}

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  const t = tabs.get(tabId);
  if (!t) return;
  switch (method) {
    case "Page.frameNavigated":
      if (params.frame.parentId) break;
      t.mainFrameId = params.frame.id;
      // The previous document's requests die with it, and not all of them
      // report back that they ended. Keep only the one that brought the new
      // document in — a navigation request's id is its loader id.
      for (const id of t.requests.keys()) {
        if (id !== params.frame.loaderId) t.requests.delete(id);
      }
      break;
    // Started/stopped loading also fire for a back/forward-cache restore,
    // which fires no lifecycle events at all.
    case "Page.frameStartedLoading":
      if (params.frameId === t.mainFrameId) t.loading = true;
      break;
    case "Page.frameStoppedLoading":
      if (params.frameId === t.mainFrameId) t.loading = false;
      break;
    case "Page.lifecycleEvent":
      if (params.frameId !== t.mainFrameId) break;
      if (params.name === "init") t.loading = true;
      else if (params.name === "load") t.loading = false;
      break;
    case "Network.requestWillBeSent":
      // A redirect reuses the request id; keep the original start time.
      if (RELEVANT.has(params.type) && !t.requests.has(params.requestId)) {
        t.requests.set(params.requestId, {
          at: Date.now(),
          mainDoc: params.type === "Document" && params.frameId === t.mainFrameId,
        });
      }
      break;
    case "Network.loadingFinished":
    case "Network.loadingFailed":
      t.requests.delete(params.requestId);
      break;
  }
});

/**
 * What a tab is doing now, or null for a tab not being tracked. `navigating`
 * means the main frame's next document has been requested but has not
 * arrived; `active` counts the other requests that matter, leaving out
 * long-lived ones.
 */
export function activityOf(tabId) {
  const t = tabs.get(tabId);
  if (!t) return null;
  const now = Date.now();
  let active = 0;
  let navigating = false;
  for (const [id, r] of t.requests) {
    const age = now - r.at;
    if (age > FORGET_MS) t.requests.delete(id);
    else if (r.mainDoc) navigating = true;
    else if (age <= LONG_LIVED_MS) active++;
  }
  return { loading: t.loading, navigating, active };
}
