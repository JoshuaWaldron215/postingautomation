import fs from "node:fs";
import path from "node:path";

let _root: string | undefined;
/** Repository root (directory containing pnpm-workspace.yaml), so relative paths behave the same from every package. */
export function repoRoot(): string {
  if (_root) return _root;
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return (_root = dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return (_root = process.cwd());
}

/** Minimal .env loader (no dependency). Does not override variables already set. */
export function loadDotEnv(file = path.join(repoRoot(), ".env")): void {
  try {
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith("#")) continue;
      const key = m[1]!;
      let value = m[2]!;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    /* no .env file */
  }
}

export function storageDir(): string {
  const raw = process.env.STORAGE_DIR ?? "./storage";
  return path.resolve(repoRoot(), raw);
}
export function isDemoMode(): boolean {
  return (process.env.DEMO_MODE ?? "true").toLowerCase() !== "false";
}
export function maxUploadBytes(): number {
  return Number(process.env.MAX_UPLOAD_BYTES ?? 1024 * 1024 * 1024);
}
export function workerOfflineAfterMs(): number {
  return Number(process.env.WORKER_OFFLINE_AFTER_MS ?? 90_000);
}
