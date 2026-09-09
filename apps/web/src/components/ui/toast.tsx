"use client";
import * as React from "react";
import { cn } from "./cn";

type Toast = { id: number; title: string; body?: string; tone: "ok" | "danger" | "info" };
const ToastCtx = React.createContext<{ push: (t: Omit<Toast, "id">) => void }>({ push: () => {} });

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<Toast[]>([]);
  const push = React.useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { ...t, id }]);
    setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), t.tone === "danger" ? 8000 : 4500);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex w-[min(420px,calc(100%-2rem))] -translate-x-1/2 flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} role="status" className={cn("fade-in pointer-events-auto rounded-md border bg-surface px-4 py-3 shadow-pop", t.tone === "danger" ? "border-danger/40" : t.tone === "ok" ? "border-ok/40" : "border-line")}>
            <p className={cn("text-sm font-medium", t.tone === "danger" ? "text-danger" : "text-ink")}>{t.title}</p>
            {t.body ? <p className="mt-0.5 text-[13px] text-ink-3">{t.body}</p> : null}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return React.useContext(ToastCtx);
}
