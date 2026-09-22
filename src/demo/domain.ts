import type { ActionInput, ActionResult, Activity, AppData, AuditEvent, Gift, Locale, Member, Purchase, Redemption, Role, RuleSet, Session, Staff, StateQuery, Store } from "../lib/types";
import { businessDay, businessMonth, pointsForAmount, tierForVisits } from "../modules/rules";
import { actionSchema } from "../server/validation";
import seed from "./seed.json";

export interface DemoSession { userId: string; expiresAt: string }
export interface DemoChallenge { id: string; phone: string; code: string; createdAt: string; expiresAt: string; resendAt: string; attempts: number; consumed: boolean }
export interface DemoRegistration { token: string; phone: string; expiresAt: string; consumed: boolean }
export interface DemoState {
  schemaVersion: 1;
  revision: number;
  createdAt: string;
  members: Member[];
  stores: Store[];
  gifts: Gift[];
  purchases: Purchase[];
  redemptions: Redemption[];
  activity: Activity[];
  staff: Staff[];
  rules: RuleSet[];
  audit: AuditEvent[];
  refunds: { id: string; purchaseId: string; amountCents: number; points: number; actor: string; createdAt: string }[];
  sessions: Partial<Record<Role, DemoSession>>;
  challenges: DemoChallenge[];
  registrations: DemoRegistration[];
  idempotency: Record<string, { fingerprint: string; result: ActionResult }>;
}

export class DemoError extends Error {
  constructor(readonly code: string, readonly status = 400, readonly details: Record<string, string | number> = {}, readonly commit = false) {
    super(code);
  }
}

export function required<T>(value: T | null | undefined, code = "NOT_FOUND"): T {
  if (value === undefined || value === null) throw new DemoError(code, 404);
  return value;
}

export function createDemoState(now = new Date()): DemoState {
  const copy = structuredClone(seed);
  const offset = now.getTime() - Date.parse(copy.generatedAt);
  const shift = (value: string) => new Date(Date.parse(value) + offset).toISOString();
  for (const item of copy.members) item.joinedAt = shift(item.joinedAt);
  for (const item of copy.purchases) item.createdAt = shift(item.createdAt);
  for (const item of copy.redemptions) { item.createdAt = shift(item.createdAt); item.updatedAt = shift(item.updatedAt); }
  for (const item of copy.activity) item.createdAt = shift(item.createdAt);
  for (const item of copy.rules) item.effectiveAt = shift(item.effectiveAt);
  return {
    schemaVersion: 1, revision: 0, createdAt: now.toISOString(), members: copy.members as Member[], stores: copy.stores as Store[], gifts: copy.gifts as Gift[], purchases: copy.purchases,
    redemptions: copy.redemptions as Redemption[], activity: copy.activity as Activity[], staff: copy.staff as Staff[], rules: copy.rules, audit: [], refunds: [], sessions: {}, challenges: [], registrations: [], idempotency: {},
  };
}

export function demoPersona(state: DemoState, role: Role, userId?: string): Session {
  if (role === "admin") {
    if (userId && userId !== "a001") throw new DemoError("UNAUTHORIZED", 401);
    return { role, userId: "a001", name: "Jordan Lee", storeIds: state.stores.map((store) => store.id), canManage: true };
  }
  if (role === "staff") {
    const person = state.staff.find((item) => item.id === (userId ?? "s001"));
    if (!person?.active) throw new DemoError("UNAUTHORIZED", 401);
    return { role, userId: person.id, name: person.name, storeIds: [...person.storeIds], canManage: person.role === "supervisor" };
  }
  const person = state.members.find((item) => item.id === (userId ?? "m001"));
  if (!person) throw new DemoError("UNAUTHORIZED", 401);
  if (person.status !== "active") throw new DemoError("MEMBER_SUSPENDED", 403);
  return { role, userId: person.id, memberId: person.id, name: person.name, storeIds: [], canManage: false };
}

