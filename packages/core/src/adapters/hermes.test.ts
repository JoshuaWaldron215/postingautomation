import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HermesAdapter, HermesResultSchema } from "./hermes";

/** A fake Hermes-side script that honors the task/result file contract. */
async function fakeScript(dir: string, body: string) {
  const file = path.join(dir, "fake-hermes.mjs");
  await fs.writeFile(file, `import fs from "node:fs";\nconst args = process.argv; const task = JSON.parse(fs.readFileSync(args[args.indexOf("--task")+1], "utf8")); const out = args[args.indexOf("--result")+1];\n${body}`);
  return `node ${file}`;
}

describe("Hermes adapter boundary (unverified against a real Mac)", () => {
  it("validates result files against the contract and treats missing publish results as unknown", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-"));
    const ok = await fakeScript(dir, `fs.writeFileSync(out, JSON.stringify({ op: "publish", outcome: "verified", postUrl: "https://www.instagram.com/reel/x/", externalId: "x", publishedAt: "2026-03-07T15:00:00Z" }));`);
    const adapter = new HermesAdapter({ command: ok, workdir: dir, profilesDir: dir, timeoutMs: 10_000 });
    const ctrl = { heartbeat: async () => true, storeEvidence: async () => null, log: () => {}, mediaPath: "/tmp/x.mp4" };
    const job = { jobId: "j", fence: 1, leaseExpiresAt: "", attemptNo: 1, account: { id: "a", handle: "h", verifiedIgUserId: null, timezone: "UTC", browserProfileKey: "p", executionRoute: "browser_hermes" }, content: { assetId: "x", sha256: "s", caption: "c", format: "reel" as const, audience: "public" as const, mediaUrlPath: "", filename: "x.mp4", mime: "video/mp4", durationSeconds: 3 }, plannedAt: "", campaignId: "c", idempotencyKey: "k" };
    const r = await adapter.publish(job, ctrl);
    expect(r.outcome).toBe("verified");
    const silent = new HermesAdapter({ command: await fakeScript(dir, `/* writes nothing */`), workdir: dir, profilesDir: dir, timeoutMs: 10_000 });
    const r2 = await silent.publish(job, ctrl);
    expect(r2.outcome).toBe("unknown");
    const malformed = new HermesAdapter({ command: await fakeScript(dir, `fs.writeFileSync(out, JSON.stringify({ op: "publish", outcome: "great" }));`), workdir: dir, profilesDir: dir, timeoutMs: 10_000 });
    expect((await malformed.publish(job, ctrl)).outcome).toBe("unknown");
    const identity = new HermesAdapter({ command: await fakeScript(dir, `fs.writeFileSync(out, JSON.stringify({ op: "verify_identity", sessionReady: true, observedHandle: task.expectedHandle, observedIgUserId: "123" }));`), workdir: dir, profilesDir: dir, timeoutMs: 10_000 });
    const id = await identity.verifyIdentity(job.account, ctrl);
    expect(id).toMatchObject({ sessionReady: true, observedHandle: "h", observedIgUserId: "123" });
    expect(HermesResultSchema.safeParse({ op: "read_metrics", outcome: "observed", metrics: [{ name: "plays", value: null, source: "x" }] }).success).toBe(true);
    const caps = await adapter.capabilities();
    expect(caps.live).toBe(true);
    expect(caps.notes.join(" ")).toMatch(/UNVERIFIED/);
  });
});
