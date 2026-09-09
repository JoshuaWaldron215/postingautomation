"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Card } from "../common/page-header";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Dialog } from "../ui/dialog";
import { Field, Input, Select, Checkbox } from "../ui/field";
import { useToast } from "../ui/toast";
import { createUserAction, updateUserRoleAction } from "@/actions/settings";

type U = { id: string; email: string; name: string; role: "owner" | "operator" | "viewer"; creatorScope: string[]; createdAt: string };
const ROLE_HELP: Record<string, string> = { owner: "Everything, including pausing all posting, workers, destinations and people.", operator: "Upload, schedule, approve campaigns, resolve exceptions, pause accounts.", viewer: "Read-only across all screens." };

export function UsersView({ users, creators, meId }: { users: U[]; creators: Array<{ id: string; name: string }>; meId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState({ name: "", email: "", password: "", role: "operator" as U["role"], scope: [] as string[] });
  const [busy, setBusy] = React.useState<string | null>(null);
  const create = async () => { setBusy("create"); const r = await createUserAction({ name: form.name, email: form.email, password: form.password, role: form.role, creatorScope: form.scope.length ? form.scope : null }); setBusy(null); if (!r.ok) return toast.push({ tone: "danger", title: r.error }); toast.push({ tone: "ok", title: `Added ${form.name}` }); setOpen(false); setForm({ name: "", email: "", password: "", role: "operator", scope: [] }); router.refresh(); };
  const changeRole = async (u: U, role: U["role"]) => { setBusy(u.id); const r = await updateUserRoleAction(u.id, role, u.creatorScope.length ? u.creatorScope : null); setBusy(null); if (!r.ok) return toast.push({ tone: "danger", title: r.error }); toast.push({ tone: "ok", title: `${u.name} is now ${role}` }); router.refresh(); };
  return (
    <div className="space-y-4">
      <Card title="People" action={<Button size="sm" variant="primary" onClick={() => setOpen(true)}><Plus size={14} /> Add person</Button>}>
        <ul className="divide-y divide-line">
          {users.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent-ink">{u.name.slice(0, 1)}</span>
              <span className="min-w-0 flex-1"><span className="block text-[13.5px] font-medium">{u.name}{u.id === meId ? <span className="ml-1 text-ink-4">(you)</span> : null}</span><span className="block text-[12px] text-ink-3">{u.email}{u.creatorScope.length ? ` · limited to ${u.creatorScope.map((id) => creators.find((c) => c.id === id)?.name ?? "?").join(", ")}` : ""}</span></span>
              <Select inline className="h-8 py-0 text-[12.5px]" value={u.role} disabled={busy === u.id || u.id === meId} onChange={(e) => void changeRole(u, e.target.value as U["role"])}><option value="owner">Owner</option><option value="operator">Operator</option><option value="viewer">Viewer</option></Select>
            </li>
          ))}
        </ul>
        <div className="grid gap-1 border-t border-line px-4 py-2.5 text-[12px] text-ink-3 sm:grid-cols-3">{Object.entries(ROLE_HELP).map(([r, h]) => <p key={r}><Badge tone="neutral" className="mr-1 capitalize">{r}</Badge>{h}</p>)}</div>
      </Card>
      <Card><p className="p-4 text-[12.5px] text-ink-3">Permissions are enforced on the server for every action and query, not just by hiding buttons. Operators and viewers can be limited to specific creators; records outside their scope are invisible to them.</p></Card>
      <Dialog open={open} onOpenChange={setOpen} title="Add a person" size="sm" footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={busy === "create"} disabled={!form.name || !form.email || form.password.length < 10} onClick={() => void create()}>Add</Button></>}>
        <div className="space-y-3">
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
          <Field label="Email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Temporary password" hint="At least 10 characters. Share it privately."><Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          <Field label="Role"><Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as U["role"] })}><option value="owner">Owner</option><option value="operator">Operator</option><option value="viewer">Viewer</option></Select></Field>
          {form.role !== "owner" ? <Field label="Limit to creators (optional)"><div className="grid grid-cols-2 gap-1">{creators.map((c) => <Checkbox key={c.id} label={c.name} checked={form.scope.includes(c.id)} onChange={(e) => setForm({ ...form, scope: e.target.checked ? [...form.scope, c.id] : form.scope.filter((x) => x !== c.id) })} />)}</div></Field> : null}
        </div>
      </Dialog>
    </div>
  );
}