export function demoSession(state: DemoState, role: Role, now = new Date()): Session | null {
  const record = state.sessions[role];
  if (!record || record.expiresAt <= now.toISOString()) return null;
  try { return demoPersona(state, role, record.userId); } catch { return null; }
}

export function establishDemoSession(state: DemoState, role: Role, userId: string, now: Date): void {
  const person = demoPersona(state, role, userId);
  state.sessions[role] = { userId: person.userId, expiresAt: new Date(now.getTime() + 8 * 3600000).toISOString() };
}

export function demoRules(state: DemoState, now: Date, version?: number): RuleSet {
  return required([...state.rules].sort((a, b) => b.version - a.version).find((item) => version === undefined ? item.effectiveAt <= now.toISOString() : item.version === version));
}

export function demoMember(state: DemoState, memberId: string, session: Session, now: Date): Member {
  const member = required(state.members.find((item) => item.id === memberId), "MEMBER_NOT_FOUND");
  const month = businessMonth(now);
  const purchases = state.purchases.filter((item) => item.memberId === memberId);
  const visits = new Set(purchases.filter((item) => item.points > 0 && businessMonth(new Date(item.createdAt)) === month).map((item) => businessDay(new Date(item.createdAt)))).size;
  const monthlyRedeemed = state.redemptions.filter((item) => item.memberId === memberId && item.status !== "cancelled" && businessMonth(new Date(item.createdAt)) === month).reduce((sum, item) => sum + item.quantity, 0);
  const totalSpendCents = purchases.filter((item) => session.role !== "staff" || session.storeIds.includes(item.storeId)).reduce((sum, item) => sum + item.amountCents - item.refundedCents, 0);
  return { ...member, visits, tier: tierForVisits(visits, demoRules(state, now)), monthlyRedeemed, totalSpendCents };
}

function authorizeStore(state: DemoState, session: Session, storeId: string, existing = false): void {
  if (session.role === "member" || (session.role === "staff" && !session.storeIds.includes(storeId))) throw new DemoError("FORBIDDEN", 403);
  const store = required(state.stores.find((item) => item.id === storeId));
  if (!existing && (store.status !== "active" || store.deleted)) throw new DemoError("STORE_INACTIVE");
}

function activeMember(state: DemoState, id: string): Member {
  const member = required(state.members.find((item) => item.id === id), "MEMBER_NOT_FOUND");
  if (member.status !== "active") throw new DemoError("MEMBER_SUSPENDED");
  return member;
}

function requireManager(session: Session): void {
  if (session.role === "member" || !session.canManage) throw new DemoError("FORBIDDEN", 403);
}

function appendActivity(state: DemoState, kind: Activity["kind"], memberId: string, referenceId: string, storeId: string, pointsDelta: number, now: Date, amountCents?: number): void {
  const member = required(state.members.find((item) => item.id === memberId));
  member.points += pointsDelta;
  state.activity.push({ id: crypto.randomUUID(), sequence: Math.max(0, ...state.activity.map((item) => item.sequence)) + 1, kind, memberId, memberName: member.name, referenceId, storeId, pointsDelta, balanceAfter: member.points, createdAt: now.toISOString(), ...(amountCents === undefined ? {} : { amountCents }) });
}

