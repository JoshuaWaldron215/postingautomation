/**
 * Scheduler process. Runs the maintenance tick for every organization on an interval.
 * Independent of the dashboard: promotes due jobs, expires stale leases, detects offline workers,
 * schedules ten-hour analytics, raises missed checkpoints and delivers queued notifications.
 */
import { closeDb, getDb, loadDotEnv, scheduler } from "@synthos/core";

loadDotEnv();
const tickMs = Number(process.env.SCHEDULER_TICK_MS ?? 5000);
let running = true;
let inTick = false;

const log = (m: string) => console.log(`${new Date().toISOString()} scheduler ${m}`);

async function tick() {
  if (inTick) return;
  inTick = true;
  try {
    const reports = await scheduler.tickAll(getDb());
    for (const r of reports) {
      const interesting = r.promoted || r.leases.requeued || r.leases.unknown || r.offlineWorkers || r.analyticsPromoted || r.analytics.requeued || r.analytics.overdueNotified || r.missedSchedule || r.contentShortage || r.handoffsExpired || r.deliveries.sent || r.deliveries.failed || r.purged;
      if (interesting) log(`org ${r.orgId.slice(0, 8)}: ${JSON.stringify(r)}`);
    }
  } catch (err) {
    log(`tick failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  } finally {
    inTick = false;
  }
}

async function main() {
  log(`starting (tick every ${tickMs} ms)`);
  await tick();
  const timer = setInterval(() => void tick(), tickMs);
  const stop = async () => {
    if (!running) return;
    running = false;
    clearInterval(timer);
    log("stopping");
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
