import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

function appSecret(): Buffer {
  const raw = process.env.APP_SECRET;
  if (!raw || raw.length < 16) {
    if (process.env.NODE_ENV === "production") throw new Error("APP_SECRET must be set to a long random value in production.");
    return createHash("sha256").update("synthos-dev-insecure-secret").digest();
  }
  return createHash("sha256").update(raw).digest();
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, saltB64, hashB64] = stored.split("$");
  if (algo !== "scrypt" || !saltB64 || !hashB64) return false;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const actual = scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(actual, expected);
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Worker tokens look like `wk_<prefix>.<secret>`. Only the hash of the secret is stored. */
export function issueWorkerToken(): { token: string; prefix: string; hash: string } {
  const prefix = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const token = `wk_${prefix}.${secret}`;
  return { token, prefix, hash: sha256Hex(secret) };
}

export function parseWorkerToken(token: string): { prefix: string; secretHash: string } | null {
  const m = /^wk_([0-9a-f]{12})\.([A-Za-z0-9_-]{20,})$/.exec(token.trim());
  if (!m) return null;
  return { prefix: m[1]!, secretHash: sha256Hex(m[2]!) };
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** AES-256-GCM with the app secret. Used for channel secrets (Discord webhook URLs). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", appSecret(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${enc.toString("base64url")}.${tag.toString("base64url")}`;
}

export function decryptSecret(stored: string): string {
  const [v, ivB, encB, tagB] = stored.split(".");
  if (v !== "v1" || !ivB || !encB || !tagB) throw new Error("Unrecognized secret format");
  const decipher = createDecipheriv("aes-256-gcm", appSecret(), Buffer.from(ivB, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encB, "base64url")), decipher.final()]).toString("utf8");
}

/** Short-lived signed access tokens for private media/evidence. */
export function signAccess(payload: Record<string, string | number>, ttlSeconds: number): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = Buffer.from(JSON.stringify({ ...payload, exp })).toString("base64url");
  const sig = createHmac("sha256", appSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyAccess<T extends Record<string, unknown>>(token: string): (T & { exp: number }) | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", appSecret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp: number };
    if (typeof parsed.exp !== "number" || parsed.exp < Date.now() / 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}