export function appendDemoAudit(state: DemoState, actor: string, action: string, entityId: string, storeId: string | null, now: Date): void {
  state.audit.push({ id: crypto.randomUUID(), actor, action, entityId, storeId, createdAt: now.toISOString() });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function giftForSession(gift: Gift, session: Session): Gift {
  return { ...gift, name: { ...gift.name }, stock: Object.fromEntries(Object.entries(gift.stock).filter(([storeId]) => session.role !== "staff" || session.storeIds.includes(storeId))) };
}

export function executeDemoAction(state: DemoState, suppliedSession: Session, rawInput: unknown, now = new Date()): { state: DemoState; result: ActionResult } {
  const parsed = actionSchema.safeParse(rawInput);
  if (!parsed.success) throw new DemoError("INVALID_INPUT");
  const input = parsed.data as ActionInput;
  const next = structuredClone(state);
  const session = demoPersona(next, suppliedSession.role, suppliedSession.userId);
  if (session.role === "member" || (["create", "update", "delete"].some((prefix) => input.action.startsWith(prefix)) && session.role !== "admin")) throw new DemoError("FORBIDDEN", 403);
  const fingerprint = canonical(input);
  const key = `${session.userId}:${input.requestId}`;
  const previous = next.idempotency[key];
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new DemoError("IDEMPOTENCY_CONFLICT", 409);
    return { state, result: structuredClone(previous.result) };
  }
  let result: ActionResult = { ok: true };
  let entityId = "";
  let auditStore: string | null = null;
  const receipt = (record: Purchase | Redemption, kind: "purchase" | "redemption"): ActionResult => ({ ok: true, referenceId: record.id, [kind]: { ...record }, member: demoMember(next, record.memberId, session, now) });
  const validStores = new Set(next.stores.filter((store) => !store.deleted).map((store) => store.id));
  switch (input.action) {
    case "purchase": {
      authorizeStore(next, session, input.storeId);
      const member = activeMember(next, input.memberId);
      if (next.purchases.some((item) => item.storeId === input.storeId && item.receipt === input.receipt)) throw new DemoError("DUPLICATE_RECEIPT", 409);
      const rules = demoRules(next, now);
      const points = pointsForAmount(input.amountCents, rules.thresholdCents);
      const purchase: Purchase = { id: crypto.randomUUID(), receipt: input.receipt, memberId: member.id, memberName: member.name, storeId: input.storeId, amountCents: input.amountCents, refundedCents: 0, points, createdAt: now.toISOString(), ruleVersion: rules.version };
      next.purchases.push(purchase);
      appendActivity(next, "purchase", member.id, purchase.id, input.storeId, points, now, input.amountCents);
      entityId = purchase.id; auditStore = input.storeId; result = receipt(purchase, "purchase");
      break;
    }
    case "redeem": {
      authorizeStore(next, session, input.storeId);
      const member = activeMember(next, input.memberId);
      const gift = required(next.gifts.find((item) => item.id === input.giftId));
      if (!gift.active || gift.deleted) throw new DemoError("GIFT_UNAVAILABLE");
      if (demoMember(next, member.id, session, now).monthlyRedeemed + input.quantity > demoRules(next, now).monthlyLimit) throw new DemoError("MONTHLY_LIMIT");
      const points = gift.points * input.quantity;
      if (member.points < points) throw new DemoError("INSUFFICIENT_POINTS");
      if ((gift.stock[input.storeId] ?? 0) < input.quantity) throw new DemoError("INSUFFICIENT_STOCK");
      gift.stock[input.storeId] -= input.quantity;
      const redemption: Redemption = { id: crypto.randomUUID(), memberId: member.id, memberName: member.name, storeId: input.storeId, giftId: gift.id, giftName: { ...gift.name }, quantity: input.quantity, points, status: "confirmed", createdAt: now.toISOString(), updatedAt: now.toISOString() };
      next.redemptions.push(redemption);
      appendActivity(next, "redemption", member.id, redemption.id, input.storeId, -points, now);
      entityId = redemption.id; auditStore = input.storeId; result = receipt(redemption, "redemption");
      break;
    }
    case "fulfill":
    case "cancel": {
      if (input.action === "cancel") requireManager(session);
      const redemption = required(next.redemptions.find((item) => item.id === input.redemptionId));
      authorizeStore(next, session, redemption.storeId, true);
      if (redemption.status !== "confirmed") throw new DemoError("INVALID_REDEMPTION_STATE", 409);
      redemption.status = input.action === "cancel" ? "cancelled" : "fulfilled";
      redemption.updatedAt = now.toISOString();
      if (input.action === "cancel") {
        const gift = required(next.gifts.find((item) => item.id === redemption.giftId));
        gift.stock[redemption.storeId] = (gift.stock[redemption.storeId] ?? 0) + redemption.quantity;
      }
      appendActivity(next, redemption.status, redemption.memberId, redemption.id, redemption.storeId, input.action === "cancel" ? redemption.points : 0, now);
      entityId = redemption.id; auditStore = redemption.storeId; result = receipt(redemption, "redemption");
      break;
    }
    case "refund": {
      requireManager(session);
      const purchase = required(next.purchases.find((item) => item.id === input.purchaseId));
      authorizeStore(next, session, purchase.storeId, true);
      const refunded = purchase.refundedCents + input.amountCents;
      if (refunded > purchase.amountCents) throw new DemoError("REFUND_EXCEEDS_AMOUNT");
      const points = pointsForAmount(purchase.amountCents - refunded, demoRules(next, now, purchase.ruleVersion).thresholdCents);
      const delta = points - purchase.points;
      purchase.points = points; purchase.refundedCents = refunded;
      entityId = crypto.randomUUID(); auditStore = purchase.storeId;
      next.refunds.push({ id: entityId, purchaseId: purchase.id, amountCents: input.amountCents, points: delta, actor: session.userId, createdAt: now.toISOString() });
      appendActivity(next, "refund", purchase.memberId, purchase.id, purchase.storeId, delta, now, -input.amountCents);
      result = receipt(purchase, "purchase");
      break;
    }
    case "createGift": {
      if (Object.keys(input.stock).some((id) => !validStores.has(id))) throw new DemoError("INVALID_INPUT");
      const gift: Gift = { id: crypto.randomUUID(), name: { ...input.name }, category: input.category, image: input.image, points: input.points, active: input.active, deleted: false, stock: Object.fromEntries([...validStores].map((id) => [id, input.stock[id] ?? 0])) };
      next.gifts.push(gift); entityId = gift.id; result = { ok: true, referenceId: gift.id, gift: giftForSession(gift, session) };
      break;
    }
    case "updateGift": {
      const gift = required(next.gifts.find((item) => item.id === input.giftId && !item.deleted));
      if (Object.keys(input.stock).some((id) => !validStores.has(id))) throw new DemoError("INVALID_INPUT");
      Object.assign(gift, { name: input.name ? { ...input.name } : gift.name, category: input.category ?? gift.category, image: input.image ?? gift.image, points: input.points, active: input.active, stock: { ...gift.stock, ...input.stock } });
      entityId = gift.id; result = { ok: true, referenceId: gift.id, gift: giftForSession(gift, session) };
      break;
    }
    case "deleteGift": {
      const gift = required(next.gifts.find((item) => item.id === input.giftId && !item.deleted));
      if (next.redemptions.some((item) => item.giftId === gift.id && item.status === "confirmed")) throw new DemoError("GIFT_IN_USE", 409);
      gift.deleted = true; gift.active = false; entityId = gift.id;
      result = { ok: true, referenceId: gift.id, gift: giftForSession(gift, session) };
      break;
    }
    case "createStore": {
      const store: Store = { id: crypto.randomUUID(), name: { ...input.name }, address: input.address, status: input.status, deleted: false };
      next.stores.push(store);
      for (const gift of next.gifts) if (!gift.deleted) gift.stock[store.id] = 0;
      entityId = store.id; auditStore = store.id; result = { ok: true, referenceId: store.id, store: { ...store } };
      break;
    }
    case "updateStore": {
      const store = required(next.stores.find((item) => item.id === input.storeId && !item.deleted));
      Object.assign(store, { name: { ...input.name }, address: input.address, status: input.status });
      entityId = store.id; auditStore = store.id; result = { ok: true, referenceId: store.id, store: { ...store } };
      break;
    }
    case "deleteStore": {
      const store = required(next.stores.find((item) => item.id === input.storeId && !item.deleted));
      if (next.redemptions.some((item) => item.storeId === store.id && item.status === "confirmed")) throw new DemoError("STORE_IN_USE", 409);
      store.deleted = true; store.status = "inactive"; entityId = store.id; auditStore = store.id;
      result = { ok: true, referenceId: store.id, store: { ...store } };
      break;
    }
    case "updateMember": {
      const member = required(next.members.find((item) => item.id === input.memberId));
      member.status = input.status; entityId = member.id;
      if (input.status === "suspended") {
        if (next.sessions.member?.userId === member.id) delete next.sessions.member;
        for (const challenge of next.challenges) if (challenge.phone === member.phone) challenge.consumed = true;
        for (const token of next.registrations) if (token.phone === member.phone) token.consumed = true;
      }
      break;
    }
    case "updateStaff": {
      const person = required(next.staff.find((item) => item.id === input.staffId));
      if (new Set(input.storeIds).size !== input.storeIds.length || input.storeIds.some((id) => !validStores.has(id))) throw new DemoError("INVALID_INPUT");
      Object.assign(person, { role: input.role, storeIds: [...input.storeIds], active: input.active }); entityId = person.id;
      break;
    }
    case "updateRules": {
      if (input.goldVisits <= input.silverVisits) throw new DemoError("INVALID_RULES");
      const version = Math.max(...next.rules.map((rule) => rule.version)) + 1;
      next.rules.push({ version, thresholdCents: input.thresholdCents, silverVisits: input.silverVisits, goldVisits: input.goldVisits, monthlyLimit: input.monthlyLimit, effectiveAt: now.toISOString() }); entityId = String(version);
      break;
    }
  }
  appendDemoAudit(next, session.userId, input.action, entityId, auditStore, now);
  next.idempotency[key] = { fingerprint, result: structuredClone(result) };
  next.revision += 1;
  return { state: next, result };
}

