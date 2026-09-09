"use client";
import * as React from "react";
import { ConfirmDialog } from "../ui/dialog";

type Guard = {
  dirty: boolean;
  setDirty: (key: string, dirty: boolean) => void;
  confirmLeave: (proceed: () => void) => void;
};
const Ctx = React.createContext<Guard>({ dirty: false, setDirty: () => {}, confirmLeave: (p) => p() });

/** Tracks unsaved edits across panels so switching accounts/records never silently discards them. */
export function DirtyGuardProvider({ children }: { children: React.ReactNode }) {
  const [keys, setKeys] = React.useState<Record<string, boolean>>({});
  const [pending, setPending] = React.useState<(() => void) | null>(null);
  const dirty = Object.values(keys).some(Boolean);
  const setDirty = React.useCallback((key: string, d: boolean) => setKeys((s) => (s[key] === d ? s : { ...s, [key]: d })), []);
  const confirmLeave = React.useCallback(
    (proceed: () => void) => {
      if (!dirty) return proceed();
      setPending(() => proceed);
    },
    [dirty],
  );
  React.useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);
  return (
    <Ctx.Provider value={{ dirty, setDirty, confirmLeave }}>
      {children}
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title="Discard unsaved changes?"
        body="You have edits that have not been saved. Leaving now will discard them."
        confirmLabel="Discard changes"
        tone="danger"
        onConfirm={() => {
          const p = pending;
          setPending(null);
          setKeys({});
          p?.();
        }}
      />
    </Ctx.Provider>
  );
}

export function useDirtyGuard() {
  return React.useContext(Ctx);
}

/** Registers a dirty flag for the lifetime of the component. */
export function useDirty(key: string, dirty: boolean) {
  const { setDirty } = useDirtyGuard();
  React.useEffect(() => {
    setDirty(key, dirty);
    return () => setDirty(key, false);
  }, [key, dirty, setDirty]);
}
