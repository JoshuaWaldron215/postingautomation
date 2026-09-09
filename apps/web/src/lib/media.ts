import "server-only";
import { media } from "@synthos/core";

export function thumbUrl(orgId: string, key: string | null | undefined): string | null {
  if (!key) return null;
  return `/api/media/${media.mediaToken(orgId, "thumb", key, 3600)}`;
}
export function assetUrl(orgId: string, key: string | null | undefined): string | null {
  if (!key) return null;
  return `/api/media/${media.mediaToken(orgId, "asset", key, 3600)}`;
}
export function evidenceUrl(orgId: string, key: string | null | undefined): string | null {
  if (!key) return null;
  return `/api/media/${media.mediaToken(orgId, "evidence", key, 3600)}`;
}
