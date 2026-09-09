import { describe, expect, it } from "vitest";
import { coverage, findConflicts, generatePlan, localToInstant } from "./scheduling";

const template = { dayOne: { enabled: true, count: 3, spacingMinutes: 5, firstTime: "10:00" }, ongoing: { enabled: true, times: ["11:00", "18:00"] }, limits: { maxPostsPerAccount: null, maxPostsTotal: null } };

describe("scheduling", () => {
  it("converts local wall-clock times per account timezone, including DST", () => {
    // US DST starts 2026-03-08. 10:00 New York = 15:00 UTC on Mar 7 (EST), 14:00 UTC on Mar 9 (EDT).
    expect(localToInstant("2026-03-07", "10:00", "America/New_York").toISOString()).toBe("2026-03-07T15:00:00.000Z");
    expect(localToInstant("2026-03-09", "10:00", "America/New_York").toISOString()).toBe("2026-03-09T14:00:00.000Z");
    // London does not change until Mar 29.
    expect(localToInstant("2026-03-09", "10:00", "Europe/London").toISOString()).toBe("2026-03-09T10:00:00.000Z");
    // Sydney is UTC+11 in March (AEDT).
    expect(localToInstant("2026-03-09", "10:00", "Australia/Sydney").toISOString()).toBe("2026-03-08T23:00:00.000Z");
  });

  it("builds day-one bursts and ongoing daily slots per account, ordered and sequenced", () => {
    const plan = generatePlan({ template, startDate: "2026-03-07", endDate: "2026-03-09", accounts: [{ id: "a", handle: "a", timezone: "America/New_York" }, { id: "b", handle: "b", timezone: "Asia/Dubai" }] });
    const a = plan.filter((s) => s.accountId === "a");
    expect(a.map((s) => s.plannedAt.toISOString())).toEqual(["2026-03-07T15:00:00.000Z", "2026-03-07T15:05:00.000Z", "2026-03-07T15:10:00.000Z", "2026-03-08T15:00:00.000Z", "2026-03-08T22:00:00.000Z", "2026-03-09T15:00:00.000Z", "2026-03-09T22:00:00.000Z"]);
    expect(a.map((s) => s.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(a.filter((s) => s.isDayOne)).toHaveLength(3);
    expect(plan.filter((s) => s.accountId === "b")[0]!.plannedAt.toISOString()).toBe("2026-03-07T06:00:00.000Z");
  });

  it("applies finite limits per account and in total", () => {
    const limited = generatePlan({ template: { ...template, limits: { maxPostsPerAccount: 4, maxPostsTotal: 6 } }, startDate: "2026-03-07", endDate: "2026-03-20", accounts: [{ id: "a", handle: "a", timezone: "UTC" }, { id: "b", handle: "b", timezone: "UTC" }] });
    expect(limited.filter((s) => s.accountId === "a")).toHaveLength(4);
    expect(limited.filter((s) => s.accountId === "b")).toHaveLength(2);
    expect(() => generatePlan({ template, startDate: "2026-01-01", endDate: "2026-12-31", accounts: [] })).toThrow(/120 days/);
  });

  it("flags spacing warnings and collisions with existing scheduled posts", () => {
    const tight = generatePlan({ template: { ...template, dayOne: { ...template.dayOne, spacingMinutes: 2 } }, startDate: "2026-03-07", endDate: "2026-03-07", accounts: [{ id: "a", handle: "a", timezone: "UTC" }] });
    const conflicts = findConflicts(tight, [{ accountId: "a", plannedAt: new Date("2026-03-07T10:01:00Z"), campaignName: "Other" }], 5);
    expect(conflicts.some((c) => c.severity === "warning")).toBe(true);
    expect(conflicts.some((c) => c.severity === "error" && /Other/.test(c.message))).toBe(true);
  });

  it("reports content coverage shortfalls without recycling", () => {
    const plan = generatePlan({ template, startDate: "2026-03-07", endDate: "2026-03-08", accounts: [{ id: "a", handle: "a", timezone: "UTC" }] });
    expect(coverage(plan, 2)).toEqual({ needed: 5, available: 2, shortfallByAccount: { a: 3 } });
  });
});
