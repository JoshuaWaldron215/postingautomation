export function fmtDateTime(d: Date | string | null | undefined, tz?: string, opts: Intl.DateTimeFormatOptions = {}): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz, ...opts }).format(date);
}
export function fmtTime(d: Date | string | null | undefined, tz?: string): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(date);
}
export function fmtDate(d: Date | string | null | undefined, tz?: string): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz }).format(date);
}
export function relTime(d: Date | string | null | undefined, now = new Date()): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  const diff = date.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const unit = abs < 60_000 ? ["s", 1000] : abs < 3_600_000 ? ["m", 60_000] : abs < 86_400_000 ? ["h", 3_600_000] : ["d", 86_400_000];
  const n = Math.round(abs / (unit[1] as number));
  if (abs < 45_000) return diff <= 0 ? "just now" : "in a moment";
  return diff < 0 ? `${n}${unit[0]} ago` : `in ${n}${unit[0]}`;
}
export function durationLabel(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}:${String(s).padStart(2, "0")}` : `0:${String(s).padStart(2, "0")}`;
}
export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
export function ageLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}
export function tzShort(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? tz;
  } catch {
    return tz;
  }
}
