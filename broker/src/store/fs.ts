// The local broker's store: plain files, one user.
//
// Layout, under STORAGE_DIR (default <repo>/storage):
//   sessions/<id>.json            one transcript per chat
//   current.json                  which chat to resume on startup
//   memories/<topic>/<slug>.md    one fact each, hand-parsed frontmatter
//   progress/<chatId>.json        the chat's current task
//   config.json                   LLM provider, model and keys
//
// Every write goes to a .tmp file first and is renamed into place, so a crash
// mid-write leaves the previous version intact rather than a truncated file
// that fails to parse on the next start.

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LLMConfig } from "../config.js";
import type { TaskState } from "../progress.js";
import type { Session } from "../session.js";
import { LOCAL_USER, summarize, type ChatSummary, type MemoryRecord, type Store } from "./store.js";

export const DEFAULT_STORAGE_DIR =
  process.env.STORAGE_DIR ?? path.resolve(import.meta.dirname, "../../../storage");

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
}

/** The file's parsed JSON, or null if it does not exist. Any other failure throws. */
async function readJson(file: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(raw);
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

function toMemoryFile(m: MemoryRecord): string {
  return (
    `---\n` +
    `title: ${m.title}\n` +
    `topic: ${m.topic}\n` +
    `created: ${m.created}\n` +
    `updated: ${m.updated}\n` +
    `---\n\n${m.content.trim()}\n`
  );
}

function parseMemoryFile(raw: string, slug: string): MemoryRecord | null {
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
    topic: fields.topic,
    slug,
    title: fields.title,
    created: fields.created ?? "",
    updated: fields.updated ?? "",
    content: m[2].trim(),
  };
}

export class FsStore implements Store {
  constructor(private readonly dir = DEFAULT_STORAGE_DIR) {}

  /** One folder, one user: anyone else reaching this store is a wiring bug. */
  private root(userId: string): string {
    if (userId !== LOCAL_USER) throw new Error(`the file store only holds "${LOCAL_USER}", not "${userId}"`);
    return this.dir;
  }

  private chatFile(userId: string, chatId: string): string {
    return path.join(this.root(userId), "sessions", `${chatId}.json`);
  }

  loadChat(userId: string, chatId: string): Promise<unknown | null> {
    return readJson(this.chatFile(userId, chatId));
  }

  saveChat(userId: string, chat: Session): Promise<void> {
    return writeAtomic(this.chatFile(userId, chat.id), json(chat));
  }

  async listChats(userId: string): Promise<ChatSummary[]> {
    const dir = path.join(this.root(userId), "sessions");
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    const summaries: ChatSummary[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        summaries.push(summarize(JSON.parse(await readFile(path.join(dir, f), "utf8")) as Session));
      } catch {
        // Skip a corrupt or mid-write file rather than failing the whole list.
      }
    }
    return summaries;
  }

  async getCurrentChat(userId: string): Promise<string | null> {
    const current = (await readJson(path.join(this.root(userId), "current.json"))) as { id?: string } | null;
    return current?.id ?? null;
  }

  setCurrentChat(userId: string, chatId: string): Promise<void> {
    return writeAtomic(path.join(this.root(userId), "current.json"), json({ id: chatId }));
  }

  async listMemories(userId: string): Promise<MemoryRecord[]> {
    return walkMemories(path.join(this.root(userId), "memories"));
  }

  async getMemory(userId: string, topic: string, slug: string): Promise<MemoryRecord | null> {
    try {
      return parseMemoryFile(
        await readFile(path.join(this.root(userId), "memories", topic, `${slug}.md`), "utf8"),
        slug,
      );
    } catch {
      return null;
    }
  }

  putMemory(userId: string, memory: MemoryRecord): Promise<void> {
    const file = path.join(this.root(userId), "memories", memory.topic, `${memory.slug}.md`);
    return writeAtomic(file, toMemoryFile(memory));
  }

  private taskFile(userId: string, chatId: string): string {
    return path.join(this.root(userId), "progress", `${chatId.replace(/[^\w-]/g, "_")}.json`);
  }

  async loadTask(userId: string, chatId: string): Promise<TaskState | null> {
    return (await readJson(this.taskFile(userId, chatId))) as TaskState | null;
  }

  saveTask(userId: string, chatId: string, task: TaskState): Promise<void> {
    return writeAtomic(this.taskFile(userId, chatId), json(task));
  }

  loadConfig(userId: string): Promise<unknown | null> {
    return readJson(path.join(this.root(userId), "config.json"));
  }

  saveConfig(userId: string, config: LLMConfig): Promise<void> {
    return writeAtomic(path.join(this.root(userId), "config.json"), json(config));
  }
}

/** Every memory file under `dir`, tolerant of unreadable or corrupt files. */
async function walkMemories(dir: string): Promise<MemoryRecord[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const hits: MemoryRecord[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      hits.push(...(await walkMemories(full)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    try {
      const parsed = parseMemoryFile(await readFile(full, "utf8"), entry.name.slice(0, -3));
      if (!parsed) throw new Error("unrecognized frontmatter");
      hits.push(parsed);
    } catch (err) {
      console.warn(`[memory] skipping unreadable file ${full}: ${String(err)}`);
    }
  }
  return hits;
}
