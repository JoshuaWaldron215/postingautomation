"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Pause, Play } from "lucide-react";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Field, Input } from "../ui/field";
import { useToast } from "../ui/toast";
import { setGlobalPauseAction } from "@/actions/org";

export function GlobalPauseControl({ active, reason, canControl }: { active: boolean; reason?: string; canControl: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [why, setWhy] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const router = useRouter();
  const toast = useToast();
  const submit = async () => {
    setBusy(true);
    const r = await setGlobalPauseAction(!active, why);
    setBusy(false);
    if (!r.ok) return toast.push({ tone: "danger", title: r.error });
    toast.push({ tone: "ok", title: active ? "Posting resumed" : "All posting paused", body: active ? undefined : "Nothing new will be submitted. Anything already sent to Instagram cannot be undone." });
    setOpen(false);
    setWhy("");
    router.refresh();
  };
  if (!canControl) {
    return active ? <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-danger-soft px-3 text-[12px] font-semibold text-danger"><Pause size={12} /> All posting paused</span> : null;
  }
  return (
    <>
      <Button variant={active ? "danger" : "outline"} size="sm" onClick={() => setOpen(true)} aria-label={active ? "Resume all posting" : "Pause all posting"}>
        {active ? <Play size={14} /> : <Pause size={14} />}
        <span className="hidden sm:inline">{active ? "Paused · resume" : "Pause all"}</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen} title={active ? "Resume all posting?" : "Pause all posting?"} size="sm" footer={<>
        <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
        <Button variant={active ? "primary" : "danger"} loading={busy} onClick={() => void submit()}>{active ? "Resume posting" : "Pause everything"}</Button>
      </>}>
        {active ? (
          <p className="text-sm text-ink-2">Workers will start claiming scheduled posts again. Overdue posts publish in order and keep the minimum spacing between them.{reason ? <> Paused earlier because: <em>{reason}</em>.</> : null}</p>
        ) : (
          <div className="space-y-3 text-sm text-ink-2">
            <p>Stops every new submission across all creators and accounts. A post that has already been sent to Instagram cannot be recalled; anything mid-way finishes and is verified as usual.</p>
            <Field label="Reason (shown to the team)">
              <Input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="e.g. client asked to hold until Monday" autoFocus />
            </Field>
          </div>
        )}
      </Dialog>
    </>
  );
}
