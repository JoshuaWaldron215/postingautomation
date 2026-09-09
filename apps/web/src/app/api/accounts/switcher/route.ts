import { accountsService } from "@synthos/core";
import { json, withUser } from "@/lib/api";

export const GET = withUser(async (ctx) => {
  const rows = await accountsService.listAccounts(ctx, { sort: "handle" });
  const creators = await accountsService.listCreators(ctx);
  const pinned = (ctx as unknown as { user: { preferences: { pinnedAccountIds: string[] } } }).user.preferences.pinnedAccountIds;
  return json({
    accounts: rows.map((a) => ({ id: a.id, handle: a.handle, displayName: a.displayName, creatorId: a.creatorId, creatorName: a.creatorName, avatarColor: a.avatarColor, state: a.effectiveState, needsAttention: a.needsAttention, pinned: pinned.includes(a.id) })),
    creators: creators.map((c) => ({ id: c.id, name: c.name, color: c.color, accountCount: c.accountCount, paused: Boolean(c.pausedAt) })),
  });
});
