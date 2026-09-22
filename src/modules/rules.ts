import type { RuleSet, Tier } from "../lib/types";

const singaporeDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Singapore",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function businessDay(date: Date): string {
  return singaporeDate.format(date);
}

export function businessMonth(date: Date): string {
  return businessDay(date).slice(0, 7);
}

export function pointsForAmount(amountCents: number, thresholdCents: number): number {
  return amountCents >= thresholdCents ? 1 : 0;
}

export function tierForVisits(visits: number, rules: RuleSet): Tier {
  return visits >= rules.goldVisits ? "gold" : visits >= rules.silverVisits ? "silver" : "bronze";
}
