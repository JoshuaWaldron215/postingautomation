"use client";
import { Dialog as RD } from "radix-ui";
import { X } from "lucide-react";
import { Button } from "./button";
import { cn } from "./cn";

export function Dialog({ open, onOpenChange, title, description, children, footer, size = "md" }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: React.ReactNode; children?: React.ReactNode; footer?: React.ReactNode; size?: "sm" | "md" | "lg" | "xl" }) {
  const width = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-2xl", xl: "max-w-4xl" }[size];
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-50 bg-ink/30 backdrop-blur-[1px]" />
        <RD.Content className={cn("fade-in fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg bg-surface shadow-panel focus:outline-none", width)}>
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <RD.Title className="text-[15px] font-semibold text-ink">{title}</RD.Title>
              {description ? <RD.Description className="mt-1 text-[13px] text-ink-3">{description}</RD.Description> : <RD.Description className="sr-only">{title}</RD.Description>}
            </div>
            <RD.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close">
                <X size={16} />
              </Button>
            </RD.Close>
          </div>
          <div className="scroll-thin overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div> : null}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

export function ConfirmDialog({ open, onOpenChange, title, body, confirmLabel = "Confirm", tone = "primary", onConfirm, loading }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; body?: React.ReactNode; confirmLabel?: string; tone?: "primary" | "danger"; onConfirm: () => void | Promise<void>; loading?: boolean }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} size="sm" footer={<>
      <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
      <Button variant={tone} loading={loading} onClick={() => void onConfirm()}>{confirmLabel}</Button>
    </>}>
      {body ? <div className="text-sm text-ink-2">{body}</div> : null}
    </Dialog>
  );
}
