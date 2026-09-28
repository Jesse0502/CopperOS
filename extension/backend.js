// Which broker the extension talks to: the one on this computer ("local"),
// or the hosted CopperOS ("cloud"). Each keeps its own chats and state, and
// nothing crosses between them. The choice is remembered across browser
// restarts in chrome.storage.local.

export const LOCAL_URL = "ws://127.0.0.1:7331";

// The hosted backend (infra/). Points at the dev stage until launch.
export const CLOUD = {
  socketUrl: "wss://qw2wh9kw7i.execute-api.us-east-1.amazonaws.com/dev",
  signInUrl: "https://copperos-dev.auth.us-east-1.amazoncognito.com",
  clientId: "7qii82cvit9gp4l68qhhc9fsvv",
};

export async function getBackend() {
  try {
    const { backend } = await chrome.storage.local.get("backend");
    if (backend === "local" || backend === "cloud") return backend;
  } catch {
    // Storage unavailable: fall through to the default.
  }
  // A developer's unpacked copy starts on the broker beside it; a store
  // install starts on the hosted one.
  const self = await chrome.management.getSelf().catch(() => null);
  return self?.installType === "development" ? "local" : "cloud";
}

export async function setBackend(backend) {
  await chrome.storage.local.set({ backend });
}
