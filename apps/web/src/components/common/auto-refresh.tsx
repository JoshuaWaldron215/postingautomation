"use client";
import * as React from "react";
import { useRouter } from "next/navigation";

/** Refreshes server data on an interval while the tab is visible. Browsing never blocks posting; this only re-reads. */
function subscribeOnline(cb: () => void) {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); };
}

export function AutoRefresh({ seconds = 20 }: { seconds?: number }) {
  const router = useRouter();
  const online = React.useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const offline = !online;
  React.useEffect(() => {
    const tick = () => {
      // Never refresh underneath an open modal (e.g. the campaign builder); it would be disorienting mid-edit.
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      if (document.visibilityState === "visible" && navigator.onLine) router.refresh();
    };
    const t = setInterval(tick, seconds * 1000);
    const on = () => router.refresh();
    window.addEventListener("online", on);
    return () => { clearInterval(t); window.removeEventListener("online", on); };
  }, [router, seconds]);
  if (!offline) return null;
  return <div role="status" className="fixed bottom-20 left-1/2 z-40 -translate-x-1/2 rounded-full border border-warn/40 bg-warn-soft px-3 py-1 text-[12px] font-medium text-warn shadow-pop md:bottom-4">You are offline. Showing the last loaded data; posting continues on the worker.</div>;
}
