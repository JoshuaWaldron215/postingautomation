import { media } from "@synthos/core";
import { errorResponse, withWorker } from "@/lib/api";
import { Readable } from "node:stream";

/** Media download for a claimed job. Requires both the worker token and a short-lived signed media token. */
export const GET = withWorker(async (ctx, _worker, _req, { params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params;
  const claim = media.verifyMediaToken(token);
  if (!claim || claim.o !== ctx.orgId || claim.k !== "asset") return new Response("Forbidden", { status: 403 });
  try {
    const st = await media.statKey(claim.key);
    if (!st) return new Response("Not found", { status: 404 });
    const stream = Readable.toWeb(media.readStreamKey(claim.key)) as ReadableStream;
    return new Response(stream, { headers: { "content-type": "application/octet-stream", "content-length": String(st.size), "cache-control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
});
