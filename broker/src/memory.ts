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
import { suggestMemoryTopic } from "./jev.js";
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

const STOPWORDS = new Set(["the", "a", "an", "of", "to", "for", "and", "or", "is", "are", "my", "me", "on", "in", "at"]);

function words(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => !STOPWORDS.has(w)) ?? [];
}

function score(query: string[], hit: MemoryHit): number {
  const haystack = words(`${hit.title} ${hit.topic} ${hit.content}`);
  return query.reduce((n, q) => n + (haystack.includes(q) ? 1 : 0), 0);
}

/**
 * Local keyword search plus, when Jev is configured, its advisory pick of the
 * most relevant existing topic. Jev's answer only re-ranks results and is
 * surfaced as `verdict` — it never suppresses a keyword match, since search
 * is free and Jev's judgment here is new and unproven, unlike the
 * cost-driven approval gate in tools.ts.
 */
export async function searchMemories(
  query: string,
  chatId: string,
): Promise<{ verdict: string | null; results: MemoryHit[] }> {
  const all = await walkMemories();
  const q = words(query);

  let boostTopic: string | null = null;
  let verdict: string | null = null;
  const topics = [...new Set(all.map((h) => h.topic))];
  if (topics.length > 0) {
    const suggestion = await suggestMemoryTopic(query, topics, chatId);
    if (suggestion) {
      boostTopic = suggestion.topic;
      verdict = `Jev: likely relevant topic is "${suggestion.topic}" (confidence ${suggestion.confidence.toFixed(2)}).`;
    } else {
      verdict = "Jev: no existing topic looked relevant to this query — showing keyword matches anyway.";
    }
  }

  const ranked = all
    .map((hit) => ({ hit, s: score(q, hit) + (hit.topic === boostTopic ? 2 : 0) }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5)
    .map(({ hit }) => hit);

  return { verdict, results: ranked };
}
