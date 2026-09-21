// Pages chrome.debugger cannot attach to: chrome://, the Web Store, the PDF
// viewer, devtools itself. Shared by cdp.js (to fail fast and clearly instead
// of letting a raw "Cannot access a chrome:// URL" surface) and nav.js /
// background.js (to route around them with the plain tabs API instead).

const RESTRICTED_PREFIXES = [
  "chrome://", "chrome-extension://", "chrome-search://",
  "edge://", "about:", "devtools://", "view-source:",
];
const RESTRICTED_HOSTS = ["chromewebstore.google.com", "chrome.google.com"];

export function isRestrictedUrl(url) {
  if (!url) return true; // no URL yet — e.g. a tab still initializing
  if (RESTRICTED_PREFIXES.some((p) => url.startsWith(p))) return true;
  try {
    return RESTRICTED_HOSTS.includes(new URL(url).hostname);
  } catch {
    return true;
  }
}
