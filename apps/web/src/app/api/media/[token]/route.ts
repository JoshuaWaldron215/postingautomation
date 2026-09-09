import { Readable } from "node:stream";
import { media } from "@synthos/core";
import { getCurrentUser } from "@/lib/session";

/** Private media for the dashboard: requires a signed-in user of the same org plus a short-lived token. */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { token } = await params;
  const claim = media.verifyMediaToken(token);
  if (!claim || claim.o !== user.orgId) return new Response("Forbidden", { status: 403 });
  const st = await media.statKey(claim.key);
  if (!st) return new Response("Not found", { status: 404 });
  const type = claim.k === "thumb" ? "image/jpeg" : claim.k === "evidence" ? (claim.key.endsWith(".png") ? "image/png" : claim.key.endsWith(".jpg") ? "image/jpeg" : "text/plain; charset=utf-8") : "video/mp4";
  const range = _req.headers.get("range");
  if (range && claim.k === "asset") {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(m?.[1] ?? 0);
    const end = m?.[2] ? Number(m[2]) : Math.min(st.size - 1, start + 4 * 1024 * 1024);
    const fs = await import("node:fs");
    const stream = Readable.toWeb(fs.createReadStream(media.resolveKey(claim.key), { start, end })) as ReadableStream;
    return new Response(stream, { status: 206, headers: { "content-type": type, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": String(end - start + 1), "accept-ranges": "bytes", "cache-control": "private, max-age=300" } });
  }
  const stream = Readable.toWeb(media.readStreamKey(claim.key)) as ReadableStream;
  return new Response(stream, { headers: { "content-type": type, "content-length": String(st.size), "accept-ranges": "bytes", "cache-control": "private, max-age=300", "x-content-type-options": "nosniff", "content-disposition": "inline" } });
}
