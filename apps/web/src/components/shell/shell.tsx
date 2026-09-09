"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Clock, LogOut } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { Nav } from "./nav";
import { ScopeBar, type SwitcherAccount, type SwitcherCreator } from "./scope-bar";
import { NotificationsButton } from "./notifications";
import { GlobalPauseControl } from "./global-pause";
import { DirtyGuardProvider } from "./dirty-guard";
import { ToastProvider, useToast } from "../ui/toast";
import { Button } from "../ui/button";
import { advanceClockAction } from "@/actions/org";
import { cn } from "../ui/cn";

export type ShellProps = {
  user: { name: string; email: string; role: string };
  demoMode: boolean;
  simOffsetMs: number;
  globalPause: { active: boolean; reason?: string };
  attention: number;
  accounts: SwitcherAccount[];
  creators: SwitcherCreator[];
  children: React.ReactNode;
};

export function Shell(props: ShellProps) {
  return (
    <ToastProvider>
      <DirtyGuardProvider>
        <ShellInner {...props} />
      </DirtyGuardProvider>
    </ToastProvider>
  );
}

function ShellInner({ user, demoMode, simOffsetMs, globalPause, attention, accounts, creators, children }: ShellProps) {
  const canControl = user.role === "owner";
  const canResolve = user.role !== "viewer";
  return (
    <div className="flex min-h-full">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[80] focus:rounded focus:bg-surface focus:px-3 focus:py-2 focus:shadow-pop">Skip to content</a>
      <aside className="sticky top-0 hidden h-screen w-[212px] shrink-0 flex-col border-r border-line bg-canvas px-3 py-4 md:flex">
        <Link href="/today" className="mb-5 flex items-center gap-2 px-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-ink text-[13px] font-bold text-canvas">S</span>
          <span className="leading-tight">
            <span className="block text-[13.5px] font-semibold tracking-tight text-ink">Synthos posting</span>
            <span className="block text-[11px] text-ink-3">MAP Agency</span>
          </span>
        </Link>
        <Nav attention={attention} />
        <div className="mt-auto space-y-2 px-1">
          {demoMode ? <DemoBadge simOffsetMs={simOffsetMs} canAdvance={canResolve} /> : null}
          <UserMenu user={user} />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-canvas/85 px-3 backdrop-blur md:px-5">
          <Link href="/today" className="mr-1 flex h-7 w-7 items-center justify-center rounded-[7px] bg-ink text-[13px] font-bold text-canvas md:hidden" aria-label="Synthos posting home">S</Link>
          <ScopeBar accounts={accounts} creators={creators} />
          <div className="ml-auto flex items-center gap-1.5">
            {demoMode ? <span className="hidden items-center rounded-full border border-warn/40 bg-warn-soft px-2.5 py-0.5 text-[11px] font-semibold text-warn sm:inline-flex">Demo data</span> : null}
            <GlobalPauseControl active={globalPause.active} reason={globalPause.reason} canControl={canControl} />
            <NotificationsButton canResolve={canResolve} />
            <div className="md:hidden"><UserMenu user={user} compact /></div>
          </div>
        </header>
        <main id="main" className="min-w-0 flex-1 px-3 pb-24 pt-4 md:px-6 md:pb-8">
          {demoMode ? <p className="mb-3 rounded-md border border-warn/30 bg-warn-soft px-3 py-1.5 text-[12px] text-warn sm:hidden">Demo data · nothing here is live Instagram activity</p> : null}
          {children}
        </main>
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-canvas/95 backdrop-blur md:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
          <Nav attention={attention} orientation="horizontal" />
        </div>
      </div>
    </div>
  );
}

function DemoBadge({ simOffsetMs, canAdvance }: { simOffsetMs: number; canAdvance: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const hrs = Math.round(simOffsetMs / 3600000 * 10) / 10;
  const advance = async (ms: number) => {
    setBusy(true);
    const r = await advanceClockAction(ms);
    setBusy(false);
    if (!r.ok) return toast.push({ tone: "danger", title: r.error });
    toast.push({ tone: "info", title: ms === 0 ? "Simulated clock reset" : `Simulated clock moved ${Math.round(ms / 3600000)}h forward`, body: "This is simulated time for demos, not real elapsed time." });
    router.refresh();
  };
  return (
    <div className="rounded-md border border-warn/40 bg-warn-soft p-2.5">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-warn">Demo data</p>
      <p className="mt-0.5 text-[11.5px] leading-snug text-ink-2">Synthetic accounts and simulated posting. Nothing here is live.</p>
      {canAdvance ? (
        <div className="mt-2">
          <p className="flex items-center gap-1 text-[11px] text-ink-3"><Clock size={11} /> Simulated clock {hrs ? `+${hrs}h` : "= real time"}</p>
          <div className="mt-1 flex gap-1">
            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" loading={busy} onClick={() => void advance(10 * 3600000)}>+10h</Button>
            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={busy} onClick={() => void advance(3600000)}>+1h</Button>
            {hrs ? <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={busy} onClick={() => void advance(0)}>Reset</Button> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function UserMenu({ user, compact }: { user: ShellProps["user"]; compact?: boolean }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className={cn("flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-left hover:bg-surface-3", compact ? "" : "w-full")} aria-label="Account menu">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent-ink">{user.name.slice(0, 1)}</span>
          {!compact ? (
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-[13px] font-medium text-ink">{user.name}</span>
              <span className="block truncate text-[11px] capitalize text-ink-3">{user.role}</span>
            </span>
          ) : null}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-[200px] rounded-md bg-surface p-1 shadow-pop">
          <div className="px-2 py-1.5 text-[12px] text-ink-3">{user.email}</div>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item asChild>
            <Link href="/settings" className="flex cursor-pointer items-center rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-surface-3">Settings</Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild>
            <form action="/api/auth/logout" method="post">
              <button type="submit" className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm outline-none data-[highlighted]:bg-surface-3"><LogOut size={14} /> Sign out</button>
            </form>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
