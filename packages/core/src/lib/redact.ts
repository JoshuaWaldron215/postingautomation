/** Redacts secrets from strings/objects before they are persisted in logs or audit metadata. */
const SECRET_KEY = /(password|passwd|secret|token|cookie|session|authorization|webhook|api[-_]?key|private)/i;
const SECRET_VALUE = /(wk_[0-9a-f]{12}\.[A-Za-z0-9_-]+|discord(?:app)?\.com\/api\/webhooks\/\S+|sessionid=\S+|Bearer\s+\S+)/gi;

export function redactString(s: string): string {
  return s.replace(SECRET_VALUE, "[redacted]");
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 6) return "[truncated]" as T;
  if (typeof value === "string") return redactString(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
