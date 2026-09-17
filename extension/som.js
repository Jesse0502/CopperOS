// Set-of-Mark screenshots.
//
// Badges are composited onto the captured bitmap inside the extension rather
// than injected into the page. That avoids mutating the page DOM, avoids the
// layout shift an injected overlay would cause (which can move the very
// element we are about to click), and costs one canvas pass instead of a
// round trip per badge.
//
// Badge numbers are the same [eN] refs as the accessibility snapshot, so the
// model uses one vocabulary across both channels.

import { send } from "./cdp.js";
import { boxForRef } from "./input.js";

const MAX_BADGES = 80;

function b64ToBlob(b64, type) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type });
}

async function blobToB64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export async function screenshot(tabId, { quality = 70 } = {}) {
  const { data } = await send(tabId, "Page.captureScreenshot", {
    format: "jpeg", quality,
  });
  return data;
}

export async function badgedScreenshot(tabId, interactiveRefs, { quality = 70 } = {}) {
  const { data } = await send(tabId, "Page.captureScreenshot", {
    format: "jpeg", quality,
  });
  const bmp = await createImageBitmap(b64ToBlob(data, "image/jpeg"));

  // The capture is in device pixels; box models are in CSS pixels. Derive the
  // ratio rather than assuming devicePixelRatio, which is wrong under zoom.
  const metrics = await send(tabId, "Page.getLayoutMetrics");
  const vp = metrics.cssLayoutViewport ?? metrics.layoutViewport;
  const scale = vp?.clientWidth ? bmp.width / vp.clientWidth : 1;
  const vw = vp?.clientWidth ?? bmp.width;
  const vh = vp?.clientHeight ?? bmp.height;

  const boxes = [];
  for (const { ref } of interactiveRefs.slice(0, MAX_BADGES * 3)) {
    if (boxes.length >= MAX_BADGES) break;
    try {
      const b = await boxForRef(tabId, ref);
      // Only badge what is actually on screen right now.
      if (b.x2 < 0 || b.y2 < 0 || b.x1 > vw || b.y1 > vh) continue;
      boxes.push({ ref, ...b });
    } catch {
      // Hidden or detached between snapshot and capture — skip it.
    }
  }

  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const g = canvas.getContext("2d");
  g.drawImage(bmp, 0, 0);
  g.font = `bold ${Math.round(13 * scale)}px sans-serif`;
  g.textBaseline = "top";

  for (const b of boxes) {
    const x = b.x1 * scale;
    const y = b.y1 * scale;
    const w = (b.x2 - b.x1) * scale;
    const h = (b.y2 - b.y1) * scale;

    g.strokeStyle = "#ff2d55";
    g.lineWidth = Math.max(1.5, 2 * scale);
    g.strokeRect(x, y, w, h);

    const label = b.ref.slice(1); // "e42" -> "42"
    const pad = 4 * scale;
    const tw = g.measureText(label).width + pad * 2;
    const th = 16 * scale;
    // Keep the badge on-screen for elements flush against the top edge.
    const by = y - th < 0 ? y : y - th;

    g.fillStyle = "#ff2d55";
    g.fillRect(x, by, tw, th);
    g.fillStyle = "#ffffff";
    g.fillText(label, x + pad, by + 1.5 * scale);
  }

  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: quality / 100 });
  return { data: await blobToB64(out), badged: boxes.length };
}
