export function PageHeader({ title, description, actions, children }: { title: string; description?: React.ReactNode; actions?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-4 md:mb-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
          {description ? <p className="mt-0.5 text-[13px] text-ink-3">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

export function Card({ title, action, children, className, tone }: { title?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string; tone?: "danger" | "warn" }) {
  return (
    <section className={["rounded-lg border bg-surface shadow-[0_1px_2px_rgba(31,27,22,0.04)]", tone === "danger" ? "border-danger/30" : tone === "warn" ? "border-warn/30" : "border-line", className].filter(Boolean).join(" ")}>
      {title ? (
        <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}