function includes(value: string, search: string): boolean { return value.toLocaleLowerCase().includes(search.toLocaleLowerCase()); }
function matchesMember(member: Member, search: string): boolean {
  const phoneSearch = /^[+\d\s()-]+$/.test(search) ? search.replace(/[\s()-]/g, "") : search;
  return includes(member.name, search) || includes(member.number, search) || includes(member.phone, phoneSearch) || member.code === search;
}

function filteredRecords<T extends Purchase | Redemption | Activity>(state: DemoState, source: T[], session: Session, query: StateQuery, now: Date): T[] {
  const start = query.period === "month" ? new Date(`${businessMonth(now)}-01T00:00:00+08:00`).toISOString() : query.period === "week" ? new Date(`${businessDay(new Date(now.getTime() - 6 * 86400000))}T00:00:00+08:00`).toISOString() : null;
  const search = query.search?.trim();
  return source.filter((item) => {
    if (session.role === "member" ? item.memberId !== session.memberId : query.memberId && item.memberId !== query.memberId) return false;
    if (session.role === "staff" && !session.storeIds.includes(item.storeId)) return false;
    if (query.storeId && item.storeId !== query.storeId) return false;
    if (start && item.createdAt < start) return false;
    if ("status" in item && query.redemptionStatus && item.status !== query.redemptionStatus) return false;
    if ("kind" in item && query.activityKind && query.activityKind !== "all") {
      const kinds = query.activityKind === "purchases" ? ["purchase", "refund"] : ["redemption", "fulfilled", "cancelled"];
      if (!kinds.includes(item.kind)) return false;
    }
    if (search) {
      const member = state.members.find((entry) => entry.id === item.memberId);
      if (!(member && matchesMember(member, search)) && !includes(item.id, search) && !("receipt" in item && includes(item.receipt, search))) return false;
    }
    return true;
  });
}

