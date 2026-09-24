// User-editable LLM settings: which provider/model the agent talks to, and
// the API key it needs. Persisted under storage/config.json so the Settings
// page in the side panel can change them without restarting the broker or
// touching .env. First load seeds itself from the existing env vars, so
// upgrading from an .env-only setup keeps working with no action needed.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { storageDir } from "./session.js";

export type Provider = "ollama" | "openai" | "openrouter";

export type LLMConfig = {
  provider: Provider;
  ollama: { host: string; model: string; numCtx: number };
  openai: { model: string; apiKey: string };
  openrouter: { model: string; apiKey: string };
};

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

const FILE = path.join(storageDir, "config.json");

function defaults(): LLMConfig {
  return {
    // Ollama was the only provider before Settings existed — keep it the
    // default so upgrading an .env-only setup doesn't change behavior.
    provider: "ollama",
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

// Loaded once at startup and kept in memory; every read is synchronous so the
// agent loop never blocks on disk mid-run. Writes go to disk in the
// background, same pattern as session.ts's save().
let cache: LLMConfig | null = null;

function merge(base: LLMConfig, patch: DeepPartial<LLMConfig>): LLMConfig {
  return {
    provider: patch.provider ?? base.provider,
    ollama: { ...base.ollama, ...patch.ollama },
    openai: { ...base.openai, ...patch.openai },
    openrouter: { ...base.openrouter, ...patch.openrouter },
  };
}

type DeepPartial<T> = { [K in keyof T]?: Partial<T[K]> extends T[K] ? T[K] : DeepPartial<T[K]> };

export async function initConfig(): Promise<LLMConfig> {
  try {
    const raw = JSON.parse(await readFile(FILE, "utf8")) as Partial<LLMConfig>;
    cache = merge(defaults(), raw as DeepPartial<LLMConfig>);
  } catch {
    // No config yet, or it is unreadable — start from env-seeded defaults.
    cache = defaults();
  }
  return cache;
}

/** Synchronous — call initConfig() once at startup before using this. */
export function getConfig(): LLMConfig {
  if (!cache) throw new Error("config not initialized — call initConfig() first");
  return cache;
}

async function persist(cfg: LLMConfig): Promise<void> {
  await mkdir(storageDir, { recursive: true });
  const tmp = `${FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(cfg, null, 2), "utf8");
  await rename(tmp, FILE);
}

/** Merges `patch` into the current config, applies it immediately, and saves it. */
export async function setConfig(patch: DeepPartial<LLMConfig>): Promise<LLMConfig> {
  const next = merge(getConfig(), patch);
  cache = next;
  try {
    await persist(next);
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

/** Model ids available right now for `provider`, given its current settings. */
export async function listModels(provider: Provider): Promise<string[]> {
  const cfg = getConfig();
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
