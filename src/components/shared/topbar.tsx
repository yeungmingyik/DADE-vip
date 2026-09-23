"use client";
import { apiRequest } from "@/lib/api-client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Languages, LogOut } from "lucide-react";
import { useAppLocale } from "./locale-provider";
import { Button } from "@/components/ui/button";
import { BrandMark } from "./brand-mark";
import { BRAND_LABEL } from "@/lib/brand";
import type { Role } from "@/lib/types";

export function Topbar({ role }: { role: Role }) {
  const locale = useLocale();
  const router = useRouter();
  const t = useTranslations("common");
  const { setLocale } = useAppLocale();
  const [signingOut, setSigningOut] = useState(false);
  const [failed, setFailed] = useState(false);
  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setFailed(false);
    try {
      const response = await apiRequest(`/api/session?role=${role}`, { method: "DELETE" });
      if (!response.ok) throw new Error();
      router.replace(`/${locale}/login`);
      router.refresh();
    } catch { setFailed(true); setSigningOut(false); }
  }
  return <header className="relative flex min-h-20 items-center justify-between gap-3 border-b bg-white/90 px-4 sm:px-8">
    <Link href={`/${locale}/${role}`} className="flex min-w-0 items-center gap-3" aria-label={BRAND_LABEL}>
      <BrandMark />
    </Link>
    <div className="flex items-center gap-1 sm:gap-2">
      <span className="mr-2 hidden text-xs font-medium text-muted-foreground sm:block">{t(role)}</span>
      <Button variant="ghost" size="sm" className="min-h-11 gap-1.5" onClick={() => setLocale(locale === "en" ? "zh-CN" : "en")} aria-label={`${t("language")}: ${t("languageOption")}`}><Languages className="size-4" /><span className="text-xs">{t("languageOption")}</span></Button>
      <Button variant="ghost" size="icon" className="size-11" disabled={signingOut} onClick={signOut} aria-label={t("signOut")}><LogOut className="size-4" /></Button>
    </div>
    {failed && <p role="alert" className="absolute right-4 top-full z-40 rounded-lg border bg-white p-3 text-xs text-destructive shadow-sm">{t("networkError")}</p>}
  </header>;
}
