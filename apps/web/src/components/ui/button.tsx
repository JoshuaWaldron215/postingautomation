"use client";
import * as React from "react";
import { cn } from "./cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg" | "icon";

const base = "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[8px] font-medium transition-colors disabled:opacity-50 select-none";
const variants: Record<Variant, string> = {
  primary: "bg-accent text-white hover:bg-accent-strong shadow-[inset_0_-1px_0_rgba(0,0,0,0.15)]",
  secondary: "bg-surface-3 text-ink hover:bg-line",
  outline: "bg-surface text-ink border border-line-strong hover:bg-surface-2",
  ghost: "text-ink-2 hover:bg-surface-3 hover:text-ink",
  danger: "bg-danger text-white hover:bg-[#9c2f27]",
};
const sizes: Record<Size, string> = { sm: "h-8 px-2.5 text-[13px]", md: "h-9 px-3.5 text-sm", lg: "h-10 px-4 text-sm", icon: "h-8 w-8" };

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button({ className, variant = "secondary", size = "md", loading, children, disabled, ...props }, ref) {
  return (
    <button ref={ref} className={cn(base, variants[variant], sizes[size], className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden /> : null}
      {children}
    </button>
  );
});
