"use client";

import { useEffect, useState, useId } from "react";
import { BRAND_NAME } from "@/lib/brand";
import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowDownToLine, ArrowRight, ArrowUpRight, ChevronLeft, ChevronRight, CircleDollarSign, Ellipsis, Gift as GiftIcon, LayoutDashboard, Loader2, Menu, Package, ReceiptText, RefreshCw, Search, Settings2, ShieldCheck, Store as StoreIcon, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ExportLink } from "@/components/shared/export-link";
import { Topbar } from "@/components/shared/topbar";
import { Catalog } from "@/components/admin/catalog";
import { useWorkspace } from "@/lib/use-workspace";
import { cn } from "@/lib/utils";
import { dateTime, localText, money } from "@/lib/format";
import type { AppData, Member, Purchase, Redemption, Staff, StateQuery } from "@/lib/types";

const navigation = [
  { key: "overview", icon: LayoutDashboard }, { key: "members", icon: Users }, { key: "purchases", icon: ReceiptText }, { key: "redemptions", icon: GiftIcon }, { key: "gifts", icon: Package }, { key: "stores", icon: StoreIcon }, { key: "staff", icon: ShieldCheck }, { key: "settings", icon: Settings2 }
] as const;
type Section = typeof navigation[number]["key"];
type Modal = { type: "member"; value: Member } | { type: "refund"; value: Purchase } | { type: "staff"; value: Staff } | { type: "fulfill" | "cancel"; value: Redemption } | null;

function initials(name: string) { return name.split(" ").map(word => word[0]).slice(0, 2).join(""); }

function ActivityChart({ data, locale, label }: { data: AppData["series"]; locale: string; label: string }) {
  const id = useId().replace(/:/g, "");
  const max = Math.max(100, ...data.map(point => point.amountCents));
  const points = data.map((point, index) => `${44 + index * 650 / Math.max(1, data.length - 1)},${185 - point.amountCents / max * 142}`);
  const line = points.length ? `M${points.join(" L")}` : "M44,185 L694,185";
  return <div className="mt-5"><svg role="img" aria-label={label} viewBox="0 0 730 225" className="w-full overflow-visible"><defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#79ac7e" stopOpacity=".3" /><stop offset="100%" stopColor="#79ac7e" stopOpacity=".01" /></linearGradient></defs>{[0, 1, 2, 3].map(index => <g key={index}><line x1="44" x2="702" y1={43 + index * 47.3} y2={43 + index * 47.3} stroke="#e8ece5" strokeDasharray="3 5" /><text x="0" y={47 + index * 47.3} fill="#8b958c" fontSize="10">{Math.round(max * (1 - index / 3) / 100)}</text></g>)}<path d={`${line} L694,185 L44,185 Z`} fill={`url(#${id})`} /><path d={line} fill="none" stroke="#397553" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />{data.filter((_, index) => index === 0 || index === data.length - 1 || index === Math.floor(data.length / 2)).map(point => { const index = data.indexOf(point); return <text key={point.date} x={44 + index * 650 / Math.max(1, data.length - 1)} y="216" textAnchor={index === 0 ? "start" : index === data.length - 1 ? "end" : "middle"} fill="#7d8a81" fontSize="11">{new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "Asia/Singapore" }).format(new Date(point.date))}</text>; })}</svg></div>;
}

const auditLabels: Record<string, string> = { deleteGift: "deleteGiftAudit", deleteStore: "deleteStoreAudit", refund: "refundAudit", fulfill: "fulfillAudit", cancel: "cancelAudit" };

