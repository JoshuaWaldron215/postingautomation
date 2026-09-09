import { SettingsNav } from "@/components/settings/settings-nav";
import { PageHeader } from "@/components/common/page-header";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader title="Settings" description="Workers, notification destinations, people and operating rules." />
      <div className="grid gap-4 md:grid-cols-[180px_1fr]">
        <SettingsNav />
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
