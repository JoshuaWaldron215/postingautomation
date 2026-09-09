"use client";
import * as React from "react";
import Link from "next/link";
import { Bell, Check } from "lucide-react";
import { Popover } from "radix-ui";
import useSWR from "swr";
import { Button } from "../ui/button";
import { Badge, type Tone } from "../ui/badge";
import { relTime } from "@/lib/format";
import { markNotificationsRead, resolveNotificationAction } from "@/actions/notifications";
import { cn } from "../ui/cn";

type N = { id: string; kind: string; severity: "info" | "warning" | "critical"; title: string; body: string; createdAt: string; readAt: string | null; resolvedAt: string | null; data: Record<string, unknown> };
const fetcher = (u: string) => fetch(u).then((r) => r.json());
const SEV_TONE: Record<string, Tone> = { info: "ok", warning: "warn", critical: "danger" };

export function NotificationsButton({ canResolve }: { canResolve: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [tab, setTab] = React.useState<"open" | "all">("open");
  const { data, mutate } = useSWR<{ notifications: N[]; unread: number }>(`/api/notifications?unresolved=${tab === "open" ? 1 : 0}`, fetcher, { refreshInterval: 20000 });
  const items = data?.notifications ?? [];
  const unread = data?.unread ?? 0;
  const onOpenChange = (o: boolean) => {
    setOpen(o);
    if (o && unread > 0) {
      const ids = items.filter((n) => !n.readAt).map((n) => n.id);
      if (ids.length) void markNotificationsRead(ids).then(() => mutate());
    }
  };
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} className="relative">
          <Bell size={17} />
          {unread > 0 ? <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">{unread > 99 ? "99+" : unread}</span> : null}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="z-50 w-[min(420px,calc(100vw-1.5rem))] overflow-hidden rounded-lg bg-surface shadow-pop">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <div className="flex items-center gap-1 text-[13px]">
              <button className={cn("rounded px-2 py-1 font-medium", tab === "open" ? "bg-surface-3 text-ink" : "text-ink-3")} onClick={() => setTab("open")}>Open</button>
              <button className={cn("rounded px-2 py-1 font-medium", tab === "all" ? "bg-surface-3 text-ink" : "text-ink-3")} onClick={() => setTab("all")}>Recent</button>
            </div>
            <Link href="/activity?humanOnly=0" className="text-[12px] text-accent hover:underline" onClick={() => setOpen(false)}>Activity log</Link>
          </div>
          <ul className="scroll-thin max-h-[min(70vh,520px)] overflow-y-auto">
            {items.length === 0 ? <li className="px-4 py-8 text-center text-sm text-ink-3">{tab === "open" ? "Nothing open. Good." : "No notifications yet."}</li> : null}
            {items.map((n) => (
              <li key={n.id} className={cn("border-b border-line px-3 py-2.5 last:border-0", !n.readAt && "bg-accent-soft/40")}>
                <div className="flex items-start gap-2">
                  <Badge tone={SEV_TONE[n.severity]} dot className="mt-0.5 shrink-0">{n.severity === "info" ? "Info" : n.severity === "warning" ? "Warning" : "Action"}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium leading-snug text-ink">{n.title}</p>
                    <p className="mt-0.5 line-clamp-2 text-[12px] text-ink-3">{n.body}</p>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-4">
                      <span>{relTime(n.createdAt)}</span>
                      {typeof n.data?.url === "string" ? <Link href={n.data.url} className="text-accent hover:underline" onClick={() => setOpen(false)}>Open</Link> : null}
                      {n.resolvedAt ? <span>· resolved</span> : canResolve && n.severity !== "info" ? (
                        <button className="inline-flex items-center gap-0.5 text-ink-3 hover:text-ink" onClick={() => void resolveNotificationAction(n.id).then(() => mutate())}>
                          <Check size={11} /> Resolve
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
