// Durable, cross-chat facts about the user — unlike session.ts's transcripts,
// these outlive any one chat. Grouped by topic paths the model chooses, e.g.
// "user/career". No search index: the corpus is personal facts, not
// documents, so a full scan on every search is cheap. Where they are kept is
// the store's business (store/store.ts): the local broker writes one
// markdown file per fact.

import { LIKELY_AT, rankSources } from "./jev.js";
import { store, type MemoryRecord } from "./store/store.js";

export type MemoryMeta = Omit<MemoryRecord, "content">;

export type MemoryHit = MemoryRecord;

function sanitizeSegment(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "misc";
}

/** Slash-separated path the model supplies, made safe to use as a folder path. */
function sanitizeTopic(topic: string): string {
  return topic.split("/").map(sanitizeSegment).filter(Boolean).join("/") || "misc";
}

function slugify(title: string): string {
  return sanitizeSegment(title);
}

/** Save (or overwrite, keeping the original `created`) a fact under `topic`. */
export async function saveMemory(
  userId: string,
  topic: string,
  title: string,
  content: string,
): Promise<MemoryMeta> {
  const safeTopic = sanitizeTopic(topic);
  const slug = slugify(title);
  const now = new Date().toISOString();

  let created = now;
  try {
    const existing = await store().getMemory(userId, safeTopic, slug);
    if (existing?.created) created = existing.created;
  } catch {
    // Unreadable — save it as a new memory.
  }

  const meta: MemoryMeta = { topic: safeTopic, slug, title, created, updated: now };
  await store().putMemory(userId, { ...meta, content: content.trim() });
  return meta;
}

/** Every saved memory with its body. */
export function allMemories(userId: string): Promise<MemoryHit[]> {
  return store().listMemories(userId);
}

/** A memory's id in rankings and tool output: its topic path and slug. */
export function memoryId(m: MemoryMeta): string {
  return `${m.topic}/${m.slug}`;
}

// ── the panel's Memories page ─────────────────────────────────────────────

/** One memory as the Memories page shows it; `key` is what deleting it takes. */
export type MemoryView = { key: string; topic: string; title: string; content: string; updated: string };

// Where the facts people type on the Memories page go.
const ADDED_TOPIC = "user/notes";
// Room for a short bio or a block of standard answers. Not unlimited: every
// grounding check and memory search sends Jev all of a person's memories.
// The panel's textarea has the same maxlength.
const ADDED_MAX = 4000;
const TITLE_MAX = 60;

/** Every saved memory, newest first. */
export async function memoriesForPage(userId: string): Promise<MemoryView[]> {
  return (await allMemories(userId))
    .map((m) => ({ key: memoryId(m), topic: m.topic, title: m.title, content: m.content, updated: m.updated }))
    .sort((a, b) => b.updated.localeCompare(a.updated));
}

/**
 * Saves something the user typed on the Memories page. It skips Jev's
 * is-this-worth-keeping check (see the remember tool): the user asked for it
 * to be kept. Titled by its opening words, with a number added if that title
 * is taken, so a new fact never overwrites an old one.
 */
export async function addUserMemory(userId: string, text: string): Promise<MemoryMeta> {
  // Line breaks are kept, so a pasted list or a few paragraphs stay readable;
  // runs of spaces and blank lines are tidied.
  const content = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!content) throw new Error("Type something to remember first.");
  if (content.length > ADDED_MAX) throw new Error(`Keep it under ${ADDED_MAX.toLocaleString("en-US")} characters.`);
  const opening = content.split("\n")[0].split(/(?<=[.!?])\s/)[0];
  const base =
    opening.length <= TITLE_MAX
      ? opening.replace(/[.!?]$/, "")
      : `${opening.slice(0, TITLE_MAX).replace(/\s+\S*$/, "")}…`;
  let title = base;
  for (let n = 2; await store().getMemory(userId, ADDED_TOPIC, slugify(title)); n++) title = `${base} (${n})`;
  return saveMemory(userId, ADDED_TOPIC, title, content);
}

/** Removes the memory with this `key` (from memoriesForPage). */
export async function deleteMemoryByKey(userId: string, key: string): Promise<void> {
  const cut = key.lastIndexOf("/");
  if (cut <= 0) throw new Error("That is not a saved memory.");
  // The key comes from the page: made safe the same way saving made it.
  await store().deleteMemory(userId, sanitizeTopic(key.slice(0, cut)), sanitizeSegment(key.slice(cut + 1)));
}

/**
 * Every memory last written before `cutoff` (an ISO time) — what tools.ts's
 * grounding check may count as something the user told us. A memory saved
 * or changed after the chat began is left out: the model writes memories
 * itself, so otherwise it could `remember` a guess and then cite it as fact.
 */
export async function memoriesBefore(userId: string, cutoff: string): Promise<MemoryHit[]> {
  return (await allMemories(userId)).filter((h) => h.updated && h.updated < cutoff);
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
  userId: string,
  query: string,
  userSaid: string[],
  chatId: string,
  signal?: AbortSignal,
): Promise<{
  note: string;
  results: Array<MemoryHit & { p?: number }>;
  inConversation?: number;
}> {
  const all = await allMemories(userId);
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
