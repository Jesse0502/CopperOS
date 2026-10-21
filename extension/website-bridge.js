// Runs on copper.jassydev.com only. It tells the page the extension is installed, and hands a mold
// to the extension when a "Run in CopperOS" button is clicked. The mold is read here, in the click
// itself, because Chrome only opens the side panel for a click the person made.
(() => {
  const REPLACED = "copperos:bridge-replaced";

  // A newer copy of this script (the extension updated, or was added while the page was open) takes over.
  document.dispatchEvent(new Event(REPLACED));

  function onClick(event) {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    const button = event.target.closest("[data-copperos-mold]");
    // The extension was updated under this page: its link goes to the store instead.
    if (!button || !chrome.runtime?.id) return;
    const source = document.getElementById(button.getAttribute("data-copperos-mold"));
    const text = (source?.value ?? source?.textContent ?? "").trim();
    if (!text) return;
    event.preventDefault();
    const settle = (state) => button.setAttribute("data-copperos-state", state);
    settle("opening");
    try {
      chrome.runtime.sendMessage(
        { type: "open_mold", text, approvals: button.getAttribute("data-approvals") },
        (res) => {
          void chrome.runtime.lastError;
          settle(res?.opened ? "opened" : res?.ok ? "waiting" : "failed");
        },
      );
    } catch {
      settle("failed");
    }
  }

  function off() {
    document.removeEventListener("click", onClick, true);
  }

  function mark() {
    document.documentElement.setAttribute("data-copperos", chrome.runtime.getManifest().version);
  }

  document.addEventListener("click", onClick, true);
  document.addEventListener(REPLACED, off, { once: true });
  // The page's own style shows the right button from the first paint, so this goes on as early as there is an element.
  if (document.documentElement) mark();
  else document.addEventListener("DOMContentLoaded", mark, { once: true });
})();
