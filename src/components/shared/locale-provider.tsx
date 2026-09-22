"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import type { Locale, Role } from "@/lib/types";
import { commonMessages } from "@/messages/common";
import { memberMessages } from "@/messages/member";
import { staffMessages } from "@/messages/staff";
import { adminMessages } from "@/messages/admin";
import { authMessages } from "@/messages/auth";
import { workplaceMessages } from "@/messages/workplace";

const LocaleContext = createContext<{ setLocale: (locale: Locale) => void }>({ setLocale: () => {} });

export function LocaleProvider({ initialLocale, surface, children }: { initialLocale: Locale; surface: Role; children: ReactNode }) {
  const [locale, updateLocale] = useState<Locale>(initialLocale);
  useEffect(() => { updateLocale(initialLocale); }, [initialLocale]);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = `SSPC · ${commonMessages[locale][surface]}`;
  }, [locale, surface]);
  const setLocale = (next: Locale) => {
    updateLocale(next);
    document.documentElement.lang = next;
    document.cookie = `SSPC_LOCALE=${next};path=/;max-age=31536000;SameSite=Lax`;
    const url = new URL(window.location.href);
    url.pathname = url.pathname.replace(/\/(en|zh-CN)(?=\/|$)/, `/${next}`);
    window.history.replaceState(window.history.state, "", url);
    if (process.env.NEXT_PUBLIC_STATIC_DEMO === "true") window.dispatchEvent(new PopStateEvent("popstate"));
  };
  return <LocaleContext.Provider value={{ setLocale }}><NextIntlClientProvider locale={locale} timeZone="Asia/Singapore" messages={{ common: commonMessages[locale], member: memberMessages[locale], staff: staffMessages[locale], admin: adminMessages[locale], auth: authMessages[locale], workplace: workplaceMessages[locale] }}>{children}</NextIntlClientProvider></LocaleContext.Provider>;
}

export function useAppLocale() { return useContext(LocaleContext); }
