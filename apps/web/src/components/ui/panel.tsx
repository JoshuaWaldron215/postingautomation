"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "./button";
import { Tip } from "./tooltip";
import { Kbd } from "./kbd";
import { useDirtyGuard } from "../shell/dirty-guard";
import { cn } from "./cn";

/**
 * Right-hand side panel that keeps list context. Prev/next navigate the current list order and
 * preserve the URL filters. Escape closes; ← → move when focus is not in a field.
 */
export function SidePanel({ title, subtitle, onCloseHref, prevHref, nextHref, position, children, header, width = "md", ariaLabel }: { ariaLabel?: string; title: React.ReactNode; subtitle?: React.ReactNode; onCloseHref: string; prevHref?: string | null; nextHref?: string | null; position?: { index: number; total: number }; children: React.ReactNode; header?: React.ReactNode; width?: "md" | "lg" }) {
  const router = useRouter();
  const guard = useDirtyGuard();
  const go = React.useCallback(
    (href: string | null | undefined) => {
      if (!href) return;
      guard.confirmLeave(() => router.push(href, { scroll: false }));
    },
    [guard, router],
  );
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      // A modal dialog on top of the panel owns Escape; do not close the panel underneath it.
      if (t?.closest('[role="dialog"][data-state="open"]')) return;
      if (e.key === "Escape" && !typing) go(onCloseHref);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowLeft" && prevHref) go(prevHref);
      if (e.key === "ArrowRight" && nextHref) go(nextHref);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onCloseHref, prevHref, nextHref]);
  return (
    <aside role="dialog" aria-label={ariaLabel ?? (typeof title === "string" ? title : "Details")} className={cn("panel-in fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-line bg-surface shadow-panel md:w-[440px]", width === "lg" && "lg:w-[560px]")}>
      <div className="flex items-start gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold text-ink">{title}</div>
          {subtitle ? <div className="mt-0.5 truncate text-[12px] text-ink-3">{subtitle}</div> : null}
        </div>
        {position ? <span className="tabular mt-1 hidden text-[12px] text-ink-4 sm:inline">{position.index + 1} of {position.total}</span> : null}
        <div className="flex items-center gap-0.5">
          <Tip content={<span className="inline-flex items-center gap-1">Previous <Kbd>←</Kbd></span>}>
            <Button variant="ghost" size="icon" aria-label="Previous" disabled={!prevHref} onClick={() => go(prevHref)}>
              <ChevronLeft size={16} />
            </Button>
          </Tip>
          <Tip content={<span className="inline-flex items-center gap-1">Next <Kbd>→</Kbd></span>}>
            <Button variant="ghost" size="icon" aria-label="Next" disabled={!nextHref} onClick={() => go(nextHref)}>
              <ChevronRight size={16} />
            </Button>
          </Tip>
          <Tip content={<span className="inline-flex items-center gap-1">Close <Kbd>Esc</Kbd></span>}>
            <Button variant="ghost" size="icon" aria-label="Close panel" onClick={() => go(onCloseHref)}>
              <X size={16} />
            </Button>
          </Tip>
        </div>
      </div>
      {header ? <div className="border-b border-line px-4 py-3">{header}</div> : null}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
    </aside>
  );
}

export function PanelSection({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="mb-5">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function KV({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[minmax(110px,auto)_1fr] gap-x-3 gap-y-1.5 text-[13px]">
      {rows.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="text-ink-3">{k}</dt>
          <dd className="min-w-0 break-words text-ink">{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}
