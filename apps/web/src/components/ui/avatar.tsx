import { cn } from "./cn";

export function Avatar({ handle, color, size = 28, className }: { handle: string; color: string; size?: number; className?: string }) {
  const initials = handle.replace(/^@/, "").split(/[._]/).filter(Boolean).slice(0, 2).map((s) => s[0]!.toUpperCase()).join("") || "?";
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white", className)}
      style={{ width: size, height: size, background: color, fontSize: Math.max(10, size * 0.38), letterSpacing: "0.02em", textShadow: "0 1px 1px rgba(0,0,0,0.25)" }}
    >
      {initials}
    </span>
  );
}
