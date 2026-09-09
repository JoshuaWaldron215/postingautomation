"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/button";
import { Field, Input, Select } from "../ui/field";
import { Card } from "../common/page-header";
import { useToast } from "../ui/toast";
import { updateAnalyticsSettingsAction, updateRetentionSettingsAction } from "@/actions/org";
import type { OrgSettings } from "@synthos/core/db/schema";

export function RulesForm({ settings, role }: { settings: OrgSettings; role: string }) {
  const router = useRouter();
  const toast = useToast();
  const canEdit = role === "owner";
  const [a, setA] = React.useState({ delayHours: String(settings.analytics.delayHours), lateAfterMinutes: String(settings.analytics.lateAfterMinutes), metric: settings.analytics.threshold.metric, value: String(settings.analytics.threshold.value), comparator: settings.analytics.threshold.comparator });
  const [r, setR] = React.useState({ minGapMinutes: String(settings.minGapMinutes), evidenceDays: String(settings.retention.evidenceDays), deletedAssetDays: String(settings.retention.deletedAssetDays) });
  const [busy, setBusy] = React.useState<string | null>(null);
  const saveA = async () => { setBusy("a"); const res = await updateAnalyticsSettingsAction({ delayHours: Number(a.delayHours), lateAfterMinutes: Number(a.lateAfterMinutes), threshold: { metric: a.metric, value: Number(a.value), comparator: a.comparator } }); setBusy(null); if (!res.ok) return toast.push({ tone: "danger", title: res.error }); toast.push({ tone: "ok", title: "Analytics rules saved", body: "Applies to new observations; existing reports keep the threshold they were evaluated with." }); router.refresh(); };
  const saveR = async () => { setBusy("r"); const res = await updateRetentionSettingsAction({ minGapMinutes: Number(r.minGapMinutes), evidenceDays: Number(r.evidenceDays), deletedAssetDays: Number(r.deletedAssetDays) }); setBusy(null); if (!res.ok) return toast.push({ tone: "danger", title: res.error }); toast.push({ tone: "ok", title: "Spacing and retention saved" }); router.refresh(); };
  return (
    <div className="space-y-4">
      <Card title="Analytics report">
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <Field label="Report after (hours)" hint="Due time = actual publication time + this."><Input type="number" min={1} max={72} value={a.delayHours} onChange={(e) => setA({ ...a, delayHours: e.target.value })} disabled={!canEdit} /></Field>
          <Field label="Count as late after (minutes)" hint="A later observation is stored and labeled late."><Input type="number" min={0} value={a.lateAfterMinutes} onChange={(e) => setA({ ...a, lateAfterMinutes: e.target.value })} disabled={!canEdit} /></Field>
          <Field label="Provisional threshold metric"><Select value={a.metric} onChange={(e) => setA({ ...a, metric: e.target.value as typeof a.metric })} disabled={!canEdit}><option value="plays">plays</option><option value="views">views</option><option value="reach">reach</option></Select></Field>
          <div className="grid grid-cols-[1fr_1.4fr] gap-3">
            <Field label="Comparison"><Select value={a.comparator} onChange={(e) => setA({ ...a, comparator: e.target.value as "gt" | "gte" })} disabled={!canEdit}><option value="gte">≥ at least</option><option value="gt">&gt; more than</option></Select></Field>
            <Field label="Value"><Input type="number" min={0} value={a.value} onChange={(e) => setA({ ...a, value: e.target.value })} disabled={!canEdit} /></Field>
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-[12px] text-ink-3"><span>Plays, views and reach are different metrics; the threshold compares only the one you pick. Missing values evaluate as “unknown”.</span>{canEdit ? <Button variant="primary" size="sm" loading={busy === "a"} onClick={() => void saveA()}>Save</Button> : null}</div>
      </Card>
      <Card title="Spacing and retention">
        <div className="grid gap-3 p-4 sm:grid-cols-3">
          <Field label="Minimum minutes between actual publications" hint="Per account. Delayed posts show as late rather than bunching up."><Input type="number" min={1} value={r.minGapMinutes} onChange={(e) => setR({ ...r, minGapMinutes: e.target.value })} disabled={!canEdit} /></Field>
          <Field label="Keep evidence screenshots (days)" hint="Screenshots can show account details; keep this short."><Input type="number" min={1} value={r.evidenceDays} onChange={(e) => setR({ ...r, evidenceDays: e.target.value })} disabled={!canEdit} /></Field>
          <Field label="Purge deleted videos after (days)"><Input type="number" min={1} value={r.deletedAssetDays} onChange={(e) => setR({ ...r, deletedAssetDays: e.target.value })} disabled={!canEdit} /></Field>
        </div>
        <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-[12px] text-ink-3"><span>Deleting a video here never deletes an Instagram post. Remote deletion is not part of this version.</span>{canEdit ? <Button variant="primary" size="sm" loading={busy === "r"} onClick={() => void saveR()}>Save</Button> : null}</div>
      </Card>
      <Card title="Mode">
        <div className="p-4 text-[13px] text-ink-2">
          <p><strong>{settings.demoMode ? "Demo mode is on." : "Live mode."}</strong> {settings.demoMode ? "Only simulator workers receive jobs; browser workers are refused, so nothing can be posted to Instagram. Turn it off by setting DEMO_MODE=false in the server environment once a real worker and real accounts are configured." : "Browser workers can receive approved jobs."}</p>
          <p className="mt-1 text-ink-3">Simulated clock offset: {settings.simClockOffsetMs ? `${Math.round(settings.simClockOffsetMs / 360000) / 10}h ahead (simulated time)` : "none (real time)"}.</p>
        </div>
      </Card>
    </div>
  );
}
