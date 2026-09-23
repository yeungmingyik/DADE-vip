"use client";
import { BrandMark } from "@/components/shared/brand-mark";
import { apiRequest } from "@/lib/api-client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { ArrowRight, Building2, Languages, LoaderCircle, ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppLocale } from "@/components/shared/locale-provider";
import type { Role, Session } from "@/lib/types";

export function WorkplaceAuth({ role, enabled, accounts }: { role: Exclude<Role, "member">; enabled: boolean; accounts: Pick<Session, "userId" | "name">[] }) {
  const t = useTranslations("workplace");
  const locale = useLocale();
  const { setLocale } = useAppLocale();
  const router = useRouter();
  const [account, setAccount] = useState(accounts[0]?.userId ?? "");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const lock = useRef(false);
  const Icon = role === "staff" ? ScanLine : Building2;

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current || !enabled || !account) return;
    lock.current = true;
    setPending(true);
    setFailed(false);
    try {
      const response = await apiRequest("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role, personaId: account }) });
      if (!response.ok) throw new Error();
      router.replace(`/${locale}/${role}`);
      router.refresh();
    } catch {
      setFailed(true);
      setPending(false);
      lock.current = false;
    }
  }

  return <main className="min-h-svh bg-background text-foreground">
    <header className="mx-auto flex min-h-20 max-w-7xl items-center justify-between px-5 sm:px-10"><BrandMark /><Button variant="ghost" className="min-h-11 gap-2 text-xs" disabled={pending} aria-label={`${t("language")}: ${t("languageOption")}`} onClick={() => setLocale(locale === "en" ? "zh-CN" : "en")}><Languages className="size-4" />{t("languageOption")}</Button></header>
    <div className="mx-auto grid max-w-6xl gap-10 px-5 pb-12 pt-4 sm:px-10 lg:min-h-[75vh] lg:grid-cols-2 lg:gap-20 lg:pt-10">
      <section className="relative flex min-h-56 flex-col overflow-hidden rounded-[28px] bg-[#501b24] p-7 text-white sm:p-10 lg:min-h-[480px]">
        <div aria-hidden="true" className="absolute -bottom-40 -right-32 size-[480px] rounded-full border border-[#d9c6b2]/15" />
        <div aria-hidden="true" className="absolute -bottom-24 -right-16 size-80 rounded-full border border-[#d9c6b2]/15" />
        <div className="relative flex items-center justify-between"><span className="text-[10px] font-medium uppercase tracking-[.18em] text-[#e3d5cd]">{t(`${role}Access`)}</span><Icon className="size-6 stroke-[1.5] text-[#e3d5cd]" /></div>
        <div className="relative flex flex-1 items-center py-8 lg:py-16"><h1 className="text-4xl font-medium tracking-tight sm:text-5xl">{t(role)}</h1></div>
      </section>
      <section className="flex items-center lg:py-12"><form onSubmit={signIn} className="w-full space-y-7 rounded-2xl border bg-white p-6 sm:p-8 lg:border-0 lg:bg-transparent lg:p-0" aria-busy={pending}>
        <div><p className="eyebrow mb-3">{t(`${role}Access`)}</p><h2 className="text-3xl font-semibold tracking-tight">{t("signIn")}</h2></div>
        <div className="space-y-2.5"><label htmlFor="workplace-account" className="text-sm font-medium">{t("account")}</label><select id="workplace-account" value={account} onChange={(event) => { setAccount(event.target.value); setFailed(false); }} disabled={pending || !enabled} className="field-select h-13 w-full rounded-xl text-base">{accounts.map((item) => <option key={item.userId} value={item.userId}>{item.name}</option>)}</select></div>
        {(!enabled || failed || !accounts.length) && <p role="alert" className="text-sm text-destructive">{!enabled || !accounts.length ? t("unavailable") : t("failed")}</p>}
        <Button type="submit" disabled={pending || !enabled || !account} className="min-h-13 w-full gap-2 rounded-xl">{pending && <LoaderCircle className="size-4 motion-safe:animate-spin" />}{t(pending ? "signingIn" : "continue")}{!pending && <ArrowRight className="size-4" />}</Button>
      </form></section>
    </div>
  </main>;
}
