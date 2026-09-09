import Link from "next/link";
import { Avatar } from "../ui/avatar";
import { Badge, JOB_TONE, ACCOUNT_TONE } from "../ui/badge";
import { ACCOUNT_STATE_LABEL, JOB_STATE_LABEL } from "@synthos/core/lib/states";
import { cn } from "../ui/cn";

export function AccountChip({ handle, color, href, size = "md", className, subtitle }: { handle: string; color: string; href?: string; size?: "sm" | "md"; className?: string; subtitle?: React.ReactNode }) {
  const inner = (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <Avatar handle={handle} color={color} size={size === "sm" ? 20 : 26} />
      <span className="min-w-0 leading-tight">
        <span className={cn("block truncate font-medium text-ink", size === "sm" ? "text-[12.5px]" : "text-[13px]")}>@{handle}</span>
        {subtitle ? <span className="block truncate text-[11.5px] text-ink-3">{subtitle}</span> : null}
      </span>
    </span>
  );
  return href ? <Link href={href} className="min-w-0 rounded hover:underline">{inner}</Link> : inner;
}

export function JobStatePill({ state, className }: { state: string; className?: string }) {
  const live = state === "PREPARING" || state === "SUBMITTING";
  return (
    <Badge tone={JOB_TONE[state] ?? "neutral"} className={className} dot={live}>
      <span className={live ? "pulse-dot" : undefined}>{JOB_STATE_LABEL[state as keyof typeof JOB_STATE_LABEL] ?? state}</span>
    </Badge>
  );
}

export function AccountStatePill({ state, className }: { state: string; className?: string }) {
  return <Badge tone={ACCOUNT_TONE[state] ?? "neutral"} className={className} dot={state === "posting"}>{ACCOUNT_STATE_LABEL[state as keyof typeof ACCOUNT_STATE_LABEL] ?? state}</Badge>;
}

export function Thumb({ src, alt, className, ratio = "portrait" }: { src: string | null; alt: string; className?: string; ratio?: "portrait" | "square" | "wide" }) {
  const r = ratio === "portrait" ? "aspect-[9/16]" : ratio === "wide" ? "aspect-video" : "aspect-square";
  return (
    <span className={cn("block overflow-hidden rounded-[6px] bg-surface-3", r, className)}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-[10px] text-ink-4">no preview</span>
      )}
    </span>
  );
}

export function ExecutionLabel({ route }: { route: string }) {
  const label = route === "simulator" ? "Simulated" : route === "browser_hermes" ? "Browser (Hermes)" : route === "pixel" ? "Pixel (future)" : "Official API (future)";
  return <Badge tone={route === "simulator" ? "warn" : "neutral"}>{label}</Badge>;
}
