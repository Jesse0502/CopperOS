// What a person writes to CopperOS is encrypted before it is stored in AWS:
// their chats and what each task is doing, the titles and questions in their
// chat list, the facts it remembers and the workflows they save.
//
// AES-256-GCM, with a key of its own for every account: HKDF of one secret
// that lives in Parameter Store (a SecureString, itself under AWS's KMS key)
// and the account's id. The secret never sits beside the data, and one
// account's key opens none of another's. Each record also binds in where it
// belongs (the account and what it is), so a record copied to another account,
// or into another field, will not open.
//
// This is encryption at rest on top of what AWS already does to every table and
// bucket. It is not end-to-end: the service has to read a chat to run a task
// in it, so the service holds the key. What it keeps out of reach is the stored
// data on its own: a copy of the database, a bucket, a backup.
//
// Records written before this existed are plain text and are read as they are,
// until they are saved again (or `npm run admin -- encrypt`).
//
//   enc1:<base64: 12-byte IV, 16-byte tag, ciphertext>

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

const MARK = "enc1:";
const SALT_INFO = Buffer.from("copperos content v1");

/** Whether `value` is something this module sealed. */
export const isSealed = (value: unknown): value is string => typeof value === "string" && value.startsWith(MARK);

// ── the secret ───────────────────────────────────────────────────────────────

let secret: Promise<Buffer> | null = null;

/**
 * The 32-byte secret everything is derived from. Made once per stage:
 *   aws ssm put-parameter --name /copperos/<stage>/user-keys-secret --type SecureString --value "$(openssl rand -base64 32)"
 * (the same one that seals users' API keys). USER_KEYS_SECRET (base64), if set, is used instead.
 */
export function masterKey(): Promise<Buffer> {
  if (!secret) {
    secret = (async () => {
      const direct = process.env.USER_KEYS_SECRET;
      const name = process.env.USER_KEYS_PARAM;
      let b64 = direct;
      if (!b64) {
        if (!name) throw new Error("USER_KEYS_PARAM is not set");
        b64 = (await new SSMClient({}).send(new GetParameterCommand({ Name: name, WithDecryption: true }))).Parameter?.Value;
      }
      const key = Buffer.from(b64 ?? "", "base64");
      if (key.length !== 32) throw new Error(`${direct ? "USER_KEYS_SECRET" : name} must hold 32 random bytes, base64`);
      return key;
    })();
    // A failed fetch is tried again on the next call, not remembered.
    secret.catch(() => (secret = null));
  }
  return secret;
}

// ── an account's key ─────────────────────────────────────────────────────────

// Derived once per account and kept for the life of the Lambda, which is short.
const accountKeys = new Map<string, Buffer>();
const KEEP_KEYS = 500;

async function keyFor(userId: string): Promise<Buffer> {
  let key = accountKeys.get(userId);
  if (key) return key;
  key = Buffer.from(hkdfSync("sha256", await masterKey(), Buffer.from(userId, "utf8"), SALT_INFO, 32));
  if (accountKeys.size >= KEEP_KEYS) accountKeys.delete(accountKeys.keys().next().value!);
  accountKeys.set(userId, key);
  return key;
}

const boundTo = (userId: string, what: string) => Buffer.from(`${userId}\n${what}`, "utf8");

// ── sealing ──────────────────────────────────────────────────────────────────

/** `plain`, encrypted for this account. `what` says where it belongs, e.g. "transcript:<chatId>". */
export async function seal(plain: string, userId: string, what: string): Promise<string> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await keyFor(userId), iv);
  cipher.setAAD(boundTo(userId, what));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return MARK + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

/** What `seal` made `sealed` from. Throws if it was altered, or belongs to someone or somewhere else. */
export async function unseal(sealed: string, userId: string, what: string): Promise<string> {
  const raw = Buffer.from(sealed.slice(MARK.length), "base64");
  if (raw.length < 28) throw new Error("a sealed record is cut short");
  const decipher = createDecipheriv("aes-256-gcm", await keyFor(userId), raw.subarray(0, 12));
  decipher.setAAD(boundTo(userId, what));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

export const sealJson = (value: unknown, userId: string, what: string) => seal(JSON.stringify(value), userId, what);

/** A stored value that may be sealed or, from before sealing, plain: its text either way. */
export async function textOf(stored: string | undefined, userId: string, what: string): Promise<string | undefined> {
  return isSealed(stored) ? unseal(stored, userId, what) : stored;
}
