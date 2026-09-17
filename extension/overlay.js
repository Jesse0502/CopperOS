// Agent presence overlay.
//
// Injected into the controlled tab only while a run is in progress, so you can
// see at a glance which tab CopperOS is driving and where it is pointing: a glowing
// monochrome frame, a status pill, and a cursor that follows the agent's pointer.
//
// Built to stay out of the way of both the page and the agent:
//  • isolated world + closed shadow root — page scripts cannot reach inside it,
//    and page CSS cannot restyle it
//  • aria-hidden — it never appears in the accessibility tree the model reads
//  • pointer-events: none — it cannot intercept a click, the agent's or yours
//  • hidden by the worker for the instant a screenshot is taken, so the model
//    never mistakes the frame or the cursor for part of the page
//
// The host element itself is still visible in the page's DOM. Drawing
// anything inside a page has that cost; presence.js can turn this layer off
// while keeping the tab group, which the page cannot see at all.

(() => {
  if (globalThis.__tactPresence) return; // already in this document
  globalThis.__tactPresence = true;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }

    .stage { position: fixed; inset: 0; animation: appear .35s ease-out both; transition: opacity .25s ease; }
    .stage.leaving { opacity: 0; }

    /* Inner glow: the soft light the frame throws onto the page. */
    .glow {
      position: fixed; inset: 0;
      box-shadow:
        inset 0 0 0 1.5px rgba(255, 237, 227, .6),
        inset 0 0 22px 2px rgba(217, 119, 87, .45),
        inset 0 0 72px 10px rgba(140, 70, 48, .16);
      animation: breathe 3.2s ease-in-out infinite;
    }

    /* The reflective edge: a conic gradient with bright highlights, rotating
       behind a mask that leaves only a thin ring visible, so a sheen of light
       travels round the border. Transform animation, so it stays on the GPU. */
    .ring {
      position: fixed; inset: 0; padding: 3px; overflow: hidden;
      mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      mask-composite: exclude;
    }
    .sheen {
      position: absolute; left: 50%; top: 50%;
      width: 300vmax; height: 300vmax; margin: -150vmax 0 0 -150vmax;
      background: conic-gradient(
        #6b3b29 0deg, #b8623f 50deg, #eab7a3 95deg, #fff3ec 115deg, #eab7a3 135deg,
        #b8623f 180deg, #6b3b29 230deg, #d97757 285deg, #f6ddd2 305deg, #d97757 325deg,
        #6b3b29 360deg);
      animation: spin 6s linear infinite;
      will-change: transform;
    }

    .pill {
      position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
      display: flex; align-items: center; gap: 7px;
      padding: 5px 12px 5px 9px; border-radius: 999px;
      background: rgba(21, 18, 16, .86);
      border: 1px solid rgba(217, 119, 87, .5);
      box-shadow: 0 6px 20px rgba(0, 0, 0, .4), inset 0 1px 0 rgba(255, 255, 255, .08);
      backdrop-filter: blur(10px) saturate(1.1);
      color: #fbeee7;
      font: 600 11.5px/1.2 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      letter-spacing: .03em; white-space: nowrap; text-transform: uppercase;
    }
    .dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: #d97757; box-shadow: 0 0 8px rgba(217, 119, 87, .7);
      animation: pulse 1.6s ease-in-out infinite;
    }

    .ptr {
      position: fixed; left: 0; top: 0;
      transform: translate(var(--x, 0px), var(--y, 0px));
      will-change: transform;
      filter: drop-shadow(0 2px 4px rgba(60, 30, 20, .45));
    }
    .ptr[hidden] { display: none; }
    /* The arrow's tip sits at (2, 1.5) in its viewBox; pull it onto the point. */
    .ptr svg { display: block; width: 22px; height: 22px; margin: -1.5px 0 0 -2px; overflow: visible; }
    .tag {
      position: absolute; left: 15px; top: 18px;
      padding: 2px 7px; border-radius: 6px;
      background: linear-gradient(135deg, #d97757, #a85639);
      border: 1px solid rgba(255, 255, 255, .35);
      color: #fff; font: 700 10.5px/1.3 ui-sans-serif, system-ui, -apple-system, sans-serif;
      letter-spacing: .02em; white-space: nowrap;
    }

    /* Click feedback: a solid tap dot under the cursor tip and a ring that
       expands from it. Strong enough to read against a white form, where a
       faint ring vanishes almost immediately. The base transform keeps both on
       the point even when reduced motion switches the animation off. */
    .ripple, .tap {
      position: fixed; left: 0; top: 0; border-radius: 50%;
      transform: translate(var(--x), var(--y));
    }
    .ripple {
      width: 44px; height: 44px; margin: -22px 0 0 -22px;
      border: 2.5px solid #d97757;
      box-shadow: 0 0 12px rgba(217, 119, 87, .55), inset 0 0 10px rgba(234, 183, 163, .35);
      animation: ripple .7s cubic-bezier(.2, .7, .3, 1) forwards;
    }
    .tap {
      width: 14px; height: 14px; margin: -7px 0 0 -7px;
      background: #a85639;
      box-shadow: 0 0 0 3px rgba(255, 255, 255, .92), 0 0 14px rgba(217, 119, 87, .8);
      animation: tap .7s ease-out forwards;
    }

    @keyframes appear  { from { opacity: 0; } }
    @keyframes spin    { to { transform: rotate(1turn); } }
    @keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
    @keyframes pulse   { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(.6); opacity: .5; } }
    @keyframes ripple {
      0%   { transform: translate(var(--x), var(--y)) scale(.3); opacity: 1; }
      60%  { opacity: .75; }
      100% { transform: translate(var(--x), var(--y)) scale(1.6); opacity: 0; }
    }
    @keyframes tap {
      0%   { transform: translate(var(--x), var(--y)) scale(.4); opacity: 1; }
      30%  { transform: translate(var(--x), var(--y)) scale(1.1); opacity: 1; }
      100% { transform: translate(var(--x), var(--y)) scale(.9); opacity: 0; }
    }

    @media (prefers-reduced-motion: reduce) {
      .stage, .sheen, .glow, .dot, .ripple, .tap { animation: none; }
    }
  `;

  // Built with createElement rather than innerHTML: pages that enforce
  // Trusted Types reject innerHTML, and would leave the overlay half-drawn.
  const SVG = "http://www.w3.org/2000/svg";
  const el = (tag, cls, parent) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  };
  const svg = (tag, attrs, parent) => {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  };

  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  // Inline !important outranks anything the page's stylesheets say about divs.
  const pin = {
    position: "fixed", inset: "0", width: "auto", height: "auto",
    margin: "0", padding: "0", border: "0", background: "transparent",
    "pointer-events": "none", "z-index": "2147483647",
    display: "block", overflow: "visible", opacity: "1", transform: "none",
    "max-width": "none", "max-height": "none", "min-width": "0", "min-height": "0",
  };
  for (const [k, v] of Object.entries(pin)) host.style.setProperty(k, v, "important");

  // A manual popover renders in the top layer, which is the only way to draw
  // above a modal <dialog> — and application forms love modal dialogs.
  const topLayer = typeof host.showPopover === "function";
  if (topLayer) host.setAttribute("popover", "manual");

  const root = host.attachShadow({ mode: "closed" });
  el("style", null, root).textContent = CSS;
  const stage = el("div", "stage", root);
  el("div", "glow", stage);
  el("div", "sheen", el("div", "ring", stage));

  const pill = el("div", "pill", stage);
  el("span", "dot", pill);
  el("span", null, pill).textContent = "CopperOS is working";

  const ptr = el("div", "ptr", stage);
  ptr.hidden = true; // until the agent's pointer has a real position
  const arrow = svg("svg", { viewBox: "0 0 22 22" }, ptr);
  const grad = svg("linearGradient", { id: "tact-ptr", x1: "0", y1: "0", x2: "1", y2: "1" },
    svg("defs", {}, arrow));
  svg("stop", { offset: "0", "stop-color": "#eab7a3" }, grad);
  svg("stop", { offset: "1", "stop-color": "#8a4a30" }, grad);
  svg("path", {
    d: "M2 1.5 L2 18 L6.6 13.9 L9.6 20.6 L12.6 19.3 L9.7 12.8 L15.8 12.8 Z",
    fill: "url(#tact-ptr)", stroke: "#fff", "stroke-width": "1.6", "stroke-linejoin": "round",
  }, arrow);
  el("span", "tag", ptr).textContent = "CopperOS";

  // ── top layer ─────────────────────────────────────────────────────────────

  // Top-layer order is last-shown-on-top, so a dialog the page opens after us
  // covers the frame. Re-showing brings it back above — but only when a new
  // dialog has appeared, because re-showing restarts the animations.
  let lastOpen = new Set();
  function raise() {
    if (!topLayer || !host.isConnected) return;
    let fresh = false;
    try {
      const open = new Set(
        [...document.querySelectorAll(":modal, :popover-open")].filter((n) => n !== host),
      );
      fresh = [...open].some((n) => !lastOpen.has(n));
      lastOpen = open;
    } catch {
      // Selector unsupported; stacking above dialogs just is not available.
    }
    try {
      if (!host.matches(":popover-open")) host.showPopover();
      else if (fresh) {
        host.hidePopover();
        host.showPopover();
      }
    } catch {
      // Detached mid-call, or popovers disallowed here. The z-index still holds.
    }
  }

  // ── pointer ───────────────────────────────────────────────────────────────

  let raf = 0;
  let token = 0;

  function place(x, y) {
    ptr.hidden = false;
    ptr.style.setProperty("--x", `${x}px`);
    ptr.style.setProperty("--y", `${y}px`);
  }

  // Replays the exact path the worker is about to dispatch, on the same delays.
  // One message per move instead of one per step.
  function glide(points, delays) {
    if (!Array.isArray(points) || points.length === 0) return;
    const mine = ++token;
    cancelAnimationFrame(raf);
    const due = [];
    let acc = 0;
    for (const d of delays ?? []) due.push((acc += d));
    const t0 = performance.now();
    let i = 0;
    const step = (now) => {
      if (mine !== token) return;
      const t = now - t0;
      while (i < points.length - 1 && (due[i] ?? 0) <= t) i++;
      place(points[i].x, points[i].y);
      if (i < points.length - 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  function ripple(x, y) {
    token++; // a press lands where it lands; stop any glide still catching up
    place(x, y);
    for (const cls of ["ripple", "tap"]) {
      const n = document.createElement("div");
      n.className = cls;
      n.style.setProperty("--x", `${x}px`);
      n.style.setProperty("--y", `${y}px`);
      stage.insertBefore(n, ptr); // beneath the cursor, so the tip stays visible
      n.addEventListener("animationend", () => n.remove(), { once: true });
      setTimeout(() => n.remove(), 1000); // hidden tabs never fire animationend
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  // Some pages sweep foreign nodes out of <html>. Put the host back — but not
  // endlessly, or a page that keeps removing it would ping-pong with us and
  // lock up its own main thread.
  let reattached = 0;
  let windowStart = Date.now();
  const keep = new MutationObserver(() => {
    if (host.isConnected) return;
    if (Date.now() - windowStart > 1000) {
      windowStart = Date.now();
      reattached = 0;
    }
    if (++reattached > 5) {
      keep.disconnect();
      return;
    }
    document.documentElement.appendChild(host);
    raise();
  });

  function teardown() {
    token++;
    cancelAnimationFrame(raf);
    keep.disconnect();
    chrome.runtime.onMessage.removeListener(onMessage);
    // Allows a later injection into this same document to draw again.
    globalThis.__tactPresence = false;
    stage.classList.add("leaving");
    setTimeout(() => {
      try {
        if (topLayer && host.matches(":popover-open")) host.hidePopover();
      } catch {
        // Already gone.
      }
      host.remove();
    }, 260);
  }

  function onMessage(msg, _sender, reply) {
    if (!msg || typeof msg.tact !== "string") return;
    switch (msg.tact) {
      case "move":
        raise();
        glide(msg.points, msg.delays);
        break;
      case "press":
        raise();
        ripple(msg.x, msg.y);
        break;
      case "at":
        place(msg.x, msg.y);
        break;
      case "suspend":
        host.style.setProperty("display", "none", "important");
        reply(true);
        break;
      case "resume":
        host.style.setProperty("display", "block", "important");
        raise();
        break;
      case "remove":
        teardown();
        reply(true);
        break;
    }
  }

  document.documentElement.appendChild(host);
  keep.observe(document.documentElement, { childList: true });
  raise();
  chrome.runtime.onMessage.addListener(onMessage);
})();
