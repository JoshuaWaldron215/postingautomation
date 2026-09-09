import { getUserCtx } from "@/lib/session";
import { RulesForm } from "@/components/settings/rules-form";
export const metadata = { title: "Settings" };
export default async function SettingsPage() {
  const ctx = await getUserCtx();
  return <RulesForm settings={ctx.settings} role={ctx.user.role} />;
}
