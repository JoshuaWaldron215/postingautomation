import { redirect } from "next/navigation";
import { accountsService } from "@synthos/core";
import { Shell } from "@/components/shell/shell";
import { getCurrentUser, getUserCtx } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const ctx = await getUserCtx();
  const [accounts, creators] = await Promise.all([accountsService.listAccounts(ctx, { sort: "handle" }), accountsService.listCreators(ctx)]);
  const pinned = user.preferences.pinnedAccountIds;
  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      demoMode={ctx.settings.demoMode}
      simOffsetMs={ctx.settings.simClockOffsetMs}
      globalPause={{ active: ctx.settings.globalPause.active, reason: ctx.settings.globalPause.reason }}
      attention={accounts.filter((a) => a.needsAttention).length}
      accounts={accounts.map((a) => ({ id: a.id, handle: a.handle, displayName: a.displayName, creatorId: a.creatorId, creatorName: a.creatorName, avatarColor: a.avatarColor, state: a.effectiveState, needsAttention: a.needsAttention, pinned: pinned.includes(a.id) }))}
      creators={creators.map((c) => ({ id: c.id, name: c.name, color: c.color, accountCount: c.accountCount, paused: Boolean(c.pausedAt) }))}
    >
      {children}
    </Shell>
  );
}
