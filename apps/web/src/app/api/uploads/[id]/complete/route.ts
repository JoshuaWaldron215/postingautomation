import { content } from "@synthos/core";
import { json, withUser } from "@/lib/api";

export const POST = withUser(async (ctx, req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { creatorId?: string | null; caption?: string; tags?: string[] };
  const r = await content.completeUpload(ctx, id, body);
  return json({ asset: r.asset, duplicateOf: r.duplicateOf ? { id: r.duplicateOf.id, originalFilename: r.duplicateOf.originalFilename } : null });
});
