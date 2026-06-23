/**
 * ET calendar date helpers for live 1D attribution (startDate / endDate labels).
 */
export function todayEtIsoDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
