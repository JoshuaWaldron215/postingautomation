import { cn } from "./cn";

export function EmptyState({ title, body, action, className, compact }: { title: string; body?: React.ReactNode; action?: React.ReactNode; className?: string; compact?: boolean }) {
  return (
    <div className={cn("flex flex-col items-center justify-center rounded-lg border border-dashed border-line-strong bg-surface-2 text-center", compact ? "px-4 py-6" : "px-6 py-12", className)}>
      <p className="text-sm font-medium text-ink">{title}</p>
      {body ? <p className="mt-1 max-w-md text-[13px] text-ink-3">{body}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} aria-hidden />;
}
