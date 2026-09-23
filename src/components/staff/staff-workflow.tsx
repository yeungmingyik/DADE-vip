"use client";

import Image from "next/image";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ClipboardList, Gift as GiftIcon, LayoutGrid, Minus, PackageCheck, Plus, ReceiptText, RefreshCw, RotateCcw, ScanLine, Search, Store as StoreIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Topbar } from "@/components/shared/topbar";
import { dateTime, localText, money } from "@/lib/format";
import { useWorkspace } from "@/lib/use-workspace";
import { cn } from "@/lib/utils";
import type { ActionResult, Gift, Locale, Member, Purchase, Redemption, StateQuery } from "@/lib/types";

type View = "home" | "transaction" | "handover" | "records";
type Task = "purchase" | "redeem";
type Step = 1 | 2 | 3 | 4;
type RecordTab = "purchases" | "redemptions";
type RecordDialog = { kind: "purchase"; record: Purchase; mode: "details" | "refund" } | { kind: "redemption"; record: Redemption; mode: "details" | "fulfill" | "cancel" } | null;

function parseCents(value: string) {
  if (!/^\d{1,7}(\.\d{0,2})?$/.test(value)) return 0;
  const [whole, fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return cents <= 100000000 ? cents : 0;
}

function receiptNumber() { return `SP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`; }
function initials(name: string) { return name.split(" ").map((part) => part[0]).slice(0, 2).join(""); }
function DetailRows({ rows }: { rows: [string, string][] }) {
  return <dl className="divide-y divide-stone-100">{rows.map(([label, value]) => <div key={label} className="flex justify-between gap-6 py-3.5 text-sm"><dt className="shrink-0 text-stone-500">{label}</dt><dd className="break-all text-right font-medium">{value}</dd></div>)}</dl>;
}

export function StaffApp() {
  const t = useTranslations("staff");
  const common = useTranslations("common");
  const locale = useLocale() as Locale;
  const [view, setView] = useState<View>("home");
  const [task, setTask] = useState<Task>("purchase");
  const [step, setStep] = useState<Step>(1);
  const [storeId, setStoreId] = useState("");
  const [memberId, setMemberId] = useState("");
  const [search, setSearch] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [recordTab, setRecordTab] = useState<RecordTab>("purchases");
  const [amount, setAmount] = useState("");
  const [receipt, setReceipt] = useState("");
  const [giftId, setGiftId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [recordDialog, setRecordDialog] = useState<RecordDialog>(null);
  const [refundAmount, setRefundAmount] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<"STORE_INACTIVE" | "GIFT_UNAVAILABLE" | "FORBIDDEN" | null>(null);
  const sessionIdentity = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const section: StateQuery["section"] = view === "transaction" ? step === 1 ? "members" : task === "purchase" ? "purchases" : "redemptions" : view === "handover" ? "redemptions" : view === "records" ? recordTab : "overview";
  const { data, loading, error, busy, refresh, submit } = useWorkspace("staff", {
    section, page, storeId: storeId || undefined,
    memberId: view === "transaction" && memberId ? memberId : undefined,
    search: view === "transaction" && step !== 1 ? undefined : searchQuery || undefined,
    redemptionStatus: view === "handover" ? "confirmed" : undefined,
  });
  const member = memberId && data?.selectedMember?.id === memberId ? data.selectedMember : null;

  useEffect(() => {
    const value = search.trim();
    if (value === searchQuery) return;
    if (!value) { setSearchQuery(""); setPage(1); return; }
    const timeout = setTimeout(() => { setSearchQuery(value); setPage(1); }, 300);
    return () => clearTimeout(timeout);
  }, [search, searchQuery]);
  useEffect(() => { heading.current?.focus({ preventScroll: false }); }, [view, step]);
  useEffect(() => {
    const identity = data?.session.userId;
    if ((!data && !loading && error) || (identity && sessionIdentity.current && identity !== sessionIdentity.current)) {
      setView("home"); setStep(1); setMemberId(""); setStoreId(""); setSearch(""); setSearchQuery(""); setPage(1);
      setAmount(""); setReceipt(""); setGiftId(""); setQuantity(1); setResult(null); setRecordDialog(null); setNotice(null); setLocalError(null); setCatalogError(null);
    }
    if (identity) sessionIdentity.current = identity;
    else if (!data && !loading && error) sessionIdentity.current = null;
  }, [data, loading, error]);
  useEffect(() => {
    if (!data || busy) return;
    const selectable = data.stores.filter((item) => !item.deleted && data.session.storeIds.includes(item.id) && (view === "records" || view === "handover" || item.status === "active"));
    if (selectable.some((item) => item.id === storeId)) return;
    const replacement = selectable.find((item) => item.status === "active") ?? selectable[0];
    if (storeId && view === "transaction" && step !== 4) {
      setView("home"); setStep(1); setMemberId(""); setAmount(""); setReceipt(""); setGiftId(""); setQuantity(1); setResult(null); setSearch(""); setSearchQuery(""); setNotice(null); setLocalError(null);
      setCatalogError(data.session.storeIds.includes(storeId) ? "STORE_INACTIVE" : "FORBIDDEN");
    }
    setStoreId(replacement?.id ?? ""); setPage(1); setRecordDialog(null);
  }, [data, storeId, view, step, busy]);
  useEffect(() => {
    if (!data || busy || view !== "transaction" || task !== "redeem" || step === 4 || !giftId) return;
    if (!data.stores.some((item) => item.id === storeId && item.status === "active" && !item.deleted && data.session.storeIds.includes(item.id))) return;
    if (data.gifts.some((item) => item.id === giftId && item.active && !item.deleted)) return;
    setGiftId(""); setQuantity(1); setLocalError(null); setCatalogError("GIFT_UNAVAILABLE");
    if (step > 2) setStep(2);
  }, [data, busy, view, task, step, giftId, storeId]);
  useEffect(() => {
    if (!data) return;
    setRecordDialog((current) => {
      if (!current) return current;
      if (current.kind === "purchase") {
        const record = data.purchases.find((item) => item.id === current.record.id);
        if (!record || (record.refundedCents === current.record.refundedCents && record.points === current.record.points)) return current;
        return { ...current, record, mode: record.refundedCents >= record.amountCents ? "details" : current.mode };
      }
      const record = data.redemptions.find((item) => item.id === current.record.id);
      if (!record || record.updatedAt === current.record.updatedAt) return current;
      return { ...current, record, mode: record.status === "confirmed" ? current.mode : "details" };
    });
  }, [data]);

  const clearSearch = () => { setSearch(""); setSearchQuery(""); setPage(1); };
  const resetDraft = () => { setMemberId(""); setAmount(""); setReceipt(receiptNumber()); setGiftId(""); setQuantity(1); setResult(null); setLocalError(null); setCatalogError(null); setNotice(null); clearSearch(); };
  const navigate = (next: View) => { if (busy) return; setView(next); setRecordDialog(null); setNotice(null); setLocalError(null); setCatalogError(null); clearSearch(); };
  const start = (next: Task) => {
    if (busy || loading || !data?.stores.some((item) => item.id === storeId && item.status === "active" && !item.deleted && data.session.storeIds.includes(item.id))) return;
    resetDraft(); setTask(next); setStep(1); setView("transaction");
  };
  const chooseMember = (id: string) => {
    if (id !== memberId) { setAmount(""); setReceipt(receiptNumber()); setGiftId(""); setQuantity(1); setResult(null); }
    setMemberId(id); setLocalError(null); clearSearch();
  };
  const changeMember = () => { setMemberId(""); setAmount(""); setReceipt(receiptNumber()); setGiftId(""); setQuantity(1); setResult(null); setStep(1); clearSearch(); };
  const back = () => { if (busy || step === 4) return; setLocalError(null); if (step === 1) navigate("home"); else setStep((step - 1) as Step); };

  if (!data) return <div className="min-h-screen bg-[#f8f6f6]"><Topbar role="staff" /><main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center gap-5 px-6 text-center"><ScanLine className="size-10 text-[#bd202b]" /><p className="text-sm text-muted-foreground">{loading ? t("loading") : error}</p>{!loading && <Button variant="outline" onClick={() => void refresh()}>{t("retry")}</Button>}</main></div>;

  const stores = data.stores.filter((item) => !item.deleted && data.session.storeIds.includes(item.id) && (view === "records" || view === "handover" || item.status === "active"));
  const store = stores.find((item) => item.id === storeId);
  const availableGifts = data.gifts.filter((item) => item.active && !item.deleted);
  const gift = availableGifts.find((item) => item.id === giftId);
  const amountCents = parseCents(amount);
  const expectedPoints = amountCents >= data.rules.thresholdCents ? 1 : 0;
  const quotaRemaining = member ? Math.max(0, data.rules.monthlyLimit - member.monthlyRedeemed) : 0;
  const canTransact = member?.status === "active" && store?.status === "active" && !store.deleted && data.session.storeIds.includes(store.id) && !loading && !busy;
  const searching = search.trim() !== searchQuery || loading;
  const storeName = (id: string) => { const match = data.stores.find((item) => item.id === id); return match ? localText(match.name, locale) : id; };
  const giftUnavailable = (item: Gift, count = 1) => {
    if (!item.active || item.deleted || !store || store.status !== "active") return "inactive";
    if ((item.stock[storeId] ?? 0) < count) return "outOfStock";
    if (quotaRemaining < count) return "quotaReached";
    if (!member || member.points < item.points * count) return "insufficient";
    return null;
  };
  const maximumQuantity = gift && member ? Math.max(0, Math.min(100, quotaRemaining, gift.stock[storeId] ?? 0, Math.floor(member.points / gift.points))) : 0;
  const confirmEntry = () => {
    if (!canTransact) return;
    setLocalError(null);
    if (task === "purchase" && !amountCents) { setLocalError("validAmount"); return; }
    if (task === "purchase" && !receipt.trim()) { setLocalError("receiptRequired"); return; }
    if (task === "redeem" && (!gift || giftUnavailable(gift, quantity))) return;
    setStep(3);
  };
  const commit = async () => {
    if (!canTransact || !member) return;
    const response = task === "purchase"
      ? await submit({ action: "purchase", memberId: member.id, storeId, amountCents, receipt: receipt.trim() })
      : gift && !giftUnavailable(gift, quantity) ? await submit({ action: "redeem", memberId: member.id, storeId, giftId: gift.id, quantity }) : null;
    if (response) { setResult(response); setStep(4); setLocalError(null); }
  };
  const openPurchase = (record: Purchase) => { setRecordDialog({ kind: "purchase", record, mode: "details" }); setNotice(null); setLocalError(null); };
  const openRedemption = (record: Redemption, mode: "details" | "fulfill" = "details") => { setRecordDialog({ kind: "redemption", record, mode }); setNotice(null); setLocalError(null); };
  const submitRecordAction = async () => {
    if (!recordDialog || busy) return;
    const dialog = recordDialog;
    if ((dialog.mode === "refund" || dialog.mode === "cancel") && !data.session.canManage) { setLocalError("managerRequired"); return; }
    if (!data.session.storeIds.includes(dialog.record.storeId)) { setLocalError("notAuthorized"); return; }
    if (dialog.kind === "purchase" && dialog.mode === "refund") {
      const cents = parseCents(refundAmount);
      if (!cents || cents > dialog.record.amountCents - dialog.record.refundedCents) { setLocalError("refundLimit"); return; }
      const response = await submit({ action: "refund", purchaseId: dialog.record.id, amountCents: cents });
      if (response?.purchase) { setRecordDialog({ kind: "purchase", record: response.purchase, mode: "details" }); setNotice("refundSuccess"); setLocalError(null); }
    }
    if (dialog.kind === "redemption" && dialog.mode !== "details") {
      const response = await submit({ action: dialog.mode, redemptionId: dialog.record.id });
      if (response?.redemption) { setRecordDialog({ kind: "redemption", record: response.redemption, mode: "details" }); setNotice(dialog.mode === "fulfill" ? "fulfillSuccess" : "cancelSuccess"); setLocalError(null); }
    }
  };

  const pagination = data.pagination.total > data.pagination.pageSize && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stone-100 px-5 py-4"><span className="text-xs text-stone-500">{t("recordCount", { count: data.pagination.total })}</span><div className="flex items-center gap-3"><Button variant="outline" size="icon" disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)} aria-label={t("previous")}><ChevronLeft className="size-4" /></Button><span className="text-xs tabular-nums text-stone-500">{t("page", { page })}</span><Button variant="outline" size="icon" disabled={page * data.pagination.pageSize >= data.pagination.total || loading} onClick={() => setPage((value) => value + 1)} aria-label={t("next")}><ChevronRight className="size-4" /></Button></div></div>;
  const memberSummary = (selected: Member, editable = false) => <div className="flex flex-wrap items-center gap-3 rounded-xl border border-stone-200 bg-[#fcf9f9] p-4"><span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[#fce9eb] text-sm font-semibold text-[#8f1825]">{initials(selected.name)}</span><div className="min-w-0 flex-1"><p className="font-medium">{selected.name}</p><p className="mt-1 text-xs text-stone-500">{selected.number}</p></div><Badge variant="outline" className={cn(selected.tier === "gold" ? "border-[#e7d9b4] bg-[#fbf6e6] text-[#8a6c27]" : selected.tier === "silver" ? "border-slate-200 bg-slate-50 text-slate-600" : "border-[#ead7c4] bg-[#faf2e9] text-[#8d664b]")}>{t(selected.tier)}</Badge>{editable && <button className="min-h-10 text-xs font-medium text-[#8f1825]" onClick={changeMember} disabled={busy}>{t("changeMember")}</button>}</div>;
  const purchaseRows = (record: Purchase): [string, string][] => [[t("member"), record.memberName], [t("receipt"), record.receipt], [t("store"), storeName(record.storeId)], [t("recordedAt"), dateTime(record.createdAt, locale)], [t("netPointsEarned"), String(record.points)], [t("refundedAmount"), money(record.refundedCents, locale)]];
  const redemptionRows = (record: Redemption): [string, string][] => [[t("member"), record.memberName], [t("reference"), record.id], [t("reward"), localText(record.giftName, locale)], [t("quantity"), String(record.quantity)], [t("deducted"), String(record.points)], [t("store"), storeName(record.storeId)], [t("recordedAt"), dateTime(record.createdAt, locale)], [t("status"), t(record.status)]];
  const title = view === "home" ? "chooseTask" : view === "handover" ? "pendingHandover" : view === "records" ? "records" : step === 1 ? "identifyMember" : step === 2 ? task === "purchase" ? "enterPurchase" : "chooseReward" : step === 3 ? task === "purchase" ? "reviewPurchase" : "redeemTitle" : task === "purchase" ? "success" : "redeemSuccess";

  return <div className="min-h-screen bg-[#f8f6f6] text-[#242126]">
    <Topbar role="staff" />
    <div className="border-b border-stone-200/80 bg-white"><nav className="mx-auto flex max-w-[1180px] gap-2 px-4 sm:px-7 lg:px-10" aria-label={t("serviceDesk")}>{([{ id: "home", label: "workbench", icon: LayoutGrid }, { id: "handover", label: "pendingHandover", icon: PackageCheck }, { id: "records", label: "records", icon: ClipboardList }] as const).map(({ id, label, icon: Icon }) => <button key={id} disabled={busy} onClick={() => navigate(id)} aria-current={view === id || (id === "home" && view === "transaction") ? "page" : undefined} className={cn("flex min-h-14 items-center gap-2 border-b-2 px-3 text-xs font-medium sm:px-5 sm:text-sm", view === id || (id === "home" && view === "transaction") ? "border-[#bd202b] bg-[#fce9eb]/60 text-[#8f1825]" : "border-transparent text-stone-500 hover:text-stone-800")}><Icon className="size-4" />{t(label)}</button>)}</nav></div>
    <main className="mx-auto max-w-[1180px] px-4 py-7 sm:px-7 lg:px-10">
      <header className="mb-7 flex flex-wrap items-center justify-between gap-5"><div><p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-500">{view === "transaction" ? t(task === "purchase" ? "newPurchase" : "newRedemption") : t("subtitle")}</p><h1 ref={heading} tabIndex={-1} className="text-[26px] font-semibold tracking-[-0.035em] outline-none sm:text-[30px]">{t(title)}</h1></div><div className="flex items-center gap-2"><div className="relative"><StoreIcon className="pointer-events-none absolute left-3 top-3.5 size-4 text-stone-500" /><label htmlFor="staff-store" className="sr-only">{t("selectStore")}</label><select id="staff-store" value={storeId} disabled={busy || view === "transaction"} onChange={(event) => { setStoreId(event.target.value); setPage(1); setRecordDialog(null); }} className="h-11 min-w-[185px] appearance-none rounded-xl border border-stone-200 bg-white pl-10 pr-9 text-sm font-medium focus:outline-2 focus:outline-[#bd202b] disabled:opacity-70">{stores.length ? stores.map((item) => <option key={item.id} value={item.id}>{localText(item.name, locale)}</option>) : <option value="">{t("notAuthorized")}</option>}</select><ChevronDown className="pointer-events-none absolute right-3 top-4 size-3.5 text-stone-400" /></div><Button variant="outline" size="icon" className="size-11 rounded-xl bg-white" disabled={busy || loading} onClick={() => void refresh()} aria-label={t("refresh")}><RefreshCw className={cn("size-4", loading && "animate-spin")} /></Button></div></header>
      {(error || localError || catalogError) && !recordDialog && <div role="alert" className="mb-5 flex items-center justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"><span>{localError ? t(localError) : catalogError ? common(`errors.${catalogError}`) : error}</span><Button variant="ghost" size="sm" onClick={() => { setLocalError(null); setCatalogError(null); void refresh(); }}>{t("retry")}</Button></div>}

      {view === "home" && <div className="grid gap-4 pt-2 md:grid-cols-3">{([{ id: "purchase", label: "newPurchase", icon: ReceiptText, color: "bg-[#fce9eb] text-[#bd202b]" }, { id: "redeem", label: "newRedemption", icon: GiftIcon, color: "bg-[#f2edef] text-[#66555c]" }, { id: "handover", label: "handoverTask", icon: PackageCheck, color: "bg-[#eeecee] text-[#4c4349]" }] as const).map(({ id, label, icon: Icon, color }) => <button key={id} disabled={busy || loading || !storeId || !store || store.status !== "active" || !!store.deleted} onClick={() => id === "handover" ? navigate("handover") : start(id)} className="group flex min-h-[108px] flex-row items-center gap-4 rounded-[20px] border border-stone-200/80 bg-white p-5 text-left md:min-h-[195px] md:flex-col md:items-start md:p-7 transition-[border-color,box-shadow] duration-150 hover:border-[#bd202b]/35 hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#bd202b] disabled:opacity-50"><span className={cn("flex size-12 shrink-0 items-center justify-center rounded-2xl md:size-14", color)}><Icon className="size-6 stroke-[1.7]" /></span><span className="flex w-full items-center justify-between gap-4 text-base font-semibold tracking-tight md:mt-4 md:text-lg">{t(label)}<ArrowRight className="size-5 text-stone-400 transition-transform group-hover:translate-x-1" /></span></button>)}</div>}

      {view === "transaction" && <div className="mx-auto max-w-[760px]">
        <ol aria-label={t("stepLabel", { current: step, total: 4 })} className="mb-7 grid grid-cols-4 gap-2">{["identifyMember", task === "purchase" ? "enterPurchase" : "chooseReward", "confirmDetails", "result"].map((label, index) => <li key={label} aria-current={step === index + 1 ? "step" : undefined} className="flex flex-col gap-2"><div className={cn("flex size-8 items-center justify-center rounded-full text-xs font-semibold", step > index + 1 ? "bg-[#bd202b] text-white" : step === index + 1 ? "border border-[#bd202b] bg-[#fce9eb] text-[#bd202b]" : "border border-stone-200 bg-white text-stone-400")}>{step > index + 1 ? <Check className="size-3.5" /> : index + 1}</div><span className={cn("text-[11px] sm:text-xs", step === index + 1 ? "font-semibold text-[#bd202b]" : "text-stone-500")}>{t(label)}</span></li>)}</ol>
        <section className="overflow-hidden rounded-[20px] border border-stone-200/80 bg-white">
          {step === 1 && <><div className="p-5 sm:p-7"><Button className="mb-5 h-12 w-full rounded-xl bg-[#bd202b] hover:bg-[#a71925]" onClick={() => chooseMember("m001")}><ScanLine className="size-4" />{t("readCode")}</Button>
            {member ? <><div className="mb-5">{memberSummary(member, true)}</div><DetailRows rows={[[t("phone"), member.phone], [t("points"), String(member.points)], [t("visits"), String(member.visits)], [t("monthlyAllowance"), t("availableQuota", { count: quotaRemaining })]]} />{member.status === "suspended" && <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{t("memberSuspended")}</p>}</> : <><div className="relative"><Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-stone-400" /><label htmlFor="staff-member-search" className="sr-only">{t("findMember")}</label><Input id="staff-member-search" maxLength={100} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("searchPlaceholder")} aria-busy={searching} className="h-11 rounded-xl pl-10" /></div><div className="mt-4 divide-y divide-stone-100" aria-live="polite">{searching ? <p className="py-10 text-center text-sm text-stone-500">{t("searching")}</p> : data.members.length ? data.members.map((item) => <button key={item.id} onClick={() => chooseMember(item.id)} className="group flex min-h-[76px] w-full items-center gap-3 py-3 text-left"><span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#f7eff0] text-sm font-medium text-[#8f1825]">{initials(item.name)}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{item.name}</span><span className="mt-1 block text-xs text-stone-500">{item.phone} <span className="mx-1 text-stone-300">·</span> {item.number}</span></span><ChevronRight className="size-4 text-stone-300 group-hover:text-[#bd202b]" /></button>) : <p className="py-10 text-center text-sm text-stone-500">{t("noResults")}</p>}</div></>}
          </div>{!member && pagination}<div className="flex items-center justify-between gap-3 border-t border-stone-100 p-5 sm:px-7"><Button variant="ghost" onClick={back}><ArrowLeft className="size-4" />{t("back")}</Button><Button className="h-11 bg-[#bd202b] hover:bg-[#a71925]" disabled={!canTransact} onClick={() => { setStep(2); clearSearch(); }}>{t("confirmIdentity")}<ArrowRight className="size-4" /></Button></div></>}

          {step === 2 && <><div className="p-5 sm:p-7">{member && <div className="mb-7">{memberSummary(member, true)}</div>}
            {task === "purchase" ? <><label htmlFor="purchase-amount" className="text-sm font-medium text-stone-600">{t("amount")}</label><div className="mt-3 flex items-baseline gap-3 rounded-xl border border-stone-200 px-4 py-5 focus-within:border-[#bd202b]"><span className="text-xl font-medium text-stone-400">S$</span><input id="purchase-amount" inputMode="decimal" autoComplete="off" maxLength={10} value={amount} placeholder="0.00" onChange={(event) => { setAmount(event.target.value); setLocalError(null); }} className="min-w-0 flex-1 bg-transparent text-[44px] font-medium leading-none tracking-[-0.04em] tabular-nums outline-none placeholder:text-stone-200 sm:text-[52px]" /></div><div className="mt-3 grid grid-cols-4 gap-2">{["29.99", "30.00", "60.00", "186.40"].map((value) => <button key={value} onClick={() => { setAmount(value); setLocalError(null); }} aria-pressed={amount === value} aria-label={t("amountPreset", { amount: money(parseCents(value), locale) })} className={cn("min-h-11 rounded-lg border px-1 text-xs font-medium tabular-nums", amount === value ? "border-[#bd202b]/40 bg-[#fce9eb] text-[#8f1825]" : "border-stone-200 text-stone-500 hover:bg-stone-50")}>{money(parseCents(value), locale)}</button>)}</div><label htmlFor="purchase-receipt" className="mb-2 mt-6 block text-sm font-medium text-stone-600">{t("receipt")}</label><Input id="purchase-receipt" maxLength={80} value={receipt} onChange={(event) => setReceipt(event.target.value)} placeholder={t("receiptPlaceholder")} className="h-11 rounded-lg font-mono text-sm" /><div className="mt-6 flex items-center justify-between border-t border-stone-100 pt-5 text-sm"><span className="text-stone-500">{t("pointsEarned")}</span><span className="font-semibold text-emerald-800">{t("pointValue", { count: expectedPoints })}</span></div></> : <><div className="grid gap-3 sm:grid-cols-2">{availableGifts.map((item) => <button key={item.id} disabled={!!giftUnavailable(item)} aria-pressed={giftId === item.id} onClick={() => { setGiftId(item.id); setQuantity(1); setCatalogError(null); }} className={cn("flex items-center gap-3 rounded-xl border p-3 text-left transition-colors disabled:opacity-50", giftId === item.id ? "border-[#bd202b] bg-[#fce9eb] ring-1 ring-[#bd202b]" : "border-stone-200 hover:border-[#bd202b]/40")}><div className="relative size-[76px] shrink-0 overflow-hidden rounded-lg bg-stone-100"><Image src={item.image} alt={localText(item.name, locale)} fill sizes="76px" className="object-cover" /></div><div className="min-w-0"><h2 className="text-sm font-medium leading-snug">{localText(item.name, locale)}</h2><p className="mt-2 text-xs font-semibold text-[#8f1825]">{t("cost", { points: item.points })}</p><p className="mt-1 text-[11px] text-stone-500">{giftUnavailable(item) ? t(giftUnavailable(item)!) : t("stock", { count: item.stock[storeId] ?? 0 })}</p></div></button>)}</div>{!availableGifts.length && <p className="py-10 text-center text-sm text-stone-500">{t("noRewards")}</p>}{gift && <div className="mt-6 rounded-xl bg-[#f8f5f5] p-5"><div className="flex items-center justify-between gap-3"><span className="text-sm font-medium">{t("quantity")}</span><div className="flex items-center gap-4"><Button variant="outline" size="icon" aria-label={t("quantity") + " −"} disabled={quantity <= 1} onClick={() => setQuantity((value) => value - 1)}><Minus className="size-4" /></Button><span className="w-5 text-center font-semibold tabular-nums">{quantity}</span><Button variant="outline" size="icon" aria-label={t("quantity") + " +"} disabled={quantity >= maximumQuantity} onClick={() => setQuantity((value) => value + 1)}><Plus className="size-4" /></Button></div></div><div className="mt-5 flex justify-between border-t border-stone-200 pt-4 text-sm"><span className="text-stone-500">{t("pointsRequired")}</span><strong className="text-[#242126]">{gift.points * quantity}</strong></div>{giftUnavailable(gift, quantity) && <p className="mt-3 text-xs text-amber-800">{t(giftUnavailable(gift, quantity)!)}</p>}</div>}</>}
          </div><div className="flex items-center justify-between gap-3 border-t border-stone-100 p-5 sm:px-7"><Button variant="ghost" onClick={back}><ArrowLeft className="size-4" />{t("back")}</Button><Button className="h-11 bg-[#bd202b] hover:bg-[#a71925]" disabled={!canTransact || (task === "purchase" ? !amountCents || !receipt.trim() : !gift || !!giftUnavailable(gift, quantity))} onClick={confirmEntry}>{t("continue")}<ArrowRight className="size-4" /></Button></div></>}

          {step === 3 && <><div className="p-5 sm:p-7">{member && <div className="mb-6">{memberSummary(member)}</div>}{task === "purchase" ? <><div className="mb-5 rounded-xl bg-[#fce9eb] p-6 text-center"><p className="text-xs text-stone-500">{t("amount")}</p><p className="mt-2 text-4xl font-semibold tracking-tight tabular-nums text-[#242126]">{money(amountCents, locale)}</p></div><DetailRows rows={[[t("store"), storeName(storeId)], [t("receipt"), receipt], [t("pointsEarned"), t("pointValue", { count: expectedPoints })]]} /></> : gift && <><div className="mb-5 flex items-center gap-4 rounded-xl bg-[#f8f5f5] p-4"><div className="relative size-20 shrink-0 overflow-hidden rounded-lg"><Image src={gift.image} alt={localText(gift.name, locale)} fill sizes="80px" className="object-cover" /></div><p className="font-medium">{localText(gift.name, locale)}</p></div><DetailRows rows={[[t("store"), storeName(storeId)], [t("quantity"), String(quantity)], [t("pointsRequired"), String(gift.points * quantity)], [t("remainingBalance"), String((member?.points ?? 0) - gift.points * quantity)]]} />{giftUnavailable(gift, quantity) && <p className="mt-4 text-sm text-amber-800">{t(giftUnavailable(gift, quantity)!)}</p>}</>}</div><div className="flex items-center justify-between gap-3 border-t border-stone-100 p-5 sm:px-7"><Button variant="ghost" disabled={busy} onClick={back}><ArrowLeft className="size-4" />{t("back")}</Button><Button className="h-12 bg-[#bd202b] px-6 hover:bg-[#a71925]" disabled={!canTransact || (task === "redeem" && (!gift || !!giftUnavailable(gift, quantity)))} onClick={() => void commit()}>{busy ? t("busy") : t(task === "purchase" ? "submitPurchase" : "redeem")}<Check className="size-4" /></Button></div></>}

          {step === 4 && <div className="p-5 sm:p-7"><div role="status" className="border-b border-dashed border-stone-200 pb-6 text-center"><span className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-[#eaf3e2] text-[#2b603c]"><CheckCircle2 className="size-8 stroke-[1.6]" /></span><h2 className="text-xl font-semibold">{t(task === "purchase" ? "success" : "redeemSuccess")}</h2>{result?.purchase && <p className="mt-4 text-4xl font-semibold tracking-tight tabular-nums text-[#242126]">{money(result.purchase.amountCents, locale)}</p>}</div>{result?.purchase ? <DetailRows rows={[...purchaseRows(result.purchase), ...(result.member ? [[t("pointsBalance"), String(result.member.points)] as [string, string]] : [])]} /> : result?.redemption ? <DetailRows rows={[...redemptionRows(result.redemption), ...(result.member ? [[t("pointsBalance"), String(result.member.points)] as [string, string]] : [])]} /> : <p className="py-6 text-center text-sm text-stone-500">{t("receiptLoading")}</p>}<div className="mt-6 grid gap-3 sm:grid-cols-2"><Button variant="outline" className="h-12" onClick={() => navigate(task === "redeem" ? "handover" : "home")}>{t(task === "redeem" ? "viewPending" : "returnHome")}</Button><Button className="h-12 bg-[#bd202b] hover:bg-[#a71925]" disabled={busy || loading || !store || store.status !== "active" || !!store.deleted} onClick={() => start(task)}>{t(task === "purchase" ? "nextPurchase" : "nextRedemption")}<ArrowRight className="size-4" /></Button></div></div>}
        </section>
      </div>}

      {(view === "handover" || view === "records") && <section className="overflow-hidden rounded-[20px] border border-stone-200/80 bg-white">
        {view === "records" && <div className="flex border-b border-stone-100">{(["purchases", "redemptions"] as const).map((value) => <button key={value} onClick={() => { setRecordTab(value); clearSearch(); }} aria-pressed={recordTab === value} className={cn("flex min-h-14 flex-1 items-center justify-center gap-2 border-b-2 px-4 text-sm font-medium", recordTab === value ? "border-[#bd202b] bg-[#fce9eb]/50 text-[#8f1825]" : "border-transparent text-stone-500")}>{value === "purchases" ? <ReceiptText className="size-4" /> : <GiftIcon className="size-4" />}{t(value === "purchases" ? "recordsPurchases" : "recordsRedemptions")}</button>)}</div>}
        <div className="border-b border-stone-100 p-5"><div className="relative max-w-md"><Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-stone-400" /><label htmlFor="staff-record-search" className="sr-only">{t("searchRecords")}</label><Input id="staff-record-search" maxLength={100} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("searchRecords")} className="h-11 rounded-xl pl-10" aria-busy={searching} /></div></div>
        {searching ? <p className="py-12 text-center text-sm text-stone-500">{t("loading")}</p> : view === "records" && recordTab === "purchases" ? <div className="divide-y divide-stone-100">{data.purchases.length ? data.purchases.map((item) => <button key={item.id} onClick={() => openPurchase(item)} className="flex w-full flex-wrap items-center gap-4 px-5 py-5 text-left transition-colors hover:bg-stone-50 sm:px-6"><span className="hidden size-11 shrink-0 items-center justify-center rounded-xl bg-[#f7eff0] text-stone-500 sm:flex"><ReceiptText className="size-5" /></span><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{item.memberName}</span><span className="mt-1 block font-mono text-[11px] text-stone-400">{item.receipt}</span><span className="mt-1 block text-[11px] text-stone-500 sm:hidden">{dateTime(item.createdAt, locale)}</span></span><span className="hidden text-xs text-stone-500 sm:block">{dateTime(item.createdAt, locale)}</span><span className="text-right"><span className="block text-sm font-semibold tabular-nums">{money(item.amountCents, locale)}</span><span className="mt-1 block text-[11px] text-stone-500">{t(item.refundedCents === 0 ? "recorded" : item.refundedCents === item.amountCents ? "refunded" : "partiallyRefunded")}</span></span><ChevronRight className="size-4 text-stone-300" /></button>) : <p className="py-12 text-center text-sm text-stone-500">{t("noPurchases")}</p>}</div> : <div className="divide-y divide-stone-100">{data.redemptions.length ? data.redemptions.map((item) => <div key={item.id} className="flex flex-wrap items-center gap-4 px-5 py-5 sm:px-6"><span className="hidden size-11 shrink-0 items-center justify-center rounded-xl bg-[#f7eff0] text-[#8f1825] sm:flex"><GiftIcon className="size-5" /></span><button onClick={() => openRedemption(item)} className="min-w-[150px] flex-1 text-left"><span className="block text-sm font-medium">{localText(item.giftName, locale)} <span className="text-stone-400">×{item.quantity}</span></span><span className="mt-1 block text-xs text-stone-500">{item.memberName}</span><span className="mt-1 block text-[11px] text-stone-400">{dateTime(item.createdAt, locale)}</span></button><Badge variant="outline" className={cn("text-[11px]", item.status === "confirmed" ? "border-amber-200 bg-amber-50 text-amber-800" : item.status === "fulfilled" ? "border-emerald-100 bg-emerald-50 text-emerald-700" : "text-stone-500")}>{t(item.status)}</Badge>{view === "handover" ? <Button className="h-11 bg-[#bd202b] hover:bg-[#a71925] max-sm:w-full" disabled={busy || item.status !== "confirmed"} onClick={() => openRedemption(item, "fulfill")}><Check className="size-4" />{t("fulfill")}</Button> : <Button variant="ghost" size="icon" aria-label={t("details")} onClick={() => openRedemption(item)}><ChevronRight className="size-4" /></Button>}</div>) : <div className="flex flex-col items-center gap-3 py-14 text-stone-400"><PackageCheck className="size-9 stroke-[1.3]" /><p className="text-sm">{t(view === "handover" ? "noPending" : "noRedemptions")}</p></div>}</div>}
        {pagination}
      </section>}
    </main>

    <Dialog open={recordDialog !== null} onOpenChange={(open) => { if (!open && !busy) { setRecordDialog(null); setNotice(null); setLocalError(null); } }}><DialogContent className="max-h-[90dvh] max-w-[460px] overflow-y-auto rounded-2xl p-6">{recordDialog && <>
      <DialogHeader><DialogTitle>{t(recordDialog.kind === "purchase" ? recordDialog.mode === "refund" ? "refundTitle" : "purchaseDetails" : recordDialog.mode === "fulfill" ? "fulfillTitle" : recordDialog.mode === "cancel" ? "cancelTitle" : "rewardDetails")}</DialogTitle><DialogDescription>{recordDialog.record.memberName}</DialogDescription></DialogHeader>
      {notice && <div role="status" className="flex items-center gap-2 rounded-xl bg-emerald-50 p-3 text-sm font-medium text-emerald-800"><CheckCircle2 className="size-4" />{t(notice)}</div>}
      {recordDialog.kind === "purchase" ? <><div className="rounded-xl bg-[#f8f5f5] py-5 text-center text-3xl font-semibold tabular-nums text-[#242126]">{money(recordDialog.record.amountCents, locale)}</div><DetailRows rows={purchaseRows(recordDialog.record)} />{recordDialog.mode === "refund" && <><div className="flex justify-between text-sm"><span className="text-stone-500">{t("remainingAmount")}</span><strong>{money(recordDialog.record.amountCents - recordDialog.record.refundedCents, locale)}</strong></div><label htmlFor="refund-amount" className="block text-sm font-medium">{t("refundAmount")}<div className="relative mt-2"><span className="absolute left-3 top-3 text-sm text-stone-400">S$</span><Input id="refund-amount" inputMode="decimal" maxLength={10} value={refundAmount} onChange={(event) => { setRefundAmount(event.target.value); setLocalError(null); }} className="h-11 pl-10 tabular-nums" /></div></label></>}</> : <DetailRows rows={redemptionRows(recordDialog.record)} />}
      {(error || localError) && <p role="alert" className="text-sm text-red-700">{localError ? t(localError) : error}</p>}
      <DialogFooter className="mt-2 gap-2"><Button variant="outline" disabled={busy} onClick={() => { setRecordDialog(null); setNotice(null); setLocalError(null); }}>{t(recordDialog.mode === "details" ? "close" : "cancel")}</Button>{recordDialog.kind === "purchase" && recordDialog.mode === "details" && data.session.canManage && recordDialog.record.refundedCents < recordDialog.record.amountCents && <Button variant="outline" onClick={() => { setRefundAmount(((recordDialog.record.amountCents - recordDialog.record.refundedCents) / 100).toFixed(2)); setRecordDialog({ ...recordDialog, mode: "refund" }); setNotice(null); }}><RotateCcw className="size-4" />{t("refund")}</Button>}{recordDialog.kind === "redemption" && recordDialog.mode === "details" && recordDialog.record.status === "confirmed" && (view === "handover" ? <Button className="bg-[#bd202b] hover:bg-[#a71925]" onClick={() => setRecordDialog({ ...recordDialog, mode: "fulfill" })}>{t("fulfill")}</Button> : data.session.canManage && <Button variant="outline" onClick={() => setRecordDialog({ ...recordDialog, mode: "cancel" })}>{t("cancelRedemption")}</Button>)}{recordDialog.mode !== "details" && <Button variant={recordDialog.mode === "cancel" ? "destructive" : "default"} className={recordDialog.mode !== "cancel" ? "bg-[#bd202b] hover:bg-[#a71925]" : ""} disabled={busy || ((recordDialog.mode === "refund" || recordDialog.mode === "cancel") && !data.session.canManage) || (recordDialog.kind === "purchase" && (!parseCents(refundAmount) || parseCents(refundAmount) > recordDialog.record.amountCents - recordDialog.record.refundedCents))} onClick={() => void submitRecordAction()}>{busy ? t("busy") : t(recordDialog.mode === "refund" ? "submitRefund" : recordDialog.mode === "fulfill" ? "fulfill" : "cancelRedemption")}</Button>}</DialogFooter>
    </>}</DialogContent></Dialog>
  </div>;
}
