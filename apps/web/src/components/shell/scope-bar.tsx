"use client";
import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, Pin, Search, AlertTriangle } from "lucide-react";
import { Command } from "cmdk";
import { Popover } from "radix-ui";
import { Avatar } from "../ui/avatar";
import { Badge, ACCOUNT_TONE } from "../ui/badge";
import { Kbd } from "../ui/kbd";
import { cn } from "../ui/cn";
import { useDirtyGuard } from "./dirty-guard";
import { ACCOUNT_STATE_LABEL } from "@synthos/core/lib/states";

export type SwitcherAccount = { id: string; handle: string; displayName: string; creatorId: string; creatorName: string; avatarColor: string; state: string; needsAttention: boolean; pinned: boolean };
export type SwitcherCreator = { id: string; name: string; color: string; accountCount: number; paused: boolean };

const SCOPED_PATHS = ["/today", "/schedule", "/results", "/content", "/activity", "/accounts"];

/**
 * Global scope selector + searchable account switcher (⌘K / Ctrl+K).
 * Scope is carried in the URL (?scope=all|creator:id|account:id) across Today, Schedule and Results.
 */
export function ScopeBar({ accounts, creators }: { accounts: SwitcherAccount[]; creators: SwitcherCreator[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const guard = useDirtyGuard();
  const [open, setOpen] = React.useState(false);
  const [attentionOnly, setAttentionOnly] = React.useState(false);
  const scope = params.get("scope") ?? "all";
  const [kind, id] = scope.split(":");
  const selectedAccount = kind === "account" ? accounts.find((a) => a.id === id) : undefined;
  const selectedCreator = kind === "creator" ? creators.find((c) => c.id === id) : undefined;

  const apply = React.useCallback(
    (next: string | null, opts: { openPanel?: string } = {}) => {
      const p = new URLSearchParams(params.toString());
      if (next && next !== "all") p.set("scope", next);
      else p.delete("scope");
      // Never let a stale record or bulk selection carry over into a different account.
      for (const k of ["account", "job", "asset", "campaign", "page", "post"]) p.delete(k);
      if (opts.openPanel) p.set("account", opts.openPanel);
      const base = SCOPED_PATHS.some((s) => pathname.startsWith(s)) ? pathname : "/today";
      const q = p.toString();
      guard.confirmLeave(() => router.push(q ? `${base}?${q}` : base));
    },
    [params, pathname, router, guard],
  );

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pinned = accounts.filter((a) => a.pinned);
  const attention = accounts.filter((a) => a.needsAttention);
  const list = attentionOnly ? attention : accounts;

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            className="flex h-9 min-w-0 max-w-[min(360px,60vw)] items-center gap-2 rounded-[8px] border border-line-strong bg-surface pl-2 pr-2.5 text-left text-sm hover:bg-surface-2"
            aria-label="Choose scope: all accounts, one creator or one account"
            aria-expanded={open}
          >
            {selectedAccount ? (
              <>
                <Avatar handle={selectedAccount.handle} color={selectedAccount.avatarColor} size={22} />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-ink">@{selectedAccount.handle}</span>
                  <span className="ml-1.5 hidden text-ink-3 sm:inline">{selectedAccount.creatorName}</span>
                </span>
              </>
            ) : selectedCreator ? (
              <>
                <span className="h-[22px] w-[22px] shrink-0 rounded-full" style={{ background: selectedCreator.color }} aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-ink">{selectedCreator.name}</span>
                  <span className="ml-1.5 hidden text-ink-3 sm:inline">{selectedCreator.accountCount} accounts</span>
                </span>
              </>
            ) : (
              <>
                <Search size={15} className="shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-ink">All accounts</span>
                  <span className="ml-1.5 hidden text-ink-3 sm:inline">{accounts.length}</span>
                </span>
              </>
            )}
            <span className="hidden shrink-0 items-center gap-1 sm:flex">
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
            </span>
            <ChevronDown size={14} className="shrink-0 text-ink-3" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={6} className="z-50 w-[min(520px,calc(100vw-1.5rem))] overflow-hidden rounded-lg bg-surface shadow-pop">
            <Command label="Switch account" loop filter={(value, search) => (value.toLowerCase().includes(search.toLowerCase().replace(/^@/, "")) ? 1 : 0)}>
              <div className="flex items-center gap-2 border-b border-line px-3">
                <Search size={15} className="text-ink-3" />
                <Command.Input autoFocus placeholder="Search @handle or creator…" className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-ink-4" />
                <button
                  type="button"
                  onClick={() => setAttentionOnly((v) => !v)}
                  aria-pressed={attentionOnly}
                  className={cn("inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2 text-[12px] font-medium", attentionOnly ? "border-danger bg-danger-soft text-danger" : "border-line-strong text-ink-2 hover:bg-surface-2")}
                >
                  <AlertTriangle size={12} /> Needs attention <span className="tabular">{attention.length}</span>
                </button>
              </div>
              <Command.List className="scroll-thin max-h-[min(60vh,440px)] overflow-y-auto p-1.5">
                <Command.Empty className="px-3 py-6 text-center text-sm text-ink-3">No accounts match.</Command.Empty>
                {!attentionOnly ? (
                  <Command.Group heading="Views" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-4">
                    <Item value="all accounts" onSelect={() => { setOpen(false); apply(null); }} active={scope === "all"}>
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-3 text-ink-3"><Search size={12} /></span>
                      <span className="flex-1">All accounts</span>
                      <span className="tabular text-[12px] text-ink-4">{accounts.length}</span>
                    </Item>
                    {creators.map((c) => (
                      <Item key={c.id} value={`creator ${c.name}`} onSelect={() => { setOpen(false); apply(`creator:${c.id}`); }} active={scope === `creator:${c.id}`}>
                        <span className="h-6 w-6 rounded-full" style={{ background: c.color }} aria-hidden />
                        <span className="flex-1 truncate">{c.name}</span>
                        {c.paused ? <Badge tone="neutral">Paused</Badge> : null}
                        <span className="tabular text-[12px] text-ink-4">{c.accountCount}</span>
                      </Item>
                    ))}
                  </Command.Group>
                ) : null}
                {pinned.length && !attentionOnly ? (
                  <Command.Group heading="Pinned" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-4">
                    {pinned.map((a) => (
                      <AccountItem key={`pin-${a.id}`} a={a} active={scope === `account:${a.id}`} onSelect={() => { setOpen(false); apply(`account:${a.id}`); }} />
                    ))}
                  </Command.Group>
                ) : null}
                <Command.Group heading={attentionOnly ? "Needs attention" : "Accounts"} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-4">
                  {list.map((a) => (
                    <AccountItem key={a.id} a={a} active={scope === `account:${a.id}`} onSelect={() => { setOpen(false); apply(`account:${a.id}`); }} />
                  ))}
                </Command.Group>
              </Command.List>
              <div className="flex items-center justify-between border-t border-line px-3 py-2 text-[11px] text-ink-4">
                <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> move <Kbd>↵</Kbd> open</span>
                <span>Scope applies to Today, Schedule and Results</span>
              </div>
            </Command>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

function Item({ value, onSelect, active, children }: { value: string; onSelect: () => void; active?: boolean; children: React.ReactNode }) {
  return (
    <Command.Item value={value} onSelect={onSelect} className={cn("flex cursor-pointer items-center gap-2.5 rounded-[6px] px-2 py-1.5 text-sm text-ink data-[selected=true]:bg-surface-3", active && "font-semibold")}>
      {children}
    </Command.Item>
  );
}

function AccountItem({ a, active, onSelect }: { a: SwitcherAccount; active: boolean; onSelect: () => void }) {
  return (
    <Item value={`@${a.handle} ${a.displayName} ${a.creatorName}`} onSelect={onSelect} active={active}>
      <Avatar handle={a.handle} color={a.avatarColor} size={24} />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">@{a.handle}</span>
        <span className="ml-1.5 text-ink-3">{a.creatorName}</span>
      </span>
      {a.pinned ? <Pin size={12} className="text-ink-4" /> : null}
      <Badge tone={ACCOUNT_TONE[a.state] ?? "neutral"}>{ACCOUNT_STATE_LABEL[a.state as keyof typeof ACCOUNT_STATE_LABEL] ?? a.state}</Badge>
    </Item>
  );
}
