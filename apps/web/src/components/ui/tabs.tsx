"use client";
import { cn } from "./cn";

export function SegmentedTabs<T extends string>({ value, onChange, options, size = "md", ariaLabel }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: React.ReactNode; count?: number }>; size?: "sm" | "md"; ariaLabel?: string }) {
  return (
    <div role="tablist" aria-label={ariaLabel} className="inline-flex min-w-0 max-w-full items-center gap-0.5 overflow-x-auto rounded-[9px] bg-surface-3 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-[7px] font-medium transition-colors", size === "sm" ? "h-7 px-2.5 text-[12px]" : "h-8 px-3 text-[13px]", value === o.value ? "bg-surface text-ink shadow-[0_1px_2px_rgba(31,27,22,0.12)]" : "text-ink-3 hover:text-ink")}
        >
          {o.label}
          {o.count != null ? <span className={cn("tabular rounded-full px-1.5 text-[11px]", value === o.value ? "bg-surface-3 text-ink-2" : "bg-surface-2 text-ink-4")}>{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
