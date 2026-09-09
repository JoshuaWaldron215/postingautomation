import { media } from "@synthos/core";
import { json, withWorker } from "@/lib/api";

const MAX_EVIDENCE = 8 * 1024 * 1024;

/** Evidence upload (screenshots / text). Stored privately; access only through signed tokens. */
export const POST = withWorker(async (ctx, _worker, req) => {
  const url = new URL(req.url);
  const name = (url.searchParams.get("name") ?? "evidence").replace(/[^a-z0-9_.-]/gi, "_").slice(0, 80);
  const jobId = url.searchParams.get("jobId");
  const analyticsJobId = url.searchParams.get("analyticsJobId");
  const mime = req.headers.get("content-type") ?? "application/octet-stream";
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length === 0 || buf.length > MAX_EVIDENCE) return json({ error: { code: "validation", message: "Evidence must be between 1 byte and 8 MB." } }, { status: 400 });
  const ext = mime.startsWith("image/png") ? "png" : mime.startsWith("image/jpeg") ? "jpg" : "txt";
  const key = `evidence/${ctx.orgId}/${jobId ?? analyticsJobId ?? "misc"}/${Date.now()}-${name}.${ext}`;
  await media.writeFileKey(key, buf);
  return json({ key });
});
