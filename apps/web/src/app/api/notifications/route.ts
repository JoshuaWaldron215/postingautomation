import { notificationsService } from "@synthos/core";
import { json, withUser } from "@/lib/api";

export const GET = withUser(async (ctx, req: Request) => {
  const url = new URL(req.url);
  const rows = await notificationsService.listNotifications(ctx, { unresolvedOnly: url.searchParams.get("unresolved") === "1", limit: 40 });
  const unread = rows.filter((r) => !r.readAt).length;
  return json({ notifications: rows, unread });
});
