/**
 * Periodic maintenance executed by the scheduler process for every organization.
 * Everything here is idempotent and safe to run concurrently with the dashboard and workers.
 */
import { organizations } from "../db/schema";
import type { Db } from "../db/index";
import { promoteDueAnalytics, maintainAnalytics } from "./analytics";
import { expireHandoffs } from "./accounts";
import { reconcileCampaignLifecycle } from "./campaigns";
import { purgeDeletedAssets } from "./content";
import { makeCtx, schedulerActor, type Ctx } from "./context";
import { detectContentShortage, detectMissedSchedule, expireStaleLeases, promoteDueJobs } from "./jobs";
import { processDeliveries, type DeliveryTransport } from "./notifications";
import { detectOfflineWorkers } from "./workers";

export type TickReport = {
  orgId: string;
  promoted: number;
  leases: { requeued: number; unknown: number };
  offlineWorkers: number;
  analyticsPromoted: number;
  analytics: { requeued: number; overdueNotified: number };
  missedSchedule: number;
  contentShortage: number;
  handoffsExpired: number;
  deliveries: { sent: number; failed: number };
  purged: number;
};

export async function tickOrg(ctx: Ctx, opts: { transport?: DeliveryTransport; deliver?: boolean } = {}): Promise<TickReport> {
  const promoted = await promoteDueJobs(ctx);
  const leases = await expireStaleLeases(ctx);
  const offline = await detectOfflineWorkers(ctx);
  const analyticsPromoted = await promoteDueAnalytics(ctx);
  const analytics = await maintainAnalytics(ctx);
  const missedSchedule = await detectMissedSchedule(ctx);
  const contentShortage = await detectContentShortage(ctx);
  const handoffsExpired = await expireHandoffs(ctx);
  await reconcileCampaignLifecycle(ctx);
  const deliveries = opts.deliver === false ? { sent: 0, failed: 0 } : await processDeliveries(ctx, opts.transport);
  const purged = await purgeDeletedAssets(ctx);
  return { orgId: ctx.orgId, promoted, leases, offlineWorkers: offline.length, analyticsPromoted, analytics, missedSchedule, contentShortage, handoffsExpired, deliveries, purged };
}

export async function tickAll(db: Db, opts: { transport?: DeliveryTransport } = {}): Promise<TickReport[]> {
  const orgs = await db.select({ id: organizations.id }).from(organizations);
  const reports: TickReport[] = [];
  for (const o of orgs) {
    const ctx = await makeCtx({ db, orgId: o.id, actor: schedulerActor });
    reports.push(await tickOrg(ctx, opts));
  }
  return reports;
}
