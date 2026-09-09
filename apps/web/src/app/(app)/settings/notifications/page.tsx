import { notificationsService } from "@synthos/core";
import { getUserCtx } from "@/lib/session";
import { ChannelsView } from "@/components/settings/channels-view";
export const metadata = { title: "Notifications" };
export default async function NotificationsSettingsPage() {
  const ctx = await getUserCtx();
  const channels = ctx.user.role === "viewer" ? [] : await notificationsService.listChannels(ctx);
  return <ChannelsView channels={channels.map((c) => ({ id: c.id, name: c.name, destinationLabel: c.destinationLabel, enabled: c.enabled, verifiedAt: c.verifiedAt?.toISOString() ?? null, lastTestAt: c.lastTestAt?.toISOString() ?? null, lastTestResult: c.lastTestResult, settings: c.settings }))} role={ctx.user.role} />;
}
