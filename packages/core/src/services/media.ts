/**
 * Private media storage on the local filesystem (STORAGE_DIR). Nothing here is served
 * statically; the dashboard hands out short-lived signed tokens instead.
 * Keys are relative paths that are validated against traversal.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { storageDir } from "../lib/env";
import { signAccess, verifyAccess } from "../lib/crypto";
import { validation } from "../lib/errors";

const execFileP = promisify(execFile);
const require = createRequire(import.meta.url);

export function ffmpegPath(): string {
  const p = require("ffmpeg-static") as string;
  if (!p) throw new Error("ffmpeg binary not available");
  return p;
}
export function ffprobePath(): string {
  return (require("ffprobe-static") as { path: string }).path;
}

const SAFE_KEY = /^[a-z0-9_\-/.]+$/i;
export function resolveKey(key: string): string {
  if (!SAFE_KEY.test(key) || key.includes("..") || key.startsWith("/")) throw validation("Invalid storage key.");
  return path.join(storageDir(), key);
}

export async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeFileKey(key: string, data: Buffer | NodeJS.ReadableStream): Promise<void> {
  const full = resolveKey(key);
  await ensureDir(path.dirname(full));
  if (Buffer.isBuffer(data)) await fs.writeFile(full, data);
  else await fs.writeFile(full, data as never);
}

export async function appendFileKey(key: string, data: Buffer): Promise<number> {
  const full = resolveKey(key);
  await ensureDir(path.dirname(full));
  await fs.appendFile(full, data);
  const st = await fs.stat(full);
  return st.size;
}

export async function statKey(key: string): Promise<{ size: number } | null> {
  try {
    const st = await fs.stat(resolveKey(key));
    return { size: st.size };
  } catch {
    return null;
  }
}

export async function moveKey(from: string, to: string): Promise<void> {
  const dest = resolveKey(to);
  await ensureDir(path.dirname(dest));
  await fs.rename(resolveKey(from), dest);
}

export async function deleteKey(key: string): Promise<void> {
  await fs.rm(resolveKey(key), { force: true });
}

export function readStreamKey(key: string) {
  return createReadStream(resolveKey(key));
}

export async function sha256OfKey(key: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(resolveKey(key))
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return hash.digest("hex");
}

export type ProbeResult = {
  ok: true;
  durationSeconds: number;
  width: number;
  height: number;
  codec: string;
  container: string;
  hasAudio: boolean;
} | { ok: false; error: string };

/** Uses ffprobe to determine whether the file is a decodable video. Extensions are never trusted. */
export async function probeVideo(key: string): Promise<ProbeResult> {
  const full = resolveKey(key);
  try {
    const { stdout } = await execFileP(
      ffprobePath(),
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", full],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const json = JSON.parse(stdout) as {
      format?: { format_name?: string; duration?: string };
      streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string }>;
    };
    const video = json.streams?.find((s) => s.codec_type === "video");
    if (!video || !video.width || !video.height) return { ok: false, error: "No decodable video stream was found in this file." };
    const duration = Number(json.format?.duration ?? video.duration ?? 0);
    if (!Number.isFinite(duration) || duration <= 0) return { ok: false, error: "Could not determine the video duration." };
    return {
      ok: true,
      durationSeconds: duration,
      width: video.width,
      height: video.height,
      codec: video.codec_name ?? "unknown",
      container: json.format?.format_name ?? "unknown",
      hasAudio: Boolean(json.streams?.some((s) => s.codec_type === "audio")),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Invalid data|moov atom|EBML|not found/i.test(msg)) return { ok: false, error: "This file is not a readable video." };
    return { ok: false, error: "This file could not be read as a video." };
  }
}

/** Extracts a poster frame (JPEG, capped at 720px tall) with bounded CPU/time. */
export async function generateThumbnail(sourceKey: string, targetKey: string, atSeconds = 1): Promise<boolean> {
  const src = resolveKey(sourceKey);
  const dst = resolveKey(targetKey);
  await ensureDir(path.dirname(dst));
  try {
    await execFileP(
      ffmpegPath(),
      ["-y", "-v", "error", "-threads", "1", "-ss", String(atSeconds), "-i", src, "-frames:v", "1", "-vf", "scale=-2:720", "-q:v", "4", dst],
      { timeout: 30_000 },
    );
    return true;
  } catch {
    try {
      await execFileP(ffmpegPath(), ["-y", "-v", "error", "-threads", "1", "-i", src, "-frames:v", "1", "-vf", "scale=-2:720", "-q:v", "4", dst], { timeout: 30_000 });
      return true;
    } catch {
      return false;
    }
  }
}

export const ACCEPTED_VIDEO_MIME = new Set(["video/mp4", "video/quicktime", "video/webm", "video/x-m4v", "application/octet-stream"]);
export const ACCEPTED_CONTAINERS = /(mp4|mov|m4a|3gp|matroska|webm)/i;

/** Signed, short-lived tokens for private media. */
export function mediaToken(orgId: string, kind: "asset" | "thumb" | "evidence", key: string, ttlSeconds = 600): string {
  return signAccess({ o: orgId, k: kind, key }, ttlSeconds);
}
export function verifyMediaToken(token: string): { o: string; k: "asset" | "thumb" | "evidence"; key: string } | null {
  return verifyAccess<{ o: string; k: "asset" | "thumb" | "evidence"; key: string }>(token);
}
