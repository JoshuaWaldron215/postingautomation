"use client";
import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Could not sign in.");
        return;
      }
      router.push(params.get("next") ?? "/today");
      router.refresh();
    } catch {
      setError("You appear to be offline. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-[9px] bg-ink text-base font-bold text-canvas">S</span>
          <div className="leading-tight">
            <p className="text-[15px] font-semibold tracking-tight">Synthos posting</p>
            <p className="text-[12px] text-ink-3">MAP Agency operations</p>
          </div>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-lg border border-line bg-surface p-5 shadow-[0_1px_2px_rgba(31,27,22,0.06)]">
          <h1 className="text-lg font-semibold">Sign in</h1>
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          <Field label="Password" htmlFor="password" error={error}>
            <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>Sign in</Button>
        </form>
        <div className="mt-4 rounded-md border border-warn/40 bg-warn-soft p-3 text-[12px] text-ink-2">
          <p className="font-semibold text-warn">Demo logins</p>
          <ul className="mt-1 space-y-0.5 font-mono text-[11.5px]">
            <li>shafiq@map.agency · demo-owner-2026 (owner)</li>
            <li>josh@synthos.dev · demo-operator-2026 (operator)</li>
            <li>riley@map.agency · demo-viewer-2026 (viewer)</li>
          </ul>
        </div>
      </div>
    </main>
  );
}
