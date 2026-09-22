import type { LocalizedText } from "./types";

export function money(cents: number, locale: string) {
  return new Intl.NumberFormat(locale === "en" ? "en-SG" : "zh-SG", { style: "currency", currency: "SGD", currencyDisplay: "narrowSymbol" }).format(cents / 100);
}

export function dateTime(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale === "en" ? "en-SG" : "zh-SG", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" }).format(new Date(value));
}

export function localText(value: LocalizedText, locale: string) { return value[locale === "zh-CN" ? "zh-CN" : "en"]; }
