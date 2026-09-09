import { content } from "@synthos/core";
import { json, withUser } from "@/lib/api";

export const POST = withUser(async (ctx, req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const offset = Number(new URL(req.url).searchParams.get("offset") ?? "0");
  const chunk = Buffer.from(await req.arrayBuffer());
  return json(await content.appendUploadChunk(ctx, id, offset, chunk));
});
