// Durable, cross-chat facts about the user — unlike session.ts's transcripts,
// these outlive any one chat. Flat markdown files with hand-parsed
// frontmatter, grouped by topic folders the model chooses, e.g.
// "user/career". No yaml dependency and no search index: the corpus is
// personal facts, not documents, so a full scan on every search is cheap.
//
// Layout, under storageDir (see session.ts):
//   memories/<topic>/<slug>.md

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { LIKELY_AT, rankSources } from "./jev.js";
import { storageDir } from "./session.js";

const ROOT = path.join(storageDir, "memories");

export type MemoryMeta = {
  topic: string;
  slug: string;
  title: string;
  created: string;
  updated: string;
};

export type MemoryHit = MemoryMeta & { content: string };

function sanitizeSegment(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "misc";
}

/** Slash-separated path the model supplies, made safe to join onto ROOT. */
function sanitizeTopic(topic: string): string {
  return topic.split("/").map(sanitizeSegment).filter(Boolean).join("/") || "misc";
}

function slugify(title: string): string {
  return sanitizeSegment(title);
}

function toFile(meta: MemoryMeta, content: string): string {
  return (
    `---\n` +
    `title: ${meta.title}\n` +
    `topic: ${meta.topic}\n` +
    `created: ${meta.created}\n` +
    `updated: ${meta.updated}\n` +
    `---\n\n${content.trim()}\n`
  );
}

function parseFile(raw: string): { title: string; topic: string; created: string; updated: string; content: string } | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (!fields.title || !fields.topic) return null;
  return {
    title: fields.title,
    topic: fields.topic,
    created: fields.created ?? "",
    updated: fields.updated ?? "",
    content: m[2].trim(),
  };
}

/** Save (or overwrite, keeping the original `created`) a fact under `topic`. */
export async function saveMemory(topic: string, title: string, content: string): Promise<MemoryMeta> {
  const safeTopic = sanitizeTopic(topic);
  const slug = slugify(title);
  const dir = path.join(ROOT, safeTopic);
  const file = path.join(dir, `${slug}.md`);
  const now = new Date().toISOString();

  let created = now;
  try {
    const existing = parseFile(await readFile(file, "utf8"));
    if (existing?.created) created = existing.created;
  } catch {
    // No existing file — this is a new memory.
  }

  const meta: MemoryMeta = { topic: safeTopic, slug, title, created, updated: now };
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, toFile(meta, content), "utf8");
  await rename(tmp, file);
  return meta;
}

/** Every saved memory with its body. */
export function allMemories(): Promise<MemoryHit[]> {
  return walkMemories();
}

/** A memory's id in rankings and tool output: its topic path and slug. */
export function memoryId(m: MemoryMeta): string {
  return `${m.topic}/${m.slug}`;
}

/** Every saved memory with its body, tolerant of unreadable or corrupt files. */
async function walkMemories(dir = ROOT, topicParts: string[] = []): Promise<MemoryHit[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const hits: MemoryHit[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      hits.push(...(await walkMemories(full, [...topicParts, entry.name])));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    try {
      const parsed = parseFile(await readFile(full, "utf8"));
      if (!parsed) throw new Error("unrecognized frontmatter");
      hits.push({
        topic: parsed.topic,
        slug: entry.name.slice(0, -3),
        title: parsed.title,
        created: parsed.created,
        updated: parsed.updated,
        content: parsed.content,
      });
    } catch (err) {
      console.warn(`[memory] skipping unreadable file ${full}: ${String(err)}`);
    }
  }
  return hits;
}

/**
 * Every memory last written before `cutoff` (an ISO time) — what tools.ts's
 * grounding check may count as something the user told us. A memory saved
 * or changed after the chat began is left out: the model writes memories
 * itself, so otherwise it could `remember` a guess and then cite it as fact.
 */
export async function memoriesBefore(cutoff: string): Promise<MemoryHit[]> {
  return (await walkMemories()).filter((h) => h.updated && h.updated < cutoff);
}

const STOPWORDS = new Set(["the", "a", "an", "of", "to", "for", "and", "or", "is", "are", "my", "me", "on", "in", "at"]);

function words(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => !STOPWORDS.has(w)) ?? [];
}

function score(query: string[], hit: MemoryHit): number {
  const haystack = words(`${hit.title} ${hit.topic} ${hit.content}`);
  return query.reduce((n, q) => n + (haystack.includes(q) ? 1 : 0), 0);
}

const MAX_RESULTS = 5;
const CONVERSATION = "conversation";

/**
 * The saved memories most likely to hold what `query` is looking for, best
 * first. With Jev configured, every memory — and what the user has said in
 * this chat, as one more source — is ranked against the query (see
 * rankSources), so a memory can come back without sharing a word with the
 * query, and one that shares words but not meaning stays out. Without Jev,
 * or if the ranking fails, this falls back to keyword overlap. `p` is Jev's
 * probability, absent for keyword results; `inConversation` is how likely
 * the user's own messages already hold the answer.
 */
export async function searchMemories(
  query: string,
  userSaid: string[],
  chatId: string,
  signal?: AbortSignal,
): Promise<{
  note: string;
  results: Array<MemoryHit & { p?: number }>;
  inConversation?: number;
}> {
  const all = await walkMemories();
  if (all.length === 0) return { note: "", results: [] };

  const said = userSaid.join("\n\n");
  const ranked = await rankSources(
    [`the answer to: "${query}"`],
    [
      ...(said ? [{ id: CONVERSATION, text: `What the user has said in this chat: ${said.slice(0, 8000)}` }] : []),
      ...all.map((h) => ({ id: memoryId(h), text: `Saved memory — ${h.title}: ${h.content}` })),
    ],
    chatId,
    signal,
  );
  if (ranked) {
    const byId = new Map(all.map((h) => [memoryId(h), h]));
    const inConversation = ranked[0].find((r) => r.id === CONVERSATION)?.p;
    const results = ranked[0]
      .filter((r) => r.id !== CONVERSATION && r.p >= LIKELY_AT)
      .slice(0, MAX_RESULTS)
      .map((r) => ({ ...byId.get(r.id)!, p: r.p }));
    return {
      note: results.length
        ? `Jev ranked all ${all.length} saved memories; these are the likeliest to hold it, best first.`
        : `Jev checked all ${all.length} saved memories: none looks like it holds this.`,
      results,
      inConversation,
    };
  }

  const q = words(query);
  const results = all
    .map((hit) => ({ hit, s: score(q, hit) }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, MAX_RESULTS)
    .map(({ hit }) => hit);
  return { note: "Keyword matches (Jev ranking unavailable).", results };
}
