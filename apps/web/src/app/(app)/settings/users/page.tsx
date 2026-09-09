import { auth, accountsService } from "@synthos/core";
import { getUserCtx } from "@/lib/session";
import { UsersView } from "@/components/settings/users-view";
import { Card } from "@/components/common/page-header";
export const metadata = { title: "People" };
export default async function UsersPage() {
  const ctx = await getUserCtx();
  if (ctx.user.role !== "owner") return <Card><p className="p-4 text-[13px] text-ink-3">Only owners can manage people and roles. You are signed in as {ctx.user.name} ({ctx.user.role}).</p></Card>;
  const [users, creators] = await Promise.all([auth.listUsers(ctx), accountsService.listCreators(ctx)]);
  return <UsersView users={users.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, creatorScope: u.creatorScope ?? [], createdAt: u.createdAt.toISOString() }))} creators={creators.map((c) => ({ id: c.id, name: c.name }))} meId={ctx.user.id} />;
}
