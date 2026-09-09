export type Scope = { kind: "all" } | { kind: "creator"; creatorId: string } | { kind: "account"; accountId: string };

export function parseScope(raw: string | string[] | undefined): Scope {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || v === "all") return { kind: "all" };
  const [kind, id] = v.split(":");
  if (kind === "creator" && id) return { kind: "creator", creatorId: id };
  if (kind === "account" && id) return { kind: "account", accountId: id };
  return { kind: "all" };
}

export function scopeParam(scope: Scope): string {
  if (scope.kind === "creator") return `creator:${scope.creatorId}`;
  if (scope.kind === "account") return `account:${scope.accountId}`;
  return "all";
}

export function withScope(path: string, scope: Scope, extra: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams();
  if (scope.kind !== "all") params.set("scope", scopeParam(scope));
  for (const [k, v] of Object.entries(extra)) if (v) params.set(k, v);
  const q = params.toString();
  return q ? `${path}?${q}` : path;
}
