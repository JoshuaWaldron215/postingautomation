/**
 * Pure scheduling helpers. Timezone-aware via @date-fns/tz (IANA zones, DST-safe).
 *
 * Planned time vs actual publication: planned times come from the campaign template.
 * The worker may publish later than planned (queue depth, spacing, retries). The minimum
 * gap between *actual* publications on one account is enforced at claim time using
 * `not_before`, so delayed jobs are surfaced as delayed rather than compressed into a burst.
 */
import { TZDate } from "@date-fns/tz";
import { addDays, addMinutes, differenceInCalendarDays, isBefore, parseISO } from "date-fns";
import type { CampaignTemplate } from "../db/schema";

/** The campaign template is authoritative. An account's policy times are only used when the template lists no ongoing times. */
export type PlanAccount = { id: string; handle: string; timezone: string; policyTimes?: string[] };
export type PlannedSlot = { accountId: string; handle: string; plannedAt: Date; timezone: string; dayIndex: number; isDayOne: boolean; sequence: number };

export function parseHHmm(s: string): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`Invalid time "${s}", expected HH:mm`);
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) throw new Error(`Invalid time "${s}"`);
  return { h, m: mm };
}

/** Local wall-clock (date + HH:mm in tz) → absolute instant. DST gaps resolve forward, overlaps to the first instance. */
export function localToInstant(dateIso: string, hhmm: string, timezone: string): Date {
  const [y, mo, d] = dateIso.split("-").map(Number) as [number, number, number];
  const { h, m } = parseHHmm(hhmm);
  const tz = new TZDate(y, mo - 1, d, h, m, 0, 0, timezone);
  return new Date(tz.getTime());
}

export function formatInTz(date: Date, timezone: string, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }): string {
  return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: timezone }).format(date);
}

export function isoDateInTz(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Generates the planned slots for a campaign across accounts.
 * Day one (start date): N posts, `spacingMinutes` apart from `firstTime`.
 * Ongoing days: the template times (or the account's policy times when the template times are empty).
 * Limits cap the number of slots per account and in total, in chronological order per account.
 */
export function generatePlan(params: {
  template: CampaignTemplate;
  startDate: string;
  endDate: string;
  accounts: PlanAccount[];
}): PlannedSlot[] {
  const { template, startDate, endDate, accounts } = params;
  const start = parseISO(startDate);
  const end = parseISO(endDate);
  if (isBefore(end, start)) throw new Error("Campaign end must be on or after the start date.");
  const totalDays = differenceInCalendarDays(end, start) + 1;
  if (totalDays > 120) throw new Error("Campaigns are limited to 120 days. Split longer runs into separate campaigns.");
  const out: PlannedSlot[] = [];
  let total = 0;
  const maxTotal = template.limits.maxPostsTotal ?? Infinity;

  for (const account of accounts) {
    const perAccount: PlannedSlot[] = [];
    const maxPerAccount = template.limits.maxPostsPerAccount ?? Infinity;
    for (let dayIndex = 0; dayIndex < totalDays; dayIndex++) {
      const dateIso = isoDateInTz(addDays(start, dayIndex), "UTC");
      if (dayIndex === 0 && template.dayOne.enabled) {
        const count = template.dayOne.count;
        const spacing = template.dayOne.spacingMinutes;
        const first = localToInstant(dateIso, template.dayOne.firstTime, account.timezone);
        for (let i = 0; i < count; i++) {
          perAccount.push({ accountId: account.id, handle: account.handle, plannedAt: addMinutes(first, i * spacing), timezone: account.timezone, dayIndex, isDayOne: true, sequence: 0 });
        }
        continue;
      }
      if (!template.ongoing.enabled) continue;
      const times = template.ongoing.times.length > 0 ? template.ongoing.times : (account.policyTimes ?? []);
      for (const t of times) {
        perAccount.push({ accountId: account.id, handle: account.handle, plannedAt: localToInstant(dateIso, t, account.timezone), timezone: account.timezone, dayIndex, isDayOne: false, sequence: 0 });
      }
    }
    perAccount.sort((a, b) => a.plannedAt.getTime() - b.plannedAt.getTime());
    let seq = 0;
    for (const slot of perAccount) {
      if (seq >= maxPerAccount || total >= maxTotal) break;
      slot.sequence = seq++;
      total++;
      out.push(slot);
    }
  }
  return out;
}

export type Conflict = { accountId: string; handle: string; plannedAt: Date; message: string; severity: "warning" | "error" };

/** Detects planned slots that are too close together or collide with existing scheduled jobs on the same account. */
export function findConflicts(
  slots: PlannedSlot[],
  existing: Array<{ accountId: string; plannedAt: Date; campaignName: string }>,
  minGapMinutes: number,
): Conflict[] {
  const conflicts: Conflict[] = [];
  const byAccount = new Map<string, PlannedSlot[]>();
  for (const s of slots) byAccount.set(s.accountId, [...(byAccount.get(s.accountId) ?? []), s]);
  for (const [accountId, list] of byAccount) {
    list.sort((a, b) => a.plannedAt.getTime() - b.plannedAt.getTime());
    for (let i = 1; i < list.length; i++) {
      const gap = (list[i]!.plannedAt.getTime() - list[i - 1]!.plannedAt.getTime()) / 60000;
      if (gap < minGapMinutes) {
        conflicts.push({ accountId, handle: list[i]!.handle, plannedAt: list[i]!.plannedAt, severity: "warning", message: `Planned ${Math.round(gap)} min after the previous post; actual publications will be spaced at least ${minGapMinutes} min apart, so this one may run late.` });
      }
    }
    for (const s of list) {
      for (const e of existing.filter((x) => x.accountId === accountId)) {
        const gap = Math.abs(s.plannedAt.getTime() - e.plannedAt.getTime()) / 60000;
        if (gap < minGapMinutes) {
          conflicts.push({ accountId, handle: s.handle, plannedAt: s.plannedAt, severity: "error", message: `Collides with a post already scheduled by “${e.campaignName}” ${Math.round(gap)} min away.` });
        }
      }
    }
  }
  return conflicts;
}

/** Content coverage: does each account have enough assets for its slots? */
export function coverage(slots: PlannedSlot[], assetCount: number): { needed: number; available: number; shortfallByAccount: Record<string, number> } {
  const perAccount = new Map<string, number>();
  for (const s of slots) perAccount.set(s.accountId, (perAccount.get(s.accountId) ?? 0) + 1);
  const shortfall: Record<string, number> = {};
  for (const [acc, n] of perAccount) if (n > assetCount) shortfall[acc] = n - assetCount;
  return { needed: slots.length, available: assetCount, shortfallByAccount: shortfall };
}
