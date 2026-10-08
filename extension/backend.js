// Which broker the extension talks to: the one on this computer ("local"),
// or the hosted CopperOS ("cloud"). Each keeps its own chats and state, and
// nothing crosses between them. What the person chose, with the switch in
// Settings, is remembered across browser restarts in chrome.storage.local.
// Without a choice it is the cloud, unless a broker is running on this
// computer and nobody is signed in, when it is that one (background.js).

export const LOCAL_URL = "ws://127.0.0.1:7331";

// The hosted backend's stages (infra/). A store install talks to prod; an
// unpacked development copy talks to dev, so working on the extension never
// touches real users. Prod only lets the store copy sign in anyway. Both
// kinds of copy send suggestions to their stage's inbox, cloud or not.
const STAGES = {
  prod: {
    socketUrl: "wss://99vtftxn7k.execute-api.us-east-1.amazonaws.com/prod",
    signInUrl: "https://copperos.auth.us-east-1.amazoncognito.com",
    clientId: "6n28mm5q95he6s27gjka4ajb4l",
    feedbackUrl: "https://4ksvfjpoydllajow3oi55hut7i0vhixf.lambda-url.us-east-1.on.aws/",
  },
  dev: {
    socketUrl: "wss://qw2wh9kw7i.execute-api.us-east-1.amazonaws.com/dev",
    signInUrl: "https://copperos-dev.auth.us-east-1.amazoncognito.com",
    clientId: "7qii82cvit9gp4l68qhhc9fsvv",
    feedbackUrl: "https://letjpgm63s47pdxwsz6vuvxcfm0jqjui.lambda-url.us-east-1.on.aws/",
  },
};

let installType = null;
async function isDevelopmentCopy() {
  installType ??= (await chrome.management.getSelf().catch(() => null))?.installType ?? "normal";
  return installType === "development";
}

/** The hosted backend this copy of the extension uses. */
export async function cloud() {
  return (await isDevelopmentCopy()) ? STAGES.dev : STAGES.prod;
}

/** What the person chose with the switch in Settings, or null if they never did. */
export async function chosenBackend() {
  try {
    const { backend } = await chrome.storage.local.get("backend");
    if (backend === "local" || backend === "cloud") return backend;
  } catch {
    // Storage unavailable: no choice that can be read.
  }
  return null;
}

/** Where to start: the choice, or the cloud. A broker on this computer is noticed after, and used if nobody is signed in. */
export async function getBackend() {
  return (await chosenBackend()) ?? "cloud";
}

export async function setBackend(backend) {
  await chrome.storage.local.set({ backend });
}

/**
 * Whether a CopperOS broker is running on this computer. Asked over HTTP, not
 * by opening a WebSocket: the broker keeps one extension at a time, so a
 * socket opened just to look would displace the one already talking to it.
 * Its WebSocket server answers a plain request with 426 Upgrade Required.
 */
export async function localBrokerRunning() {
  try {
    const res = await fetch(LOCAL_URL.replace(/^ws/, "http"), { signal: AbortSignal.timeout(1000) });
    return res.status === 426;
  } catch {
    return false;
  }
}
