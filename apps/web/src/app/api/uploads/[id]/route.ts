import { content } from "@synthos/core";
import { json, withUser } from "@/lib/api";

export const GET = withUser(async (ctx, _req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  return json(await content.uploadStatus(ctx, id));
});
