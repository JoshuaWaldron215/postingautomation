import { content } from "@synthos/core";
import { json, withUser } from "@/lib/api";

export const POST = withUser(async (ctx, req: Request) => {
  const body = (await req.json()) as { filename: string; mime: string; sizeBytes: number };
  return json(await content.startUpload(ctx, body));
});
