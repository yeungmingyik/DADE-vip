"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CheckCircle2, Gift as GiftIcon, Plus, Store as StoreIcon, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { localText } from "@/lib/format";
import type { ActionPayload, AppData, Gift, LocalizedText, Store } from "@/lib/types";

type GiftDraft = { kind: "gift"; id?: string; name: LocalizedText; category: Gift["category"]; image: string; points: string; active: boolean; stock: Record<string, string> };
type StoreDraft = { kind: "store"; id?: string; name: LocalizedText; address: string; status: Store["status"] };
type DeleteTarget = { kind: "gift" | "store"; id: string; name: LocalizedText };
type Notice = { key: "giftSaved" | "storeSaved" | "giftDeleted" | "storeDeleted"; name: LocalizedText };
type CatalogProps = { kind: "gifts" | "stores"; data: AppData; busy: boolean; error: string | null; mutate: (payload: ActionPayload) => Promise<boolean> };

const images = [
  { path: "/gifts/toolkit.webp", label: "imageToolkit" },
  { path: "/gifts/bottle.webp", label: "imageBottle" },
  { path: "/gifts/care.webp", label: "imageCare" },
] as const;

function integerValue(raw: string, minimum: number, maximum: number) {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}

export function Catalog({ kind, data, busy, error, mutate }: CatalogProps) {
  const t = useTranslations("admin");
  const locale = useLocale();
  const [editor, setEditor] = useState<GiftDraft | StoreDraft | null>(null);
  const [deletion, setDeletion] = useState<DeleteTarget | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const [requestFailed, setRequestFailed] = useState(false);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const submitting = useRef(false);
  const gifts = data.gifts.filter((gift) => !gift.deleted);
  const stores = data.stores.filter((store) => !store.deleted);
  const recordDeleted = !!editor?.id && !(editor.kind === "gift" ? gifts : stores).some((item) => item.id === editor.id);
  const deletionGone = !!deletion && !(deletion.kind === "gift" ? gifts : stores).some((item) => item.id === deletion.id);
  const activeError = validation ? t(validation) : requestFailed ? failureMessage || error || t("catalogRequestFailed") : null;

  useEffect(() => {
    if (requestFailed && error) setFailureMessage(error);
  }, [requestFailed, error]);

  const prepare = () => { setValidation(null); setRequestFailed(false); setFailureMessage(null); setNotice(null); };
  const add = () => {
    prepare();
    setEditor(kind === "gifts"
      ? { kind: "gift", name: { en: "", "zh-CN": "" }, category: "tools", image: images[0].path, points: "10", active: true, stock: Object.fromEntries(stores.map((store) => [store.id, "0"])) }
      : { kind: "store", name: { en: "", "zh-CN": "" }, address: "", status: "active" });
  };
  const editGift = (gift: Gift) => {
    prepare();
    setEditor({ kind: "gift", id: gift.id, name: { ...gift.name }, category: gift.category, image: gift.image, points: String(gift.points), active: gift.active, stock: Object.fromEntries(stores.map((store) => [store.id, String(gift.stock[store.id] ?? 0)])) });
  };
  const editStore = (store: Store) => { prepare(); setEditor({ kind: "store", id: store.id, name: { ...store.name }, address: store.address, status: store.status }); };
  const requestDeletion = (target: DeleteTarget) => { prepare(); setDeletion(target); };
  const closeEditor = () => { if (busy || submitting.current) return; setEditor(null); setValidation(null); setRequestFailed(false); };
  const closeDeletion = () => { if (busy || submitting.current) return; setDeletion(null); setValidation(null); setRequestFailed(false); };

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || busy || submitting.current || recordDeleted) return;
    setValidation(null); setRequestFailed(false); setFailureMessage(null);
    const name = { en: editor.name.en.trim(), "zh-CN": editor.name["zh-CN"].trim() };
    if (!name.en || !name["zh-CN"]) { setValidation("namesRequired"); return; }
    let payload: ActionPayload;
    if (editor.kind === "gift") {
      const points = integerValue(editor.points, 1, 100000000);
      const entries = stores.map((store) => [store.id, integerValue(editor.stock[store.id] ?? "0", 0, 100000)] as const);
      if (points === null || entries.some(([, value]) => value === null)) { setValidation("invalidInventory"); return; }
      const stock = Object.fromEntries(entries) as Record<string, number>;
      const fields = { name, category: editor.category, image: editor.image, points, active: editor.active, stock };
      payload = editor.id ? { action: "updateGift", giftId: editor.id, ...fields } : { action: "createGift", ...fields };
    } else {
      const address = editor.address.trim();
      if (!address) { setValidation("addressRequired"); return; }
      const fields = { name, address, status: editor.status };
      payload = editor.id ? { action: "updateStore", storeId: editor.id, ...fields } : { action: "createStore", ...fields };
    }
    submitting.current = true;
    try {
      if (await mutate(payload)) { setNotice({ key: editor.kind === "gift" ? "giftSaved" : "storeSaved", name }); setEditor(null); }
      else setRequestFailed(true);
    } finally { submitting.current = false; }
  }

  async function remove() {
    if (!deletion || busy || submitting.current || deletionGone) return;
    setValidation(null); setRequestFailed(false); setFailureMessage(null); submitting.current = true;
    try {
      const payload: ActionPayload = deletion.kind === "gift" ? { action: "deleteGift", giftId: deletion.id } : { action: "deleteStore", storeId: deletion.id };
      if (await mutate(payload)) { setNotice({ key: deletion.kind === "gift" ? "giftDeleted" : "storeDeleted", name: deletion.name }); setDeletion(null); }
      else setRequestFailed(true);
    } finally { submitting.current = false; }
  }

  return <div className="space-y-5">
    <div className="flex items-center justify-between gap-3"><p className="text-xs text-muted-foreground">{t("records", { count: kind === "gifts" ? gifts.length : stores.length })}</p><Button disabled={busy} onClick={add} className="h-11 gap-2"><Plus className="size-4" />{t(kind === "gifts" ? "addGift" : "addStore")}</Button></div>
    {notice && <div role="status" className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"><CheckCircle2 className="size-4 shrink-0" /><span className="flex-1">{t(notice.key, { name: localText(notice.name, locale) })}</span><button aria-label={t("close")} onClick={() => setNotice(null)} className="grid size-9 shrink-0 place-items-center rounded-full hover:bg-emerald-100"><X className="size-4" /></button></div>}
    {kind === "gifts" ? gifts.length ? <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">{gifts.map((gift) => <Card key={gift.id} className="gap-0 overflow-hidden pt-0 shadow-none"><div className="relative aspect-[1.5] overflow-hidden bg-[#f2eded]"><Image src={gift.image} alt={localText(gift.name, locale)} fill sizes="(max-width:640px) 90vw, 30vw" className="object-cover" /><Badge variant="outline" className={cn("absolute left-4 top-4 border-0", gift.active ? "bg-emerald-50 text-emerald-800" : "bg-stone-100 text-stone-600")}>{t(gift.active ? "available" : "unavailable")}</Badge></div><CardContent className="pt-5"><div className="flex items-start justify-between gap-3"><h2 className="text-base font-semibold">{localText(gift.name, locale)}</h2><span className="shrink-0 text-sm font-semibold">{gift.points} <span className="text-[10px] font-normal text-muted-foreground">{t("pointUnit", { count: gift.points })}</span></span></div><p className="mt-2 text-xs text-muted-foreground">{t("stockTotal", { count: stores.reduce((sum, store) => sum + (gift.stock[store.id] ?? 0), 0) })}</p><div className="mt-5 flex gap-2"><Button disabled={busy} className="flex-1" variant="outline" onClick={() => editGift(gift)}>{t("editGift")}</Button><Button disabled={busy} variant="outline" size="icon" aria-label={`${t("deleteGift")} ${localText(gift.name, locale)}`} className="text-stone-500 hover:border-red-200 hover:bg-red-50 hover:text-red-700" onClick={() => requestDeletion({ kind: "gift", id: gift.id, name: gift.name })}><Trash2 className="size-4" /></Button></div></CardContent></Card>)}</div> : <div className="grid min-h-60 place-items-center rounded-2xl border bg-white p-8 text-center"><div><GiftIcon className="mx-auto mb-4 size-9 text-stone-300" /><p className="text-sm text-muted-foreground">{t("noGifts")}</p></div></div> : stores.length ? <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">{stores.map((store) => <Card key={store.id} className="flex flex-col shadow-none"><CardHeader><div className="mb-5 flex items-center justify-between"><span className="grid size-12 place-items-center rounded-xl bg-[#fce9eb]"><StoreIcon className="size-6 text-[#bd202b]" /></span><Badge variant="outline" className={cn("border-0", store.status === "active" ? "bg-emerald-50 text-emerald-800" : "bg-stone-100 text-stone-600")}>{t(store.status)}</Badge></div><CardTitle>{localText(store.name, locale)}</CardTitle></CardHeader><CardContent className="flex flex-1 flex-col"><p className="eyebrow mb-2">{t("storeAddress")}</p><p className="text-sm leading-relaxed text-muted-foreground">{store.address}</p><div className="mt-auto flex gap-2 pt-6"><Button disabled={busy} className="flex-1" variant="outline" onClick={() => editStore(store)}>{t("editStore")}</Button><Button disabled={busy} variant="outline" size="icon" aria-label={`${t("deleteStore")} ${localText(store.name, locale)}`} className="text-stone-500 hover:border-red-200 hover:bg-red-50 hover:text-red-700" onClick={() => requestDeletion({ kind: "store", id: store.id, name: store.name })}><Trash2 className="size-4" /></Button></div></CardContent></Card>)}</div> : <div className="grid min-h-60 place-items-center rounded-2xl border bg-white p-8 text-center"><div><StoreIcon className="mx-auto mb-4 size-9 text-stone-300" /><p className="text-sm text-muted-foreground">{t("noStores")}</p></div></div>}

    <Dialog open={editor !== null} onOpenChange={(open) => { if (!open) closeEditor(); }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[560px]">{editor && <><DialogHeader><DialogTitle>{t(editor.kind === "gift" ? editor.id ? "editGift" : "addGift" : editor.id ? "editStore" : "addStore")}</DialogTitle><DialogDescription className="sr-only">{t(editor.kind === "gift" ? "gifts" : "stores")}</DialogDescription></DialogHeader><form onSubmit={save} className="space-y-5"><fieldset disabled={busy || recordDeleted} className="space-y-5 disabled:opacity-60"><div className="grid gap-4 sm:grid-cols-2"><label className="block text-sm font-medium">{t("nameEnglish")}<Input value={editor.name.en} maxLength={100} required className="mt-2" onChange={(event) => setEditor({ ...editor, name: { ...editor.name, en: event.target.value } })} /></label><label className="block text-sm font-medium">{t("nameChinese")}<Input value={editor.name["zh-CN"]} maxLength={100} required className="mt-2" onChange={(event) => setEditor({ ...editor, name: { ...editor.name, "zh-CN": event.target.value } })} /></label></div>
      {editor.kind === "gift" ? <><div className="grid grid-cols-2 gap-4"><label className="block text-sm font-medium">{t("category")}<select value={editor.category} onChange={(event) => setEditor({ ...editor, category: event.target.value as Gift["category"] })} className="field-select mt-2 w-full">{(["tools", "lifestyle", "care"] as const).map((category) => <option key={category} value={category}>{t(category)}</option>)}</select></label><label className="block text-sm font-medium">{t("pointsCost")}<Input value={editor.points} onChange={(event) => setEditor({ ...editor, points: event.target.value })} inputMode="numeric" maxLength={9} required className="mt-2" /></label></div><fieldset><legend className="mb-3 text-sm font-medium">{t("rewardImage")}</legend><div className="grid grid-cols-3 gap-3">{images.map((image) => <label key={image.path} className={cn("relative cursor-pointer overflow-hidden rounded-xl border-2", editor.image === image.path ? "border-[#bd202b] ring-1 ring-[#bd202b]" : "border-stone-200")}><input type="radio" name="gift-image" value={image.path} checked={editor.image === image.path} onChange={() => setEditor({ ...editor, image: image.path })} className="absolute left-2 top-2 z-10 size-4 accent-[#bd202b]" /><span className="relative block aspect-[4/3]"><Image src={image.path} alt={t(image.label)} fill sizes="160px" className="object-cover" /></span><span className="block bg-white px-2 py-2 text-center text-[11px]">{t(image.label)}</span></label>)}</div></fieldset><label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={editor.active} onChange={(event) => setEditor({ ...editor, active: event.target.checked })} className="size-4 accent-[#bd202b]" />{t("available")}</label><fieldset className="space-y-3"><legend className="mb-3 text-sm font-medium">{t("inventory")}</legend>{stores.map((store) => <label key={store.id} className="flex items-center justify-between gap-4 text-sm">{localText(store.name, locale)}<Input value={editor.stock[store.id] ?? "0"} onChange={(event) => setEditor({ ...editor, stock: { ...editor.stock, [store.id]: event.target.value } })} inputMode="numeric" maxLength={6} required className="w-28 tabular-nums" /></label>)}{!stores.length && <p className="text-sm text-muted-foreground">{t("noStores")}</p>}</fieldset></> : <><label className="block text-sm font-medium">{t("storeAddress")}<Input value={editor.address} onChange={(event) => setEditor({ ...editor, address: event.target.value })} maxLength={240} required className="mt-2" /></label><label className="block text-sm font-medium">{t("storeStatus")}<select value={editor.status} onChange={(event) => setEditor({ ...editor, status: event.target.value as Store["status"] })} className="field-select mt-2 w-full"><option value="active">{t("active")}</option><option value="inactive">{t("inactive")}</option></select></label></>}
      </fieldset>{(recordDeleted || activeError) && <p role="alert" className="text-sm text-destructive">{recordDeleted ? t("recordDeleted") : activeError}</p>}<DialogFooter className="gap-2"><Button type="button" variant="outline" disabled={busy} onClick={closeEditor}>{t("cancel")}</Button><Button type="submit" disabled={busy || recordDeleted}>{busy ? t("saving") : t(editor.id ? "save" : "create")}</Button></DialogFooter></form></>}</DialogContent></Dialog>

    <Dialog open={deletion !== null} onOpenChange={(open) => { if (!open) closeDeletion(); }}><DialogContent className="sm:max-w-[430px]">{deletion && <><DialogHeader><span className="mb-2 grid size-11 place-items-center rounded-full bg-red-50 text-red-700"><Trash2 className="size-5" /></span><DialogTitle>{t(deletion.kind === "gift" ? "deleteGift" : "deleteStore")}</DialogTitle><DialogDescription className="pt-2 text-sm leading-relaxed text-foreground">{t(deletion.kind === "gift" ? "deleteGiftConfirm" : "deleteStoreConfirm", { name: localText(deletion.name, locale) })}</DialogDescription></DialogHeader>{(deletionGone || activeError) && <p role="alert" className="text-sm text-destructive">{deletionGone ? t("recordDeleted") : activeError}</p>}<DialogFooter className="mt-3 gap-2"><Button variant="outline" disabled={busy} onClick={closeDeletion}>{t("cancel")}</Button><Button variant="destructive" disabled={busy || deletionGone} onClick={() => void remove()}>{busy ? t("deleting") : t("delete")}</Button></DialogFooter></>}</DialogContent></Dialog>
  </div>;
}
