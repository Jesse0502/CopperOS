// Live view (Phase 4).
//
// These frames go to the popup UI only — they are never added to the model's
// message history. That separation is the whole point: the human gets a live
// picture of what the agent is doing, at zero token cost, while the model
// keeps perceiving through the much cheaper accessibility snapshot.

import { send } from "./cdp.js";

let active = null; // { tabId, onFrame }

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (method !== "Page.screencastFrame") return;
  if (!active || source.tabId !== active.tabId) return;

  // Ack first; Chrome stops emitting frames until the previous one is acked.
  try {
    await send(active.tabId, "Page.screencastFrameAck", {
      sessionId: params.sessionId,
    });
  } catch {
    // Tab went away mid-stream.
  }
  active.onFrame(params.data);
});

export async function start(tabId, onFrame, { maxWidth = 800, everyNthFrame = 2 } = {}) {
  await stop();
  active = { tabId, onFrame };
  await send(tabId, "Page.startScreencast", {
    format: "jpeg",
    quality: 55,
    maxWidth,
    everyNthFrame,
  });
  return { streaming: true, tabId };
}

export async function stop() {
  if (!active) return { streaming: false };
  const { tabId } = active;
  active = null;
  try {
    await send(tabId, "Page.stopScreencast");
  } catch {
    // Already detached.
  }
  return { streaming: false };
}

export function isStreaming(tabId) {
  return Boolean(active) && (tabId === undefined || active.tabId === tabId);
}
