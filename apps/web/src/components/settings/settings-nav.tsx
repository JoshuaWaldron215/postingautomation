"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "../ui/cn";
const ITEMS = [["/settings", "Operating rules"], ["/settings/workers", "Workers"], ["/settings/notifications", "Notifications"], ["/settings/users", "People & roles"]];
export function SettingsNav() {
  const p = usePathname();
  return (
    <nav aria-label="Settings" className="flex gap-1 overflow-x-auto md:flex-col">
      {ITEMS.map(([href, label]) => <Link key={href} href={href!} aria-current={p === href ? "page" : undefined} className={cn("whitespace-nowrap rounded-[8px] px-2.5 py-1.5 text-[13px] font-medium", p === href ? "bg-surface text-ink shadow-[0_1px_2px_rgba(31,27,22,0.08)]" : "text-ink-2 hover:bg-surface-3")}>{label}</Link>)}
    </nav>
  );
}
