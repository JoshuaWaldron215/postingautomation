"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Activity, CalendarDays, Film, Home, Settings, Users, BarChart3 } from "lucide-react";
import { cn } from "../ui/cn";

const ITEMS = [
  { href: "/today", label: "Today", icon: Home, scoped: true },
  { href: "/content", label: "Content", icon: Film, scoped: true },
  { href: "/accounts", label: "Accounts", icon: Users, scoped: true },
  { href: "/schedule", label: "Schedule", icon: CalendarDays, scoped: true },
  { href: "/results", label: "Results", icon: BarChart3, scoped: true },
  { href: "/activity", label: "Activity", icon: Activity, scoped: true },
];

export function Nav({ attention, orientation = "vertical" }: { attention: number; orientation?: "vertical" | "horizontal" }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const scope = params.get("scope");
  const href = (base: string, scoped: boolean) => (scoped && scope ? `${base}?scope=${scope}` : base);
  return (
    <nav aria-label="Main" className={cn(orientation === "vertical" ? "flex flex-col gap-0.5" : "flex items-stretch justify-around")}>
      {ITEMS.map((it) => {
        const active = pathname === it.href || pathname.startsWith(`${it.href}/`);
        const Icon = it.icon;
        return (
          <Link
            key={it.href}
            href={href(it.href, it.scoped)}
            aria-current={active ? "page" : undefined}
            className={cn(
              orientation === "vertical" ? "flex h-9 items-center gap-2.5 rounded-[8px] px-2.5 text-[13.5px] font-medium" : "flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium",
              active ? "bg-surface text-ink shadow-[0_1px_2px_rgba(31,27,22,0.08)]" : "text-ink-2 hover:bg-surface-3 hover:text-ink",
            )}
          >
            <Icon size={orientation === "vertical" ? 16 : 20} className={active ? "text-accent" : "text-ink-3"} />
            <span>{it.label}</span>
            {it.href === "/today" && attention > 0 ? <span className={cn("tabular ml-auto rounded-full bg-danger-soft px-1.5 text-[11px] font-semibold text-danger", orientation === "horizontal" && "absolute translate-x-4 -translate-y-6")}>{attention}</span> : null}
          </Link>
        );
      })}
      {orientation === "vertical" ? (
        <Link href="/settings" aria-current={pathname.startsWith("/settings") ? "page" : undefined} className={cn("mt-2 flex h-9 items-center gap-2.5 rounded-[8px] px-2.5 text-[13.5px] font-medium", pathname.startsWith("/settings") ? "bg-surface text-ink shadow-[0_1px_2px_rgba(31,27,22,0.08)]" : "text-ink-2 hover:bg-surface-3 hover:text-ink")}>
          <Settings size={16} className={pathname.startsWith("/settings") ? "text-accent" : "text-ink-3"} />
          Settings
        </Link>
      ) : (
        <Link href="/settings" className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-ink-2">
          <Settings size={20} className="text-ink-3" />
          Settings
        </Link>
      )}
    </nav>
  );
}
