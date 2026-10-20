/**
 * The engines count in days from the ledger's as-of date. People read dates.
 * Day N is `as_of_date + N` calendar days (UTC, so no timezone can shift it).
 */
export function dayDate(asOf: string, day: number): string {
  const date = new Date(`${asOf}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + day);
  return date.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}
