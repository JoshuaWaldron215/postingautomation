/**
 * Browser/Hermes adapter — the integration boundary for Josh's Mac mini.
 *
 * STATUS: UNVERIFIED. This environment has no access to the Mac, the Hermes installation, its
 * authenticated browser profiles or its supported invocation methods. Nothing here assumes a
 * Hermes HTTP endpoint, CLI flag or structured-output guarantee. Instead the adapter defines a
 * minimal file-based contract that a Hermes skill/script on the Mac must satisfy:
 *
 *   $HERMES_COMMAND --task <task.json> --result <result.json>
 *
 * task.json  : { "op": "verify_identity" | "publish" | "reconcile" | "read_metrics", ... }
 * result.json: shape validated below (HermesResultSchema). Anything missing or unparseable is
 *              treated conservatively: publish → "unknown" (never retried automatically),
 *              other ops → "failed".
 *
 * Browser profiles are separate per account (`browserProfileKey`) under HERMES_PROFILES_DIR. This
 * is an identity-management requirement, not a guarantee against account linkage.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ClaimedAnalyticsJob } from "../services/analytics";
import type { ClaimedJob } from "../services/jobs";
import type { AccountRef, AdapterControl, Capabilities, IdentityCheck, MetricsOutcome, PublishOutcome, PublisherAdapter, ReconcileOutcome } from "./types";

export type HermesOptions = {
  command: string;
  workdir: string;
  profilesDir: string;
  timeoutMs?: number;
  env?: Record<string, string>;
};

const ErrorCategory = z.enum(["account_mismatch", "approval_changed", "login_required", "login_challenge", "unsupported_format", "unclear_publication", "authorization_revoked", "paused", "content_missing", "worker_lost", "timeout", "network", "instagram_error", "internal"]);

export const HermesResultSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("verify_identity"), sessionReady: z.boolean(), observedHandle: z.string().nullable(), observedIgUserId: z.string().nullable(), screenshotPath: z.string().optional(), notes: z.string().optional() }),
  z.object({
    op: z.literal("publish"),
    outcome: z.enum(["verified", "failed", "blocked", "unknown"]),
    postUrl: z.string().nullable().optional(),
    externalId: z.string().nullable().optional(),
    publishedAt: z.string().optional(),
    category: ErrorCategory.optional(),
    message: z.string().optional(),
    screenshotPath: z.string().optional(),
  }),
  z.object({ op: z.literal("reconcile"), found: z.union([z.boolean(), z.literal("unknown")]), postUrl: z.string().nullable().optional(), externalId: z.string().nullable().optional(), publishedAt: z.string().optional(), message: z.string().optional(), screenshotPath: z.string().optional() }),
  z.object({
    op: z.literal("read_metrics"),
    outcome: z.enum(["observed", "post_not_found", "failed"]),
    observedAt: z.string().optional(),
    metrics: z.array(z.object({ name: z.string(), value: z.number().nullable(), source: z.string(), note: z.string().optional() })).optional(),
    category: ErrorCategory.optional(),
    message: z.string().optional(),
    screenshotPath: z.string().optional(),
  }),
]);
export type HermesResult = z.infer<typeof HermesResultSchema>;

export class HermesAdapter implements PublisherAdapter {
  readonly kind = "browser_hermes" as const;
  readonly executionLabel = "Browser (Hermes)";
  constructor(private readonly opts: HermesOptions) {}

  async capabilities(): Promise<Capabilities> {
    const exists = await fs
      .access(this.opts.command.split(" ")[0]!)
      .then(() => true)
      .catch(() => false);
    return {
      canVerifyIdentity: true,
      canPublish: true,
      canReconcile: true,
      canReadMetrics: true,
      live: true,
      notes: [
        "UNVERIFIED: this adapter has not been exercised against a real Hermes installation yet.",
        exists ? `Command found: ${this.opts.command}` : `Command not found on this host: ${this.opts.command}`,
        "The Mac-side script must implement the task/result JSON contract in docs/mac-worker.md.",
        "One browser profile per account under HERMES_PROFILES_DIR.",
      ],
    };
  }

  async checkReadiness(account: AccountRef) {
    const profile = path.join(this.opts.profilesDir, account.browserProfileKey ?? `profile-${account.handle}`);
    const ok = await fs
      .access(profile)
      .then(() => true)
      .catch(() => false);
    return ok ? { ready: true } : { ready: false, reason: `Browser profile directory missing: ${profile}` };
  }

  private async run(task: Record<string, unknown>, ctrl: Pick<AdapterControl, "log" | "storeEvidence"> & { heartbeat?: () => Promise<boolean> }): Promise<HermesResult | null> {
    await fs.mkdir(this.opts.workdir, { recursive: true });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const taskPath = path.join(this.opts.workdir, `task-${id}.json`);
    const resultPath = path.join(this.opts.workdir, `result-${id}.json`);
    await fs.writeFile(taskPath, JSON.stringify(task, null, 2));
    const [cmd, ...baseArgs] = this.opts.command.split(" ").filter(Boolean) as [string, ...string[]];
    const args = [...baseArgs, "--task", taskPath, "--result", resultPath];
    ctrl.log(`hermes: ${cmd} ${args.join(" ")}`);
    const exit = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
      const child = spawn(cmd, args, { cwd: this.opts.workdir, env: { ...process.env, ...(this.opts.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (d: Buffer) => ctrl.log(`hermes> ${d.toString().trim()}`));
      child.stderr.on("data", (d: Buffer) => ctrl.log(`hermes! ${d.toString().trim()}`));
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve({ code: null, timedOut: true });
      }, this.opts.timeoutMs ?? 15 * 60_000);
      const hb = ctrl.heartbeat ? setInterval(() => void ctrl.heartbeat!(), 60_000) : null;
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (hb) clearInterval(hb);
        resolve({ code, timedOut: false });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        if (hb) clearInterval(hb);
        ctrl.log(`hermes: spawn failed: ${err.message}`);
        resolve({ code: -1, timedOut: false });
      });
    });
    if (exit.timedOut) ctrl.log("hermes: command timed out");
    try {
      const raw = await fs.readFile(resultPath, "utf8");
      const parsed = HermesResultSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        ctrl.log(`hermes: result did not match the contract: ${parsed.error.message}`);
        return null;
      }
      return parsed.data;
    } catch (err) {
      ctrl.log(`hermes: no readable result file (${err instanceof Error ? err.message : String(err)})`);
      return null;
    } finally {
      await fs.rm(taskPath, { force: true });
    }
  }

  private async evidence(ctrl: Pick<AdapterControl, "storeEvidence">, screenshotPath?: string): Promise<string | null> {
    if (!screenshotPath) return null;
    try {
      const buf = await fs.readFile(screenshotPath);
      return await ctrl.storeEvidence(path.basename(screenshotPath), buf, "image/png");
    } catch {
      return null;
    }
  }

  private profileFor(account: AccountRef) {
    return path.join(this.opts.profilesDir, account.browserProfileKey ?? `profile-${account.handle}`);
  }

  async verifyIdentity(account: AccountRef, ctrl: Pick<AdapterControl, "log" | "storeEvidence">): Promise<IdentityCheck> {
    const r = await this.run({ op: "verify_identity", expectedHandle: account.handle, profileDir: this.profileFor(account) }, ctrl);
    if (!r || r.op !== "verify_identity") return { sessionReady: false, observedHandle: null, observedIgUserId: null, notes: "Hermes returned no usable identity result" };
    return { sessionReady: r.sessionReady, observedHandle: r.observedHandle, observedIgUserId: r.observedIgUserId, evidenceKey: await this.evidence(ctrl, r.screenshotPath), notes: r.notes };
  }

  async publish(job: ClaimedJob, ctrl: AdapterControl): Promise<PublishOutcome> {
    const r = await this.run({ op: "publish", expectedHandle: job.account.handle, expectedIgUserId: job.account.verifiedIgUserId, profileDir: this.profileFor(job.account), mediaPath: ctrl.mediaPath, caption: job.content.caption, format: job.content.format, idempotencyKey: job.idempotencyKey }, ctrl);
    if (!r || r.op !== "publish") return { outcome: "unknown", message: "Hermes returned no usable result after the publish step; the post may or may not be live." };
    const evidenceKey = await this.evidence(ctrl, r.screenshotPath);
    switch (r.outcome) {
      case "verified":
        if (!r.publishedAt) return { outcome: "unknown", message: "Hermes reported success without a publication time; verify on Instagram.", evidenceKey };
        return { outcome: "verified", postUrl: r.postUrl ?? null, externalId: r.externalId ?? null, publishedAt: r.publishedAt, publishedAtSource: "worker_observed", evidenceKey };
      case "failed":
        return { outcome: "failed", category: r.category ?? "instagram_error", message: r.message ?? "Hermes reported a failure", evidenceKey };
      case "blocked":
        return { outcome: "blocked", category: r.category ?? "login_required", message: r.message ?? "Hermes reported a blocker", evidenceKey };
      default:
        return { outcome: "unknown", message: r.message ?? "Hermes could not confirm the result", evidenceKey };
    }
  }

  async reconcile(job: Pick<ClaimedJob, "jobId" | "account" | "content" | "idempotencyKey">, ctrl: Pick<AdapterControl, "log" | "storeEvidence">): Promise<ReconcileOutcome> {
    const r = await this.run({ op: "reconcile", expectedHandle: job.account.handle, profileDir: this.profileFor(job.account), caption: job.content.caption, idempotencyKey: job.idempotencyKey }, ctrl);
    if (!r || r.op !== "reconcile" || r.found === "unknown") return { found: "unknown", message: r && r.op === "reconcile" ? r.message ?? "Could not determine" : "No usable reconcile result" };
    const evidenceKey = await this.evidence(ctrl, r.screenshotPath);
    if (r.found) return { found: true, postUrl: r.postUrl ?? null, externalId: r.externalId ?? null, publishedAt: r.publishedAt ?? new Date().toISOString(), publishedAtSource: r.publishedAt ? "instagram_reported" : "estimated", evidenceKey };
    return { found: false, evidenceKey, notes: r.message };
  }

  async readMetrics(job: ClaimedAnalyticsJob, ctrl: Pick<AdapterControl, "log" | "storeEvidence" | "heartbeat">): Promise<MetricsOutcome> {
    const r = await this.run({ op: "read_metrics", expectedHandle: job.account.handle, profileDir: this.profileFor(job.account), postUrl: job.post.postUrl, externalId: job.post.externalId }, ctrl);
    if (!r || r.op !== "read_metrics") return { outcome: "failed", category: "internal", message: "No usable metrics result from Hermes" };
    const evidenceKey = await this.evidence(ctrl, r.screenshotPath);
    if (r.outcome === "observed") return { outcome: "observed", observedAt: r.observedAt ?? new Date().toISOString(), metrics: r.metrics ?? [], source: "instagram_web:hermes", evidenceKey };
    if (r.outcome === "post_not_found") return { outcome: "post_not_found", observedAt: r.observedAt ?? new Date().toISOString(), evidenceKey };
    return { outcome: "failed", category: r.category ?? "instagram_error", message: r.message ?? "Hermes reported a failure", evidenceKey };
  }
}
