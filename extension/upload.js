// File uploads without the native file picker and without file paths.
//
// DOM.setFileInputFiles takes paths, and Chrome refuses it ("Not allowed") for
// extensions without file-URL access. Instead the broker sends the file's
// bytes, and they are set on the <input type=file> from an isolated world:
// a DataTransfer builds a real FileList, then input and change events fire so
// the page's own upload code runs as if the user had picked the file.
//
// When the ref is a button that opens the picker ("Add media"), the click is
// made with file-chooser interception on: Chrome reports which input asked for
// a file instead of showing the dialog, so nothing pops up on the desktop.

import { send } from "./cdp.js";
import { resolveRef } from "./snapshot.js";
import { clickNode } from "./input.js";

const CHOOSER_WAIT_MS = 5000;
const WORLD = "copperos-upload";

async function isFileInput(tabId, backendNodeId) {
  const { node } = await send(tabId, "DOM.describeNode", { backendNodeId });
  if (node.nodeName !== "INPUT") return false;
  const attrs = node.attributes ?? [];
  for (let i = 0; i < attrs.length; i += 2) {
    if (attrs[i] === "type" && String(attrs[i + 1]).toLowerCase() === "file") return true;
  }
  return false;
}

function waitForChooser(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.debugger.onEvent.removeListener(listener);
      resolve(null);
    }, timeoutMs);
    function listener(source, method, params) {
      if (source.tabId !== tabId || method !== "Page.fileChooserOpened") return;
      clearTimeout(timer);
      chrome.debugger.onEvent.removeListener(listener);
      resolve(params);
    }
    chrome.debugger.onEvent.addListener(listener);
  });
}

/** Clicks the element with interception on and returns the file input that asked for a file. */
async function inputOpenedBy(tabId, backendNodeId, what) {
  await send(tabId, "Page.setInterceptFileChooserDialog", { enabled: true });
  try {
    const opened = waitForChooser(tabId, CHOOSER_WAIT_MS);
    await clickNode(tabId, backendNodeId, { what });
    const ev = await opened;
    if (ev?.backendNodeId) return ev.backendNodeId;
  } finally {
    await send(tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
  }
  // Some pages keep a hidden input that the button never opens; if there is
  // exactly one on the page, that is the one.
  const { root } = await send(tabId, "DOM.getDocument", { depth: 0 });
  const { nodeIds } = await send(tabId, "DOM.querySelectorAll", { nodeId: root.nodeId, selector: 'input[type="file"]' });
  if (nodeIds.length === 1) {
    const { node } = await send(tabId, "DOM.describeNode", { nodeId: nodeIds[0] });
    return node.backendNodeId;
  }
  throw new Error(
    `clicking ${what} did not open a file picker` +
      (nodeIds.length ? `, and the page has ${nodeIds.length} file inputs, so which one is meant is unclear` : "") +
      `. Take a snapshot and pass the ref of the button that adds a photo or file.`,
  );
}

async function setFiles(tabId, backendNodeId, files) {
  const { frameTree } = await send(tabId, "Page.getFrameTree");
  const { executionContextId } = await send(tabId, "Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: WORLD });
  const { object } = await send(tabId, "DOM.resolveNode", { backendNodeId, executionContextId });
  const { result, exceptionDetails } = await send(tabId, "Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: `function (files) {
      const dt = new DataTransfer();
      for (const f of files) {
        const bin = atob(f.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        dt.items.add(new File([bytes], f.name, { type: f.mime }));
      }
      this.files = dt.files;
      this.dispatchEvent(new Event("input", { bubbles: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
      return this.files.length;
    }`,
    arguments: [{ value: files }],
    returnByValue: true,
  }, { timeoutMs: 30_000 });
  if (exceptionDetails) throw new Error(`the page refused the file: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  if (result?.value !== files.length) throw new Error("the file input did not take the file");
}

/** Uploads `files` ([{ name, mime, base64 }]) through the input `ref` is, or the one it opens. */
export async function uploadFiles(tabId, ref, files) {
  const node = resolveRef(tabId, ref);
  const what = `ref "${ref}"`;
  const input = (await isFileInput(tabId, node)) ? node : await inputOpenedBy(tabId, node, what);
  await setFiles(tabId, input, files);
  return { uploaded: files.map((f) => f.name) };
}
