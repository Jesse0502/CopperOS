// Which broker the extension talks to: the one on this computer ("local"),
// or the hosted CopperOS ("cloud"). Each keeps its own chats and state, and
// nothing crosses between them. The choice is remembered across browser
// restarts in chrome.storage.local.

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

export async function getBackend() {
  try {
    const { backend } = await chrome.storage.local.get("backend");
    if (backend === "local" || backend === "cloud") return backend;
  } catch {
    // Storage unavailable: fall through to the default.
  }
  // A developer's unpacked copy starts on the broker beside it; a store
  // install starts on the hosted one.
  return (await isDevelopmentCopy()) ? "local" : "cloud";
}

export async function setBackend(backend) {
  await chrome.storage.local.set({ backend });
}
