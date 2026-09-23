"use client";

import Image from "next/image";
import { BrandMark } from "@/components/shared/brand-mark";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Check, ChevronLeft, ChevronRight, CircleCheck, CreditCard, Gift as GiftIcon, History, QrCode, ReceiptText, RefreshCw, Sparkles, UserRound, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Topbar } from "@/components/shared/topbar";
import { dateTime, localText, money } from "@/lib/format";
import { useWorkspace } from "@/lib/use-workspace";
import { cn } from "@/lib/utils";
import type { Activity, Gift, Locale, Tier } from "@/lib/types";

type MemberTab = "card" | "rewards" | "activity" | "account";
type ActivityFilter = "all" | "purchases" | "redemptions";
type Feedback = { sequence: number; count: number; points: number; kind: Activity["kind"]; tier: Tier | null; aggregated: boolean };

const navigation = [
  { id: "card", icon: CreditCard },
  { id: "rewards", icon: GiftIcon },
  { id: "activity", icon: History },
  { id: "account", icon: UserRound },
] as const;

const tierRank = { bronze: 0, silver: 1, gold: 2 };

export function MemberApp() {
  const t = useTranslations("member");
  const locale = useLocale() as Locale;
  const [tab, setTab] = useState<MemberTab>("card");
  const [page, setPage] = useState(1);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [giftCategory, setGiftCategory] = useState("all");
  const [codeOpen, setCodeOpen] = useState(false);
  const [giftSelection, setSelectedGift] = useState<Gift | null>(null);
  const [selectedActivity, setSelectedActivity] = useState<Activity | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const seen = useRef<{ memberId: string; sequence: number; tier: Tier; points: number } | null>(null);
  const { data, loading, error, refresh } = useWorkspace("member", { section: "activity", page, activityKind: tab === "activity" ? activityFilter : "all" });
  const member = data?.selectedMember;

  useEffect(() => {
    if (!data?.selectedMember) {
      if (!loading && error) {
        seen.current = null;
        setFeedback(null);
        setSelectedActivity(null);
        setSelectedGift(null);
        setCodeOpen(false);
      }
      return;
    }
    const current = data.selectedMember;
    const head = data.latestActivity;
    const sequence = data.latestActivitySequence;
    const key = `sspc:member-feedback:${current.id}`;
    if (!seen.current || seen.current.memberId !== current.id) {
      seen.current = { memberId: current.id, sequence, tier: current.tier, points: current.points };
      setFeedback(null);
      setSelectedActivity(null);
      setSelectedGift(null);
      setCodeOpen(false);
      setPage(1);
      return;
    }
    if (sequence <= seen.current.sequence) {
      seen.current.sequence = sequence;
      seen.current.tier = current.tier;
      seen.current.points = current.points;
      return;
    }
    const updates = head.filter((item) => item.sequence > seen.current!.sequence);
    if (!updates.length) return;
    const latest = updates.reduce((a, b) => a.sequence > b.sequence ? a : b);
    const tier = tierRank[current.tier] > tierRank[seen.current.tier] ? current.tier : null;
    let played: string[] = [];
    try {
      const stored: unknown = JSON.parse(sessionStorage.getItem(key) || "[]");
      if (Array.isArray(stored)) played = stored.filter((id): id is string => typeof id === "string");
    } catch { played = []; }
    const unseen = updates.filter((item) => !played.includes(item.id));
    if (unseen.length) setFeedback({ sequence, count: unseen.length, points: current.points - seen.current.points, kind: latest.kind, tier, aggregated: updates.length === head.length && head.length >= 12 });
    seen.current = { memberId: current.id, sequence, tier: current.tier, points: current.points };
    try { sessionStorage.setItem(key, JSON.stringify([...played, ...unseen.map((item) => item.id)].slice(-48))); } catch { return; }
  }, [data, loading, error]);

  useEffect(() => {
    if (!feedback) return;
    const timeout = setTimeout(() => setFeedback(null), 8000);
    return () => clearTimeout(timeout);
  }, [feedback]);

  const switchTab = (next: MemberTab) => {
    setTab(next);
    setPage(1);
  };

  if (!data || !member) {
    return <div className="min-h-screen bg-[#f8f6f6]"><Topbar role="member" /><main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center gap-5 px-6 text-center"><CreditCard className="size-10 text-primary" /><p className="text-sm text-muted-foreground">{loading ? t("loading") : error || t("noSelection")}</p>{!loading && <Button variant="outline" onClick={() => void refresh()}>{t("retry")}</Button>}</main></div>;
  }

  const visitsTarget = member.tier === "bronze" ? data.rules.silverVisits : data.rules.goldVisits;
  const nextTier = member.tier === "bronze" ? "silver" : "gold";
  const quotaRemaining = Math.max(0, data.rules.monthlyLimit - member.monthlyRedeemed);
  const selectedGift = giftSelection ? data.gifts.find((gift) => gift.id === giftSelection.id) ?? { ...giftSelection, active: false } : null;
  const availableGifts = data.gifts.filter((gift) => gift.active && !gift.deleted);
  const visibleGifts = availableGifts.filter((gift) => giftCategory === "all" || gift.category === giftCategory);
  const activeStores = data.stores.filter((store) => store.status === "active" && !store.deleted);
  const activities = data.activity;
  const currentRedemption = selectedActivity && data.redemptions.find((item) => item.id === selectedActivity.referenceId);
  const currentPurchase = selectedActivity && data.purchases.find((item) => item.id === selectedActivity.referenceId);
  const storeName = (id: string) => {
    const store = data.stores.find((item) => item.id === id);
    return store ? localText(store.name, locale) : id;
  };
  const giftState = (gift: Gift) => {
    if (!gift.active || gift.deleted || member.status !== "active") return "unavailable";
    if (!activeStores.some((store) => (gift.stock[store.id] ?? 0) > 0)) return "outOfStock";
    if (quotaRemaining <= 0) return "quotaReached";
    if (member.points < gift.points) return "insufficient";
    return "available";
  };

  const activityRow = (item: Activity) => {
    const positive = item.pointsDelta > 0;
    const Icon = item.kind === "purchase" ? ReceiptText : ["redemption", "fulfilled"].includes(item.kind) ? GiftIcon : item.kind === "refund" ? ArrowUpRight : ArrowDownLeft;
    return <button key={item.id} onClick={() => setSelectedActivity(item)} className="group flex min-h-20 w-full items-center gap-3.5 border-b border-black/5 px-1 py-4 text-left last:border-b-0 focus-visible:outline-2 focus-visible:outline-primary">
      <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", positive ? "bg-emerald-50 text-emerald-800" : "bg-stone-100 text-stone-600")}><Icon className="size-[18px]" /></span>
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-[#282326]">{t(item.kind)}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{storeName(item.storeId)} <span className="px-1.5 text-stone-300">·</span> {dateTime(item.createdAt, locale)}</span></span>
      <span className="shrink-0 text-right"><span className={cn("block text-sm font-semibold tabular-nums", positive ? "text-emerald-800" : "text-[#282326]")}>{positive ? "+" : ""}{item.pointsDelta} <span className="text-[10px] font-medium">{t("pointUnit", { count: Math.abs(item.pointsDelta) })}</span></span>{item.amountCents !== undefined && <span className="mt-1 block text-xs tabular-nums text-muted-foreground">{money(item.amountCents, locale)}</span>}</span>
      <ChevronRight className="size-4 shrink-0 text-stone-300 transition-transform group-hover:translate-x-0.5" />
    </button>;
  };

  const giftCard = (gift: Gift, compact = false) => <button key={gift.id} onClick={() => setSelectedGift(gift)} className={cn("group min-w-0 overflow-hidden rounded-2xl border border-black/5 bg-white text-left transition duration-150 hover:border-primary/25 hover:shadow-sm focus-visible:outline-2 focus-visible:outline-primary", compact ? "grid grid-cols-[112px_minmax(0,1fr)] sm:grid-cols-[140px_minmax(0,1fr)]" : "flex flex-col")}>
    <div className={cn("relative overflow-hidden bg-[#f4eeef]", compact ? "min-h-36" : "aspect-[4/3]")}><Image src={gift.image} alt={localText(gift.name, locale)} fill sizes={compact ? "140px" : "(max-width: 768px) 50vw, 320px"} className="object-cover transition-transform duration-300 motion-safe:group-hover:scale-[1.035]" /></div>
    <div className={cn("flex min-w-0 flex-1 flex-col [overflow-wrap:anywhere]", compact ? "justify-center p-4" : "p-4 sm:p-5")}><span className="mb-2 text-[10px] font-medium uppercase tracking-[0.15em] text-stone-500">{t(gift.category)}</span><h3 className="font-medium leading-snug text-[#501b24]">{localText(gift.name, locale)}</h3><div className="mt-3 flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-semibold text-primary">{t("rewardCost", { points: gift.points })}</span><ArrowUpRight className="size-4 text-primary" /></div>{!compact && <span className={cn("mt-3 text-xs", giftState(gift) === "available" ? "text-emerald-700" : "text-stone-500")}>{t(giftState(gift))}</span>}</div>
  </button>;

  return <div className="min-h-screen bg-[#f8f6f6] text-[#282326]">
    <Topbar role="member" />
    <main className="mx-auto max-w-[1180px] px-4 pb-28 pt-7 sm:px-7 md:pb-14 md:pt-10 lg:px-10">
      <header className="mb-7 flex flex-wrap items-end justify-between gap-5 sm:mb-9">
        <div><p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.19em] text-primary/70">{t("membership")}</p><h1 className="text-[26px] font-medium tracking-[-0.035em] sm:text-[32px]">{tab === "card" ? t("greeting", { name: member.name.split(" ")[0] }) : tab === "rewards" ? t("rewardsSubtitle") : tab === "activity" ? t("activitySubtitle") : t("accountTitle")}</h1></div>
        <nav aria-label={t("membership")} className="hidden rounded-full border border-stone-200/80 bg-white p-1 md:flex">{navigation.map(({ id, icon: Icon }) => <button key={id} onClick={() => switchTab(id)} aria-current={tab === id ? "page" : undefined} className={cn("flex min-h-10 items-center gap-2 rounded-full px-4 text-xs font-medium transition-colors", tab === id ? "bg-primary text-white" : "text-stone-500 hover:text-primary")}><Icon className="size-3.5" />{t(id)}</button>)}</nav>
      </header>

      {error && <div role="alert" className="mb-5 flex items-center justify-between gap-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><span>{error}</span><Button variant="ghost" size="sm" onClick={() => void refresh()}>{t("retry")}</Button></div>}
      {feedback && <div key={feedback.sequence} role="status" className="fixed inset-x-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-lg items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-950 shadow-[0_12px_36px_-12px_rgba(40,35,38,0.18)] motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 md:bottom-6"><span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white"><CircleCheck className="size-5 text-emerald-700" /></span><div className="flex-1 text-sm"><p className="font-semibold">{feedback.tier ? t("newTier", { tier: t(feedback.tier) }) : feedback.aggregated ? t("activityUpdated") : feedback.count > 1 ? t("newActivity", { count: feedback.count }) : feedback.kind === "purchase" && feedback.points > 0 ? t("pointsReceived") : t(feedback.kind)}</p><button onClick={() => switchTab("activity")} className="mt-0.5 text-xs underline underline-offset-4">{t("viewActivity")}</button></div>{feedback.points !== 0 && <span className="font-semibold tabular-nums">{feedback.points > 0 ? "+" : ""}{feedback.points}</span>}<button aria-label={t("close")} onClick={() => setFeedback(null)} className="flex size-9 items-center justify-center rounded-full hover:bg-emerald-100"><X className="size-4" /></button></div>}

      {tab === "card" && <>
        <div className="grid grid-cols-1 items-stretch gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-7">
          <section className={cn("relative isolate flex min-h-[304px] flex-col overflow-hidden rounded-[24px] bg-[#501b24] p-6 text-[#fff8f7] shadow-[0_12px_32px_-18px_rgba(80,27,36,0.3)] sm:min-h-[328px] sm:p-8", member.tier === "gold" && "bg-[#5c252b]")} aria-label={t("card")}>
            <div aria-hidden="true" className="pointer-events-none absolute -right-28 -top-32 -z-10 size-[480px] rounded-full border border-[#efbcc4]/[0.09]" /><div aria-hidden="true" className="pointer-events-none absolute -right-8 -top-12 -z-10 size-[320px] rounded-full border border-[#efbcc4]/[0.12]" /><div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-28 -z-10 size-[350px] rounded-full bg-[#df8997]/[0.10]" />
            <div className="flex items-center justify-between gap-2"><BrandMark onDark /><span className={cn("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1.5 text-[10px] font-medium sm:px-3", member.tier === "gold" ? "border-[#e5ce95]/50 bg-[#b89045]/15 text-[#f1db9b]" : member.tier === "silver" ? "border-[#e2e4ea]/40 bg-white/8 text-[#eff0f3]" : "border-[#e3b6a2]/45 bg-[#d39677]/10 text-[#f0c9b5]")}><Sparkles className="size-3 shrink-0" />{t("membershipTier", { tier: t(member.tier) })}</span></div>
            <div className="mt-9"><p className="text-[11px] text-[#f0cdd3]">{t("availablePoints")}</p><div className="mt-1.5 flex items-baseline gap-2"><span key={member.points} className={cn("inline-block origin-bottom-left text-[64px] font-light leading-none tracking-[-0.055em] tabular-nums sm:text-[72px]", feedback?.kind === "purchase" && feedback.points > 0 && "motion-safe:animate-[points-settle_320ms_ease-out]")}>{member.points}</span><span className="text-xs text-[#f0cdd3]">{t("pointUnit", { count: member.points })}</span></div></div>
            <div className="mt-auto flex items-end justify-between gap-4 pt-8"><div><p className="text-sm font-medium tracking-wide">{member.name}</p><p className="mt-1.5 font-mono text-[10px] tracking-[0.2em] text-[#e8bbc4]">{member.number}</p></div><button onClick={() => setCodeOpen(true)} aria-label={t("showCode")} className="flex size-[58px] shrink-0 items-center justify-center rounded-xl bg-[#fff8f7] text-[#501b24] transition-transform hover:bg-white active:scale-95"><QrCode className="size-8 stroke-[1.6]" /></button></div>
          </section>

          <section className="flex flex-col rounded-[24px] border border-stone-200/70 bg-white p-6 sm:p-7" aria-label={t("monthlyVisits")}>
            <div className="flex items-center justify-between"><p className="text-[10px] font-semibold tracking-[0.16em] text-stone-500">{t("monthlyLabel")}</p><span className="font-mono text-[10px] text-stone-400">{data.businessMonth}</span></div>
            <div className="mt-4 flex items-baseline gap-2"><span className="text-[40px] font-medium leading-none tracking-[-0.06em] tabular-nums">{member.visits}</span><span className="text-sm text-stone-400">{t("visitSuffix", { target: visitsTarget })}</span></div><p className="mt-2 text-xs text-stone-500">{t("monthlyVisits")}</p>
            <div className="mt-5 flex gap-2" aria-label={t("progressLabel", { current: member.visits, target: visitsTarget })}>{Array.from({ length: Math.min(visitsTarget, 12) }, (_, index) => <span key={index} title={`${t("visitCount", { count: Math.ceil(((index + 1) * visitsTarget) / Math.min(visitsTarget, 12)) })}: ${t(Math.ceil(((index + 1) * visitsTarget) / Math.min(visitsTarget, 12)) <= member.visits ? "completed" : "remaining")}`} className={cn("flex h-8 flex-1 items-center justify-center rounded-[8px] border", Math.ceil(((index + 1) * visitsTarget) / Math.min(visitsTarget, 12)) <= member.visits ? "border-primary bg-primary text-white" : "border-stone-200 bg-[#f8f6f6] text-stone-300")}>{Math.ceil(((index + 1) * visitsTarget) / Math.min(visitsTarget, 12)) <= member.visits ? <Check className="size-3.5" /> : <span className="size-1 rounded-full bg-current" />}</span>)}</div>
            <p className="mt-3 text-xs font-medium text-primary">{member.tier === "gold" ? t("topTier") : t("nextTier", { count: Math.max(0, visitsTarget - member.visits), tier: t(nextTier) })}</p>
            <div className="mt-auto flex items-center gap-3 border-t border-stone-100 pt-5 max-lg:mt-5"><span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#fce9eb] text-primary"><GiftIcon className="size-4" /></span><div className="flex-1"><p className="text-xs font-medium">{t("rewardAllowance")}</p><p className="mt-1 text-[11px] text-stone-500">{t("quota", { remaining: quotaRemaining, total: data.rules.monthlyLimit })}</p></div><button onClick={() => switchTab("rewards")} aria-label={t("viewAll")} className="flex size-10 items-center justify-center rounded-full hover:bg-stone-50"><ArrowRight className="size-4" /></button></div>
          </section>
        </div>
        <div className="mt-9 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-7">
          <section className="min-w-0"><div className="mb-4 flex items-center justify-between gap-4"><h2 className="text-lg font-medium tracking-tight">{t("rewards")}</h2><button onClick={() => switchTab("rewards")} className="flex min-h-9 items-center gap-1.5 text-xs font-medium text-primary">{t("viewAll")}<ArrowRight className="size-3.5" /></button></div><div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">{availableGifts.length ? availableGifts.slice(0, 2).map((gift) => giftCard(gift, true)) : <p className="col-span-full py-10 text-center text-sm text-muted-foreground">{t("noRewards")}</p>}</div></section>
          <section className="min-w-0"><div className="mb-1 flex items-center justify-between gap-4"><h2 className="text-lg font-medium tracking-tight">{t("recentActivity")}</h2><button onClick={() => switchTab("activity")} className="flex min-h-10 items-center gap-1.5 text-xs font-medium text-primary">{t("viewAll")}<ArrowRight className="size-3.5" /></button></div>{data.activity.length ? data.activity.slice(0, 3).map(activityRow) : <p className="py-9 text-center text-sm text-muted-foreground">{t("noActivity")}</p>}</section>
        </div>
      </>}

      {tab === "rewards" && <section>
        <div className="mb-7 flex flex-wrap items-center justify-between gap-4"><div className="flex flex-wrap gap-2">{["all", "tools", "lifestyle", "care"].map((category) => <button key={category} aria-pressed={giftCategory === category} onClick={() => setGiftCategory(category)} className={cn("min-h-10 rounded-full border px-5 text-xs font-medium transition-colors", giftCategory === category ? "border-primary bg-primary text-white" : "border-stone-200 bg-white text-stone-500")}>{t(category)}</button>)}</div><p className="text-xs text-stone-500">{t("quota", { remaining: quotaRemaining, total: data.rules.monthlyLimit })}</p></div>
        {visibleGifts.length ? <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3">{visibleGifts.map((gift) => giftCard(gift))}</div> : <p className="py-20 text-center text-muted-foreground">{t("noRewards")}</p>}
      </section>}

      {tab === "activity" && <section className="mx-auto max-w-3xl rounded-[24px] border border-stone-200/70 bg-white p-5 sm:p-7">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div className="flex gap-1 rounded-full bg-stone-100 p-1">{(["all", "purchases", "redemptions"] as const).map((filter) => <button key={filter} onClick={() => { setActivityFilter(filter); setPage(1); }} aria-pressed={activityFilter === filter} className={cn("min-h-9 rounded-full px-4 text-xs font-medium", activityFilter === filter ? "bg-white shadow-sm" : "text-stone-500")}>{t(filter)}</button>)}</div><Button variant="ghost" size="icon" onClick={() => void refresh()} aria-label={t("refresh")}><RefreshCw className="size-4" /></Button></div>
        {activities.length ? activities.map(activityRow) : <p className="py-16 text-center text-sm text-muted-foreground">{t("noActivity")}</p>}
        {data.pagination.total > data.pagination.pageSize && <div className="mt-5 flex items-center justify-between border-t pt-4"><Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)}><ChevronLeft className="size-4" />{t("previous")}</Button><span className="text-xs text-muted-foreground">{t("page", { page })}</span><Button variant="outline" size="sm" disabled={page * data.pagination.pageSize >= data.pagination.total || loading} onClick={() => setPage((value) => value + 1)}>{t("next")}<ChevronRight className="size-4" /></Button></div>}
      </section>}

      {tab === "account" && <section className="mx-auto max-w-2xl overflow-hidden rounded-[24px] border border-stone-200/70 bg-white"><div className="flex items-center gap-5 border-b border-stone-100 p-6 sm:p-8"><div className="flex size-16 items-center justify-center rounded-full bg-[#fce9eb] text-xl font-medium text-[#92202c]">{member.name.split(" ").map((part) => part[0]).slice(0, 2).join("")}</div><div><h2 className="text-xl font-medium">{member.name}</h2><p className="mt-2 text-xs text-stone-500">{t(member.tier)} · {member.number}</p></div><Badge className="ml-auto" variant="outline">{t(member.status)}</Badge></div><dl className="divide-y divide-stone-100 px-6 sm:px-8">{[[t("memberNumber"), member.number], [t("phone"), member.phone], [t("joined"), dateTime(member.joinedAt, locale)], [t("totalSpend"), money(member.totalSpendCents, locale)], [t("availablePoints"), String(member.points)]].map(([label, value]) => <div key={label} className="flex flex-wrap items-center justify-between gap-3 py-5 text-sm"><dt className="text-stone-500">{label}</dt><dd className="font-medium">{value}</dd></div>)}</dl><div className="p-6 pt-3 sm:px-8"><Button onClick={() => setCodeOpen(true)} className="h-11 w-full rounded-full bg-primary"><QrCode className="size-4" />{t("showCode")}</Button></div></section>}
    </main>

    <nav aria-label={t("membership")} className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-stone-200/80 bg-[#fffcfc] px-3 pb-[max(env(safe-area-inset-bottom),8px)] pt-2 md:hidden">{navigation.map(({ id, icon: Icon }) => <button key={id} onClick={() => switchTab(id)} aria-current={tab === id ? "page" : undefined} className={cn("flex min-h-[56px] flex-col items-center justify-center gap-1.5 rounded-xl text-[10px] font-medium", tab === id ? "text-primary" : "text-stone-400")}><span className={cn("rounded-full px-5 py-1", tab === id && "bg-[#fce9eb]")}><Icon className="size-5" strokeWidth={tab === id ? 2 : 1.6} /></span>{t(id)}</button>)}</nav>

    <Dialog open={codeOpen} onOpenChange={setCodeOpen}><DialogContent className="max-w-[360px] rounded-[24px] p-7"><DialogHeader><DialogTitle className="text-center text-xl">{t("memberCode")}</DialogTitle><DialogDescription className="text-center">{member.name} · {t(member.tier)}</DialogDescription></DialogHeader><div className="mx-auto rounded-2xl border border-stone-100 bg-white p-4"><QRCodeSVG value={member.code} size={232} level="M" marginSize={3} title={t("memberCode")} /></div><p className="text-center font-mono text-sm tracking-[0.15em]">{member.number}</p><Badge variant="outline" className="mx-auto">{t(member.status)}</Badge><Button variant="outline" className="mt-2 h-11 rounded-full" onClick={() => setCodeOpen(false)}>{t("close")}</Button></DialogContent></Dialog>

    <Dialog open={selectedGift !== null} onOpenChange={(open) => !open && setSelectedGift(null)}><DialogContent className="max-h-[90dvh] max-w-[430px] overflow-y-auto rounded-[24px] p-0">{selectedGift && <><div className="relative aspect-[16/10] bg-[#f4eeef]"><Image src={selectedGift.image} alt={localText(selectedGift.name, locale)} fill sizes="430px" className="object-cover" /></div><div className="px-6 pb-6"><DialogHeader><DialogTitle className="text-xl">{localText(selectedGift.name, locale)}</DialogTitle><DialogDescription className="font-semibold text-primary">{t("rewardCost", { points: selectedGift.points })}</DialogDescription></DialogHeader><p className="mt-4 text-sm text-stone-500">{t(giftState(selectedGift))}</p><div className="mt-5 border-t border-stone-100 pt-5"><h3 className="text-xs font-semibold">{t("stock")}</h3><ul className="mt-3 space-y-3">{activeStores.map((store) => <li key={store.id} className="flex items-center justify-between gap-4 text-xs"><span>{localText(store.name, locale)}</span><span className="text-stone-500">{t("stockUnits", { count: selectedGift.stock[store.id] ?? 0 })}</span></li>)}</ul></div><Button disabled={giftState(selectedGift) !== "available"} className="mt-6 h-11 w-full rounded-full bg-primary" onClick={() => { setSelectedGift(null); setCodeOpen(true); }}><QrCode className="size-4" />{t("showCode")}</Button></div></>}</DialogContent></Dialog>

    <Dialog open={selectedActivity !== null} onOpenChange={(open) => !open && setSelectedActivity(null)}><DialogContent className="max-h-[90dvh] max-w-[410px] overflow-y-auto rounded-[24px] p-7">{selectedActivity && <><DialogHeader className="items-center"><span className="mb-2 flex size-14 items-center justify-center rounded-full bg-[#fce9eb] text-[#92202c]"><ReceiptText className="size-6" /></span><DialogTitle className="text-xl">{t(selectedActivity.kind)}</DialogTitle><DialogDescription>{t("receiptTitle")}</DialogDescription></DialogHeader><div className="border-b border-dashed border-stone-200 py-5 text-center"><span className="text-4xl font-medium tracking-tight tabular-nums text-[#501b24]">{selectedActivity.pointsDelta > 0 ? "+" : ""}{selectedActivity.pointsDelta}</span><span className="ml-2 text-sm text-stone-500">{t("pointUnit", { count: Math.abs(selectedActivity.pointsDelta) })}</span></div><dl className="space-y-4 py-2 text-sm">{[[t("reference"), currentPurchase?.receipt ?? selectedActivity.referenceId], [t("store"), storeName(selectedActivity.storeId)], [t("time"), dateTime(selectedActivity.createdAt, locale)], ...(selectedActivity.amountCents !== undefined ? [[t("amount"), money(selectedActivity.amountCents, locale)]] : []), ...(currentRedemption ? [[t("reward"), localText(currentRedemption.giftName, locale)], [t("quantity"), String(currentRedemption.quantity)], [t("status"), t(currentRedemption.status === "fulfilled" ? "fulfilledState" : currentRedemption.status === "cancelled" ? "cancelledState" : "confirmed")]] : []), [t("balanceAfter"), `${selectedActivity.balanceAfter} ${t("pointUnit", { count: Math.abs(selectedActivity.balanceAfter) })}`]].map(([label, value]) => <div key={label} className="flex justify-between gap-5"><dt className="shrink-0 text-stone-500">{label}</dt><dd className="break-all text-right font-medium">{value}</dd></div>)}</dl>{selectedActivity.kind === "purchase" && selectedActivity.pointsDelta === 0 && selectedActivity.amountCents !== undefined && <p className="rounded-lg bg-stone-50 p-3 text-xs text-stone-500">{t("noPoints")}</p>}<Button variant="outline" className="mt-2 h-11 rounded-full" onClick={() => setSelectedActivity(null)}>{t("close")}</Button></>}</DialogContent></Dialog>
  </div>;
}