export function AdminApp() {
  const t = useTranslations("admin");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const section: Section = navigation.some(item => item.key === params.get("section")) ? params.get("section") as Section : "overview";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const search = params.get("search") || "";
  const storeId = params.get("storeId") || "";
  const period = (["week", "month", "all"].includes(params.get("period") || "") ? params.get("period") : "month") as NonNullable<StateQuery["period"]>;
  const [searchInput, setSearchInput] = useState(search);
  const [menu, setMenu] = useState(false);
  const [modalState, setModal] = useState<Modal>(null);
  const [validation, setValidation] = useState("");
  const { data, loading, error, busy, refresh, mutate } = useWorkspace("admin", { section, page, search, storeId, period });
  const modal: Modal = (() => {
    if (!data || !modalState) return null;
    if (modalState.type === "member") {
      const value = data.members.find(item => item.id === modalState.value.id);
      return value ? { type: "member", value } : null;
    }
    if (modalState.type === "refund") {
      const value = data.purchases.find(item => item.id === modalState.value.id);
      return value ? { type: "refund", value } : null;
    }
    if (modalState.type === "fulfill" || modalState.type === "cancel") {
      const value = data.redemptions.find(item => item.id === modalState.value.id);
      return value?.status === "confirmed" ? { type: modalState.type, value } : null;
    }
    return modalState;
  })();

  function queryUpdate(values: Record<string, string>) {
    const next = new URLSearchParams(params.toString());
    Object.entries(values).forEach(([key, value]) => value ? next.set(key, value) : next.delete(key));
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }
  function changeSection(next: Section) { queryUpdate({ section: next, page: "", search: "" }); setSearchInput(""); setMenu(false); }
  useEffect(() => { setSearchInput(search); }, [search]);
  useEffect(() => {
    if (!storeId || !data?.stores.some(store => store.id === storeId && store.deleted)) return;
    const next = new URLSearchParams(params.toString());
    next.delete("storeId");
    next.delete("page");
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }, [data?.stores, storeId, params, pathname, router]);
  useEffect(() => {
    if (searchInput === search) return;
    const timeout = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      next.delete("page");
      if (searchInput) next.set("search", searchInput); else next.delete("search");
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    }, 300);
    return () => clearTimeout(timeout);
  }, [searchInput, search, params, pathname, router]);
  function open(value: Modal) { setValidation(""); setModal(value); }
  const storeName = (id: string) => { const store = data?.stores.find(item => item.id === id); return store ? localText(store.name, locale) : id; };
  const statusBadge = (status: string) => <Badge variant="outline" className={cn("border-0 px-2 py-1 text-[10px] font-medium", ["active", "fulfilled", "registered"].includes(status) ? "bg-emerald-50 text-emerald-800" : ["confirmed", "partiallyRefunded"].includes(status) ? "bg-amber-50 text-amber-800" : "bg-stone-100 text-stone-600")}>{t.has(status) ? t(status) : status}</Badge>;
  const tierBadge = (tier: string) => <Badge variant="outline" className={cn("font-medium text-[10px]", tier === "gold" ? "border-[#e7d9b4] bg-[#fbf6e6] text-[#8a6c27]" : tier === "silver" ? "border-slate-200 bg-slate-50 text-slate-600" : "border-[#ead7c4] bg-[#faf2e9] text-[#8d664b]")}>{t(tier)}</Badge>;

  const nav = <><div className="px-5 pb-7 pt-8"><p className="text-[9px] font-semibold tracking-[.22em] text-[#92b5a6]">{t("workspace")}</p><p className="mt-2 text-xl font-semibold text-white">{BRAND_NAME} VIP<span className="ml-1 text-[#d6e5b9]">.</span></p></div><nav className="space-y-1 px-3" aria-label={t("administration")}>{navigation.map(({ key, icon: Icon }, index) => <div key={key} className={index === 5 ? "mt-8! border-t border-white/10 pt-6" : ""}><button onClick={() => changeSection(key)} aria-current={section === key ? "page" : undefined} className={cn("flex min-h-11 w-full items-center gap-3 rounded-xl px-4 text-sm transition-colors", section === key ? "bg-[#d1e4bf] font-semibold text-[#183e32]" : "text-[#bdd0c5] hover:bg-white/7 hover:text-white")}><Icon className="size-[17px]" />{t(key)}{key === "redemptions" && !!data?.stats.pendingRedemptions && <span className="ml-auto rounded-md bg-white/15 px-1.5 text-[10px]">{data.stats.pendingRedemptions}</span>}</button></div>)}</nav><div className="mt-auto p-5"><div className="flex items-center gap-3 border-t border-white/10 pt-5"><div className="grid size-9 place-items-center rounded-full bg-[#547a60] text-xs font-semibold text-white">HQ</div><div><p className="text-xs font-medium text-white">{data?.session.name || BRAND_NAME}</p><p className="mt-1 text-[10px] text-[#a6bfaf]">{t("headquarters")}</p></div></div></div></>;

  function purchaseTable(rows: Purchase[]) { return <Table><TableHeader><TableRow><TableHead>{t("member")}</TableHead><TableHead>{t("receipt")}</TableHead><TableHead>{t("store")}</TableHead><TableHead className="text-right">{t("amount")}</TableHead><TableHead className="text-right">{t("earned")}</TableHead><TableHead>{t("date")}</TableHead><TableHead>{t("status")}</TableHead>{section === "purchases" && <TableHead className="text-right">{t("actions")}</TableHead>}</TableRow></TableHeader><TableBody>{rows.map(row => <TableRow key={row.id}><TableCell><span className="flex items-center gap-2.5"><span className="grid size-8 shrink-0 place-items-center rounded-full bg-[#edf0e7] text-[10px] font-semibold text-[#5c7357]">{initials(row.memberName)}</span><span className="font-medium">{row.memberName}</span></span></TableCell><TableCell className="font-mono text-[10px] text-muted-foreground">{row.receipt}</TableCell><TableCell>{storeName(row.storeId)}</TableCell><TableCell className="text-right font-medium tabular-nums">{money(row.amountCents, locale)}</TableCell><TableCell className="text-right text-emerald-700">+{row.points}</TableCell><TableCell className="whitespace-nowrap text-muted-foreground">{dateTime(row.createdAt, locale)}</TableCell><TableCell>{statusBadge(row.refundedCents === 0 ? "registered" : row.refundedCents < row.amountCents ? "partiallyRefunded" : "refunded")}</TableCell>{section === "purchases" && <TableCell className="text-right"><Button size="sm" variant="ghost" disabled={row.refundedCents >= row.amountCents} onClick={() => open({ type: "refund", value: row })}>{t("refund")}</Button></TableCell>}</TableRow>)}</TableBody></Table>; }

  function pagination() { if (!data) return null; const pages = Math.max(1, Math.ceil(data.pagination.total / data.pagination.pageSize)); return <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-4"><span className="text-xs text-muted-foreground">{t("records", { count: data.pagination.total })}</span><div className="flex items-center gap-3"><span className="text-xs text-muted-foreground">{t("page", { page, pages })}</span><Button variant="outline" size="icon" className="size-9" aria-label={t("previous")} disabled={page <= 1 || loading} onClick={() => queryUpdate({ page: String(page - 1) })}><ChevronLeft className="size-4" /></Button><Button variant="outline" size="icon" className="size-9" aria-label={t("next")} disabled={page >= pages || loading} onClick={() => queryUpdate({ page: String(page + 1) })}><ChevronRight className="size-4" /></Button></div></div>; }

  async function submitModal(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!modal) return;
    const form = new FormData(event.currentTarget);
    let ok = false;
    setValidation("");
    if (modal.type === "refund") {
      const raw = String(form.get("amount") || "");
      if (!/^\d+(\.\d{1,2})?$/.test(raw)) { setValidation("invalidAmount"); return; }
      const amountCents = Math.round(Number(raw) * 100);
      if (amountCents <= 0 || amountCents > modal.value.amountCents - modal.value.refundedCents) { setValidation("invalidAmount"); return; }
      ok = await mutate({ action: "refund", purchaseId: modal.value.id, amountCents });
    } else if (modal.type === "staff") {
      const storeIds = form.getAll("stores").map(String);
      if (!storeIds.length) { setValidation("noStore"); return; }
      ok = await mutate({ action: "updateStaff", staffId: modal.value.id, role: form.get("role") === "supervisor" ? "supervisor" : "cashier", storeIds, active: form.get("active") === "on" });
    } else if (modal.type === "fulfill" || modal.type === "cancel") {
      ok = await mutate({ action: modal.type, redemptionId: modal.value.id });
    }
    if (ok) setModal(null);
  }

  const overview = data && <div className="space-y-6">
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[
      { title: "totalMembers", value: data.stats.members.toLocaleString(locale), sub: t("activeMemberCount", { count: data.stats.activeMembers }), icon: Users },
      { title: "registeredSpend", value: money(data.stats.salesCents, locale), sub: t("purchaseCount", { count: data.stats.purchaseCount }), icon: CircleDollarSign },
      { title: "pointsIssued", value: data.stats.pointsIssued.toLocaleString(locale), sub: t("pointUnit", { count: data.stats.pointsIssued }), icon: ArrowUpRight },
      { title: "rewardsRedeemed", value: data.stats.redemptionCount.toLocaleString(locale), sub: t("pendingCollectionCount", { count: data.stats.pendingRedemptions }), icon: GiftIcon }
    ].map(({ title, value, sub, icon: Icon }) => <Card key={title} className="gap-0 border-[#e3e7dd] py-5 shadow-none"><CardContent className="px-5"><div className="flex items-center justify-between"><p className="text-xs font-medium text-muted-foreground">{t(title)}</p><Icon className="size-4 text-[#769174]" /></div><p className="mt-5 text-[29px] font-semibold tracking-[-.04em] tabular-nums">{value}</p><p className="mt-2 text-[11px] text-muted-foreground">{sub}</p></CardContent></Card>)}</div>
    <div className="grid gap-5 xl:grid-cols-[1.9fr_1fr]"><Card className="gap-0 shadow-none"><CardHeader className="flex flex-row items-start justify-between pb-0"><div><CardTitle className="text-base">{t("purchaseActivity")}</CardTitle><p className="mt-1.5 text-xs text-muted-foreground">{t("purchaseActivitySub")}</p></div><span className="rounded-md bg-[#edf3e8] px-2 py-1 text-[10px] font-medium text-[#51764c]">{data.series.length ? `${new Intl.DateTimeFormat(locale, {month:"short",day:"numeric"}).format(new Date(data.series[0].date))} – ${new Intl.DateTimeFormat(locale, {month:"short",day:"numeric"}).format(new Date(data.series[data.series.length-1].date))}` : t(period)}</span></CardHeader><CardContent><ActivityChart data={data.series} locale={locale} label={t("purchaseActivity")} /></CardContent></Card><Card className="shadow-none"><CardHeader><CardTitle className="text-base">{t("membershipMix")}</CardTitle></CardHeader><CardContent className="space-y-6">{(["gold", "silver", "bronze"] as const).map((tier, index) => { const count = data.stats.tierCounts[tier]; const percentage = data.stats.members ? Math.round(count / data.stats.members * 100) : 0; return <div key={tier}><div className="mb-2 flex items-center justify-between text-xs"><span className="flex items-center gap-2"><span className={cn("size-2 rounded-full", index === 0 ? "bg-[#b49a53]" : index === 1 ? "bg-[#97aaa8]" : "bg-[#779577]")} />{t(tier)}</span><span className="tabular-nums text-muted-foreground">{count} <span className="ml-2 text-[10px]">{percentage}%</span></span></div><div className="h-2 overflow-hidden rounded-full bg-[#f0f2ec]"><div className={cn("h-full rounded-full", index === 0 ? "bg-[#bba66d]" : index === 1 ? "bg-[#a6b8b4]" : "bg-[#8ca78a]")} style={{ width: `${percentage}%` }} /></div></div>; })}</CardContent></Card></div>
    <Card className="gap-0 overflow-hidden shadow-none"><CardHeader className="flex flex-row items-center justify-between border-b py-5"><CardTitle className="text-base">{t("recentPurchases")}</CardTitle><Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={() => changeSection("purchases")}>{t("viewAll")}<ArrowRight className="size-3.5" /></Button></CardHeader>{purchaseTable(data.purchases.slice(0, 6))}</Card>
  </div>;

  return <div className="admin-shell grid h-dvh grid-rows-[auto_minmax(0,1fr)] overflow-hidden"><Topbar role="admin" /><div className="flex min-h-0 overflow-hidden"><aside className="hidden h-full w-[216px] shrink-0 flex-col overflow-y-auto overscroll-none bg-[#123d36] lg:flex">{nav}</aside><Dialog open={menu} onOpenChange={setMenu}><DialogContent className="inset-y-0 left-0 top-0 h-dvh max-w-[280px] translate-x-0 translate-y-0 overflow-y-auto overscroll-none rounded-none border-0 bg-[#123d36] p-0 text-white"><DialogHeader className="sr-only"><DialogTitle>{t("menu")}</DialogTitle><DialogDescription>{t("workspace")}</DialogDescription></DialogHeader><div className="flex min-h-full flex-col">{nav}</div></DialogContent></Dialog>
    <main key={section} tabIndex={0} aria-label={t(section)} className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-none px-4 py-7 outline-none [scrollbar-gutter:stable] sm:px-7 lg:px-9"><div className="mx-auto max-w-[1450px] space-y-6"><div className="flex flex-wrap items-center justify-between gap-4"><div className="flex items-start gap-3"><Button className="lg:hidden" variant="outline" size="icon" onClick={() => setMenu(true)} aria-label={t("menu")}><Menu className="size-4" /></Button><div><div className="mb-2 flex items-center gap-2 text-[10px] text-muted-foreground"><span>{BRAND_NAME}</span><span>/</span><span>{t("headquarters")}</span></div><h1 className="page-heading">{t(section)}</h1>{section === "overview" && <p className="mt-2 text-xs text-muted-foreground">{t("overviewSubtitle")}</p>}</div></div><div className="flex flex-wrap gap-2">{["overview", "members", "purchases", "redemptions"].includes(section) && <select aria-label={t("store")} className="field-select max-w-40 text-xs" value={storeId} onChange={event => queryUpdate({ storeId: event.target.value, page: "" })}><option value="">{t("allStores")}</option>{data?.stores.filter(store => !store.deleted).map(store => <option value={store.id} key={store.id}>{localText(store.name, locale)}</option>)}</select>}{["overview", "purchases", "redemptions"].includes(section) && <select aria-label={t("date")} className="field-select text-xs" value={period} onChange={event => queryUpdate({ period: event.target.value, page: "" })}>{["week", "month", "all"].map(value => <option key={value} value={value}>{t(value)}</option>)}</select>}<Button variant="outline" size="icon" aria-label={t("refresh")} disabled={loading} onClick={() => void refresh()}><RefreshCw className={cn("size-4", loading && "animate-spin")} /></Button></div></div>
    {error && <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-800">{error}<Button variant="ghost" size="sm" onClick={() => void refresh()}>{t("retry")}</Button></div>}
    {!data ? <div className="grid min-h-80 place-items-center text-sm text-muted-foreground"><span className="flex items-center gap-3">{loading && <Loader2 className="size-5 animate-spin" />}{loading ? t("loading") : error || t("noRecords")}</span></div> : <>
      {section === "overview" && overview}
      {["members", "purchases", "redemptions", "staff"].includes(section) && <Card className="gap-0 overflow-hidden shadow-none"><div className="flex items-center justify-between gap-3 border-b p-4"><div className="relative w-full max-w-80"><Search className="absolute left-3 top-3 size-4 text-muted-foreground" /><Input className="pl-9" value={searchInput} onChange={event => setSearchInput(event.target.value)} placeholder={t("search")} aria-label={t("search")} /></div>{section === "purchases" && <Button variant="outline" className="gap-2" asChild><ExportLink aria-label={t("export")} href={`/api/export?${new URLSearchParams({ role: "admin", locale, section, search, storeId, period }).toString()}`}><ArrowDownToLine className="size-4" /><span className="hidden sm:inline">{t("export")}</span></ExportLink></Button>}</div>
      {section === "members" && <Table><TableHeader><TableRow>{["member", "phone", "status", "tier", "balance", "visits", "actions"].map(key => <TableHead key={key}>{t(key)}</TableHead>)}</TableRow></TableHeader><TableBody>{data.members.map(member => <TableRow key={member.id}><TableCell><button onClick={() => open({ type: "member", value: member })} className="flex items-center gap-3 text-left"><span className="grid size-9 place-items-center rounded-full bg-[#eaf0e3] text-xs font-semibold text-[#567044]">{initials(member.name)}</span><span><span className="block font-medium">{member.name}</span><span className="font-mono text-[10px] text-muted-foreground">{member.number}</span></span></button></TableCell><TableCell className="text-muted-foreground">{member.phone}</TableCell><TableCell>{statusBadge(member.status)}</TableCell><TableCell>{tierBadge(member.tier)}</TableCell><TableCell className="font-medium tabular-nums">{member.points}</TableCell><TableCell>{member.visits}</TableCell><TableCell><Button variant="ghost" size="icon" aria-label={`${t("profile")} ${member.name}`} onClick={() => open({ type: "member", value: member })}><Ellipsis className="size-4" /></Button></TableCell></TableRow>)}</TableBody></Table>}
      {section === "purchases" && purchaseTable(data.purchases)}
      {section === "redemptions" && <Table><TableHeader><TableRow>{["member", "reward", "store", "quantity", "points", "status", "date", "actions"].map(key => <TableHead key={key}>{t(key)}</TableHead>)}</TableRow></TableHeader><TableBody>{data.redemptions.map(row => <TableRow key={row.id}><TableCell className="font-medium">{row.memberName}</TableCell><TableCell>{localText(row.giftName, locale)}</TableCell><TableCell>{storeName(row.storeId)}</TableCell><TableCell>{row.quantity}</TableCell><TableCell>{row.points}</TableCell><TableCell>{statusBadge(row.status)}</TableCell><TableCell className="whitespace-nowrap text-xs text-muted-foreground">{dateTime(row.createdAt, locale)}</TableCell><TableCell><div className="flex gap-1"><Button size="sm" variant="outline" disabled={row.status !== "confirmed"} onClick={() => open({ type: "fulfill", value: row })}>{t("fulfill")}</Button><Button size="sm" variant="ghost" disabled={row.status !== "confirmed"} onClick={() => open({ type: "cancel", value: row })}>{t("cancel")}</Button></div></TableCell></TableRow>)}</TableBody></Table>}
      {section === "staff" && <Table><TableHeader><TableRow>{["name", "role", "access", "status", "actions"].map(key => <TableHead key={key}>{t(key)}</TableHead>)}</TableRow></TableHeader><TableBody>{data.staff.map(person => <TableRow key={person.id}><TableCell className="font-medium">{person.name}</TableCell><TableCell>{t(person.role)}</TableCell><TableCell>{person.storeIds.map(storeName).join(" · ")}</TableCell><TableCell>{statusBadge(person.active ? "active" : "inactive")}</TableCell><TableCell><Button variant="ghost" size="sm" onClick={() => open({ type: "staff", value: person })}>{t("edit")}</Button></TableCell></TableRow>)}</TableBody></Table>}
      {((section === "members" && !data.members.length) || (section === "purchases" && !data.purchases.length) || (section === "redemptions" && !data.redemptions.length) || (section === "staff" && !data.staff.length)) && <div className="p-12 text-center text-sm text-muted-foreground">{t("noRecords")}</div>}{pagination()}</Card>}
      {(section === "gifts" || section === "stores") && <Catalog key={section} kind={section} data={data} busy={busy} error={error} mutate={mutate} />}
      {section === "settings" && <div className="grid gap-5 xl:grid-cols-[1fr_1.2fr]"><Card className="shadow-none"><CardHeader><CardTitle className="text-lg">{t("earnRules")}</CardTitle><p className="text-xs text-muted-foreground">{t("ruleVersion")} {data.rules.version} · {dateTime(data.rules.effectiveAt, locale)}</p></CardHeader><CardContent><form className="space-y-4" onSubmit={async event => { event.preventDefault(); const form = new FormData(event.currentTarget); const thresholdCents = Math.round(Number(form.get("threshold")) * 100); const silverVisits = Number(form.get("silver")); const goldVisits = Number(form.get("gold")); const monthlyLimit = Number(form.get("limit")); if (![thresholdCents, silverVisits, goldVisits, monthlyLimit].every(value => Number.isSafeInteger(value) && value > 0) || goldVisits <= silverVisits) { setValidation("invalidRule"); return; } setValidation(""); await mutate({ action: "updateRules", thresholdCents, silverVisits, goldVisits, monthlyLimit }); }}>{[{ key: "threshold", label: "threshold", value: data.rules.thresholdCents / 100, step: "0.01" }, { key: "silver", label: "silverVisits", value: data.rules.silverVisits, step: "1" }, { key: "gold", label: "goldVisits", value: data.rules.goldVisits, step: "1" }, { key: "limit", label: "monthlyLimit", value: data.rules.monthlyLimit, step: "1" }].map(field => <label key={`${field.key}-${data.rules.version}`} className="block text-xs font-medium">{t(field.label)}<Input name={field.key} type="number" min="1" step={field.step} required defaultValue={field.value} className="mt-2" /></label>)}{validation && <p role="alert" className="text-xs text-destructive">{t(validation)}</p>}<Button disabled={busy} className="mt-2 w-full">{busy ? t("saving") : t("save")}</Button></form></CardContent></Card><Card className="gap-0 overflow-hidden shadow-none"><CardHeader><CardTitle className="text-lg">{t("audit")}</CardTitle></CardHeader><Table><TableHeader><TableRow><TableHead>{t("actor")}</TableHead><TableHead>{t("change")}</TableHead><TableHead>{t("date")}</TableHead></TableRow></TableHeader><TableBody>{data.audit.map(event => <TableRow key={event.id}><TableCell className="font-medium">{event.actor}</TableCell><TableCell>{t(auditLabels[event.action] ?? (t.has(event.action) ? event.action : "updated"))}</TableCell><TableCell className="text-xs text-muted-foreground">{dateTime(event.createdAt, locale)}</TableCell></TableRow>)}</TableBody></Table>{!data.audit.length && <p className="p-8 text-center text-sm text-muted-foreground">{t("noRecords")}</p>}</Card></div>}
    </>}
    </div></main></div>
    <Dialog open={modal !== null} onOpenChange={value => { if (!value) setModal(null); }}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>{modal?.type === "member" ? t("profile") : modal?.type === "staff" ? t("editStaff") : modal?.type === "refund" ? t("refundTitle") : modal?.type === "cancel" ? t("cancelRedemption") : t("fulfill")}</DialogTitle><DialogDescription>{modal?.type === "member" ? modal.value.number : t("confirmation")}</DialogDescription></DialogHeader>
    {modal?.type === "member" ? <div className="space-y-5"><div className="flex items-center gap-4"><span className="grid size-14 place-items-center rounded-full bg-[#eaf0e3] text-lg font-semibold">{initials(modal.value.name)}</span><div><h3 className="text-lg font-semibold">{modal.value.name}</h3><div className="mt-2 flex gap-2">{tierBadge(modal.value.tier)}{statusBadge(modal.value.status)}</div></div></div><div className="grid grid-cols-2 gap-4 rounded-xl bg-muted p-5">{[{ label: "balance", value: modal.value.points }, { label: "visits", value: modal.value.visits }, { label: "totalSpend", value: money(modal.value.totalSpendCents, locale) }, { label: "phone", value: modal.value.phone }].map(item => <div key={item.label}><p className="text-[10px] text-muted-foreground">{t(item.label)}</p><p className="mt-1.5 text-sm font-semibold">{item.value}</p></div>)}</div><Button disabled={busy} variant={modal.value.status === "active" ? "outline" : "default"} className="w-full" onClick={async () => { if (await mutate({ action: "updateMember", memberId: modal.value.id, status: modal.value.status === "active" ? "suspended" : "active" })) setModal(null); }}>{t(modal.value.status === "active" ? "suspend" : "reactivate")}</Button></div> : <form onSubmit={submitModal} className="space-y-5">
      {modal?.type === "refund" && <><div className="rounded-xl bg-muted p-4"><p className="text-sm font-semibold">{modal.value.memberName}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{modal.value.receipt}</p><div className="mt-4 flex justify-between text-sm"><span>{t("refundable")}</span><strong>{money(modal.value.amountCents - modal.value.refundedCents, locale)}</strong></div></div><label className="block text-sm">{t("refundAmount")}<Input name="amount" inputMode="decimal" autoFocus className="mt-2" required defaultValue={((modal.value.amountCents - modal.value.refundedCents) / 100).toFixed(2)} /></label></>}
      {modal?.type === "staff" && <><p className="text-lg font-semibold">{modal.value.name}</p><label className="block text-sm">{t("role")}<select name="role" className="field-select mt-2 w-full" defaultValue={modal.value.role}><option value="cashier">{t("cashier")}</option><option value="supervisor">{t("supervisor")}</option></select></label><fieldset className="space-y-3"><legend className="mb-3 text-sm font-medium">{t("access")}</legend>{data?.stores.filter(store => !store.deleted).map(store => <label className="flex items-center gap-3 text-sm" key={store.id}><input className="size-4 accent-[#19634e]" type="checkbox" name="stores" value={store.id} defaultChecked={modal.value.storeIds.includes(store.id)} />{localText(store.name, locale)}</label>)}</fieldset><label className="flex items-center gap-3 border-t pt-4 text-sm"><input className="size-4 accent-[#19634e]" name="active" type="checkbox" defaultChecked={modal.value.active} />{t("accountActive")}</label></>}
      {(modal?.type === "fulfill" || modal?.type === "cancel") && <div className="space-y-3 rounded-xl bg-muted p-5"><p className="font-semibold">{localText(modal.value.giftName, locale)}</p><p className="text-sm text-muted-foreground">{modal.value.memberName} · {storeName(modal.value.storeId)}</p><p className="text-sm">{t("rewardQuantity", { count: modal.value.quantity })} · {modal.value.points} {t("pointUnit", { count: modal.value.points })}</p></div>}
      {(validation || error) && <p role="alert" className="text-sm text-destructive">{validation ? t(validation) : error}</p>}<div className="flex gap-3 pt-2"><Button type="button" variant="outline" className="flex-1" onClick={() => setModal(null)}>{t("cancel")}</Button><Button disabled={busy} className="flex-1" type="submit">{busy ? t("saving") : modal?.type === "refund" ? t("confirmRefund") : t("confirmAction")}</Button></div>
    </form>}
    </DialogContent></Dialog>
  </div>;
}