export function readDemoAppData(state: DemoState, suppliedSession: Session, query: StateQuery = {}, now = new Date()): AppData {
  const session = demoPersona(state, suppliedSession.role, suppliedSession.userId);
  if (session.role === "member" && query.memberId && query.memberId !== session.memberId) throw new DemoError("FORBIDDEN", 403);
  if (session.role === "staff" && query.storeId && !session.storeIds.includes(query.storeId)) throw new DemoError("FORBIDDEN", 403);
  const rules = demoRules(state, now);
  const page = query.page ?? 1;
  const pageSize = 12;
  const offset = (page - 1) * pageSize;
  const section = query.section ?? "overview";
  const newest = <T extends { createdAt: string; id: string }>(records: T[]) => [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const allPurchases = newest(filteredRecords(state, state.purchases, session, query, now));
  const allRedemptions = newest(filteredRecords(state, state.redemptions, session, query, now));
  const allActivity = filteredRecords(state, state.activity, session, query, now).sort((a, b) => b.sequence - a.sequence);
  const search = query.search?.trim();
  const memberStoreIds = session.role === "admin" && query.storeId ? new Set(filteredRecords(state, state.purchases, session, { ...query, memberId: undefined, search: undefined }, now).map((item) => item.memberId)) : null;
  const allMembers = state.members.filter((item) => (session.role === "member" ? item.id === session.memberId : !search || matchesMember(item, search)) && (!memberStoreIds || memberStoreIds.has(item.id))).sort((a, b) => a.id.localeCompare(b.id));
  const members = allMembers.slice(section === "members" ? offset : 0, (section === "members" ? offset : 0) + pageSize).map((item) => demoMember(state, item.id, session, now));
  const selectedId = session.role === "member" ? session.memberId : query.memberId;
  const selectedMember = selectedId ? demoMember(state, selectedId, session, now) : null;
  const purchases = allPurchases.slice(section === "purchases" ? offset : 0, (section === "purchases" ? offset : 0) + (["purchases", "activity"].includes(section) ? pageSize : 6));
  const redemptions = allRedemptions.slice(section === "redemptions" ? offset : 0, (section === "redemptions" ? offset : 0) + (["redemptions", "activity"].includes(section) ? pageSize : 6));
  const activity = allActivity.slice(section === "activity" ? offset : 0, (section === "activity" ? offset : 0) + (section === "activity" ? pageSize : 6));
  const latestActivity = session.role === "member" ? state.activity.filter((item) => item.memberId === session.memberId).sort((a, b) => b.sequence - a.sequence).slice(0, 12) : [];
  if (section === "activity") for (const event of activity) {
    if (["purchase", "refund"].includes(event.kind) && !purchases.some((item) => item.id === event.referenceId)) {
      const purchase = state.purchases.find((item) => item.id === event.referenceId && item.memberId === event.memberId);
      if (purchase) purchases.push(purchase);
    }
    if (["redemption", "fulfilled", "cancelled"].includes(event.kind) && !redemptions.some((item) => item.id === event.referenceId)) {
      const redemption = state.redemptions.find((item) => item.id === event.referenceId && item.memberId === event.memberId);
      if (redemption) redemptions.push(redemption);
    }
  }
  const eligibleIds = new Set(allPurchases.map((item) => item.memberId));
  const eligibleMembers = state.members.filter((item) => session.role === "member" ? item.id === session.memberId : session.role === "staff" || query.storeId ? eligibleIds.has(item.id) : true);
  const tierCounts = { bronze: 0, silver: 0, gold: 0 };
  for (const item of eligibleMembers) tierCounts[demoMember(state, item.id, session, now).tier] += 1;
  const seriesMap = new Map<string, { date: string; amountCents: number; purchases: number }>();
  for (const purchase of allPurchases) {
    const date = businessDay(new Date(purchase.createdAt));
    const item = seriesMap.get(date) ?? { date, amountCents: 0, purchases: 0 };
    item.amountCents += purchase.amountCents - purchase.refundedCents; item.purchases += 1; seriesMap.set(date, item);
  }
  const allStaff = session.role === "admin" ? state.staff.filter((item) => (!search || includes(item.name, search) || includes(item.id, search)) && (!query.storeId || item.storeIds.includes(query.storeId))).sort((a, b) => a.id.localeCompare(b.id)) : [];
  const stores = state.stores.filter((item) => session.role !== "staff" || session.storeIds.includes(item.id)).sort((a, b) => a.id.localeCompare(b.id));
  const gifts = state.gifts.map((item) => giftForSession(item, session)).sort((a, b) => a.id.localeCompare(b.id));
  const totals: Record<string, number> = { members: allMembers.length, purchases: allPurchases.length, redemptions: allRedemptions.length, activity: allActivity.length, staff: allStaff.length, stores: stores.filter((item) => !item.deleted).length, gifts: gifts.filter((item) => !item.deleted).length };
  return structuredClone({
    session, serverTime: now.toISOString(), businessMonth: businessMonth(now), snapshotVersion: `${businessMonth(now)}-${state.revision}-${rules.version}`,
    members, selectedMember, stores, gifts, purchases, redemptions, activity, latestActivity, latestActivitySequence: latestActivity[0]?.sequence ?? 0,
    staff: allStaff.slice(section === "staff" ? offset : 0, (section === "staff" ? offset : 0) + pageSize), audit: session.role === "admin" ? [...state.audit].reverse().slice(0, 12) : [], rules,
    stats: { members: eligibleMembers.length, activeMembers: eligibleMembers.filter((item) => item.status === "active").length, salesCents: allPurchases.reduce((sum, item) => sum + item.amountCents - item.refundedCents, 0), purchaseCount: allPurchases.length, pointsIssued: allPurchases.reduce((sum, item) => sum + item.points, 0), redemptionCount: allRedemptions.filter((item) => item.status !== "cancelled").reduce((sum, item) => sum + item.quantity, 0), pendingRedemptions: allRedemptions.filter((item) => item.status === "confirmed").length, tierCounts },
    series: [...seriesMap.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-31), pagination: { page, pageSize, total: totals[section] ?? 0 },
  });
}

export function exportDemoCsv(state: DemoState, session: Session, query: StateQuery, locale: Locale, now: Date): string {
  if (session.role !== "admin") throw new DemoError("FORBIDDEN", 403);
  const rows: unknown[][] = [];
  const storeName = (id: string) => required(state.stores.find((item) => item.id === id)).name[locale];
  const date = (value: string) => new Date(value).toLocaleString(locale, { timeZone: "Asia/Singapore" });
  if (query.section === "redemptions") {
    rows.push(locale === "zh-CN" ? ["兑换编号", "会员", "门店", "礼品", "数量", "积分", "状态", "时间（新加坡）"] : ["Redemption", "Member", "Store", "Gift", "Quantity", "Points", "Status", "Time (Singapore)"]);
    const statuses = locale === "zh-CN" ? { confirmed: "待领取", fulfilled: "已领取", cancelled: "已取消" } : { confirmed: "Awaiting collection", fulfilled: "Collected", cancelled: "Cancelled" };
    for (const item of filteredRecords(state, state.redemptions, session, query, now).sort((a, b) => b.createdAt.localeCompare(a.createdAt))) rows.push([item.id, item.memberName, storeName(item.storeId), item.giftName[locale], item.quantity, item.points, statuses[item.status], date(item.createdAt)]);
  } else {
    rows.push(locale === "zh-CN" ? ["收据", "会员", "门店", "金额（SGD）", "退款（SGD）", "有效积分", "时间（新加坡）"] : ["Receipt", "Member", "Store", "Amount (SGD)", "Refund (SGD)", "Effective points", "Time (Singapore)"]);
    for (const item of filteredRecords(state, state.purchases, session, query, now).sort((a, b) => b.createdAt.localeCompare(a.createdAt))) rows.push([item.receipt, item.memberName, storeName(item.storeId), (item.amountCents / 100).toFixed(2), (item.refundedCents / 100).toFixed(2), item.points, date(item.createdAt)]);
  }
  const escape = (value: unknown) => { let text = String(value ?? ""); if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
  return `\uFEFF${rows.map((row) => row.map(escape).join(",")).join("\r\n")}\r\n`;
}
