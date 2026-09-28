// User-editable LLM settings: which provider/model the agent talks to, and
// the API key it needs. Kept by the store (store/store.ts; the local broker
// uses storage/config.json) so the Settings page in the side panel can change
// them without restarting the broker or touching .env. First load seeds
// itself from the existing env vars, so upgrading from an .env-only setup
// keeps working with no action needed.

import { store } from "./store/store.js";

export type Provider = "ollama" | "openai" | "openrouter";

export type LLMConfig = {
  provider: Provider;
  ollama: { host: string; model: string; numCtx: number };
  openai: { model: string; apiKey: string };
  openrouter: { model: string; apiKey: string };
};

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

function defaults(): LLMConfig {
  return {
    // Ollama was the only provider before Settings existed — keep it the
    // default so upgrading an .env-only setup doesn't change behavior. The
    // cloud, which cannot reach anyone's Ollama, sets LLM_PROVIDER.
    provider: (process.env.LLM_PROVIDER as Provider | undefined) ?? "ollama",
    ollama: {
      host: process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
      model: process.env.OLLAMA_MODEL ?? "minimax-m3:cloud",
      numCtx: Number(process.env.OLLAMA_NUM_CTX ?? 32768),
    },
    openai: {
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      apiKey: process.env.OPENAI_API_KEY ?? "",
    },
    openrouter: {
      model: process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-v4.1-flash",
      apiKey: process.env.OPENROUTER_API_KEY ?? "",
    },
  };
}

// Loaded per user and kept in memory; every read is synchronous so the agent
// loop never blocks on storage mid-run. initConfig() always reloads, so an
// entry point that serves a user again can pick up changes made elsewhere.
const cache = new Map<string, LLMConfig>();

function merge(base: LLMConfig, patch: DeepPartial<LLMConfig>): LLMConfig {
  return {
    provider: patch.provider ?? base.provider,
    ollama: { ...base.ollama, ...patch.ollama },
    openai: { ...base.openai, ...patch.openai },
    openrouter: { ...base.openrouter, ...patch.openrouter },
  };
}

type DeepPartial<T> = { [K in keyof T]?: Partial<T[K]> extends T[K] ? T[K] : DeepPartial<T[K]> };

export async function initConfig(userId: string): Promise<LLMConfig> {
  let cfg: LLMConfig;
  try {
    const raw = (await store().loadConfig(userId)) as DeepPartial<LLMConfig> | null;
    cfg = raw ? merge(defaults(), raw) : defaults();
  } catch {
    // Unreadable — start from env-seeded defaults.
    cfg = defaults();
  }
  cache.set(userId, cfg);
  return cfg;
}

/** Synchronous — call initConfig() for the user before using this. */
export function getConfig(userId: string): LLMConfig {
  const cfg = cache.get(userId);
  if (!cfg) throw new Error(`config not initialized for ${userId} — call initConfig() first`);
  return cfg;
}

/** Merges `patch` into the user's config, applies it immediately, and saves it. */
export async function setConfig(userId: string, patch: DeepPartial<LLMConfig>): Promise<LLMConfig> {
  const next = merge(getConfig(userId), patch);
  cache.set(userId, next);
  try {
    await store().saveConfig(userId, next);
  } catch (err) {
    console.error(`[config] could not save settings: ${String(err)}`);
  }
  return next;
}

const CHAT_MODEL_PATTERN = /^(gpt-|o[1-9](-|$)|chatgpt-)/;
const EXCLUDE_PATTERN = /(embedding|whisper|tts|dall-e|moderation|audio|realtime|transcribe|image)/;

type OpenRouterModel = {
  id: string;
  context_length?: number;
  supported_parameters?: string[];
  architecture?: { input_modalities?: string[] };
};

// OpenRouter's catalog is public and changes rarely, so it is fetched once
// and kept. A failed fetch is not kept, so the next call tries again.
let openrouterCatalog: Promise<OpenRouterModel[]> | null = null;

function openrouterModels(): Promise<OpenRouterModel[]> {
  openrouterCatalog ??= (async () => {
    const res = await fetch(`${OPENROUTER_BASE}/models`);
    if (!res.ok) throw new Error(`OpenRouter returned ${res.status}`);
    const { data } = (await res.json()) as { data?: OpenRouterModel[] };
    return data ?? [];
  })().catch((err) => {
    openrouterCatalog = null;
    throw err;
  });
  return openrouterCatalog;
}

/** Context window of an OpenRouter model in tokens, or null when it is unknown. */
export async function openrouterContextTokens(model: string): Promise<number | null> {
  try {
    const found = (await openrouterModels()).find((m) => m.id === model);
    return found?.context_length ?? null;
  } catch {
    return null;
  }
}

// Whether each Ollama model takes images, by host and model. Only answers
// are kept, so a failed lookup is tried again next run.
const ollamaVision = new Map<string, boolean>();

/**
 * Whether the model `cfg` points at takes images — screenshots are wasted
 * on one that does not, and OpenRouter refuses the whole request ("No
 * endpoints found that support image input"). OpenRouter's catalog and
 * Ollama's /api/show say; OpenAI does not, and some of its models (o3-mini)
 * are text-only. Null when it cannot be told: callers treat that as yes,
 * and agent.ts learns otherwise from the first refusal.
 */
export async function acceptsImages(cfg: LLMConfig): Promise<boolean | null> {
  try {
    if (cfg.provider === "openrouter") {
      const found = (await openrouterModels()).find((m) => m.id === cfg.openrouter.model);
      const inputs = found?.architecture?.input_modalities;
      return inputs ? inputs.includes("image") : null;
    }
    if (cfg.provider === "ollama") {
      const host = cfg.ollama.host.replace(/\/$/, "");
      const key = `${host}|${cfg.ollama.model}`;
      const known = ollamaVision.get(key);
      if (known !== undefined) return known;
      const res = await fetch(`${host}/api/show`, {
        method: "POST",
        body: JSON.stringify({ model: cfg.ollama.model }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      // Older Ollama versions do not list capabilities at all.
      const { capabilities } = (await res.json()) as { capabilities?: string[] };
      if (!capabilities) return null;
      const vision = capabilities.includes("vision");
      ollamaVision.set(key, vision);
      return vision;
    }
    return null;
  } catch {
    return null;
  }
}

/** Model ids available right now for `provider`, given the user's current settings. */
export async function listModels(userId: string, provider: Provider): Promise<string[]> {
  const cfg = getConfig(userId);
  if (provider === "openrouter") {
    // The agent cannot work without tool calling. ":batch" variants are for
    // OpenRouter's batch API, not chat completions.
    return (await openrouterModels())
      .filter((m) => m.supported_parameters?.includes("tools") && !m.id.endsWith(":batch"))
      .map((m) => m.id)
      .sort();
  }
  if (provider === "ollama") {
    const res = await fetch(`${cfg.ollama.host.replace(/\/$/, "")}/api/tags`);
    if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
    const { models } = (await res.json()) as { models?: { name: string }[] };
    return (models ?? []).map((m) => m.name).sort();
  }

  if (!cfg.openai.apiKey) throw new Error("No OpenAI API key set yet.");
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${cfg.openai.apiKey}` },
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error("OpenAI rejected that API key.");
    throw new Error(`OpenAI returned ${res.status}`);
  }
  const { data } = (await res.json()) as { data?: { id: string }[] };
  return (data ?? [])
    .map((m) => m.id)
    .filter((id) => CHAT_MODEL_PATTERN.test(id) && !EXCLUDE_PATTERN.test(id))
    .sort();
}
