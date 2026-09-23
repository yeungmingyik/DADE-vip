import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { ActionInput, ActionResult, Activity, AppData, AuditEvent, Gift, Locale, Member, Purchase, Redemption, Role, RuleSet, Session, Staff, StateQuery, Store } from "../lib/types";
import { dateTime } from "../lib/format";
import { businessDay, businessMonth, pointsForAmount, tierForVisits } from "../modules/rules";
import { exportMessages } from "../messages/export";
import { openDatabase } from "./database";
import { DomainError } from "./errors";
import { seedDatabase } from "./seed";
import { actionSchema } from "./validation";

type Row = Record<string, string | number | null>;
type Conditions = { sql: string; params: SQLInputValue[] };
type Clock = () => Date;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",") + "}";
  return JSON.stringify(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function required<T>(value: T | undefined | null, code = "NOT_FOUND"): T {
  if (value === undefined || value === null) throw new DomainError(code, 404);
  return value;
}

export class SspcService {
  readonly database: DatabaseSync;

  constructor(path: string, readonly clock: Clock = () => new Date(), seed = true) {
    this.database = openDatabase(path);
    if (seed) seedDatabase(this.database, this.clock());
  }

  close(): void {
    this.database.close();
  }

  private row(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.database.prepare(sql).get(...params) as Row | undefined;
  }

  private rows(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.database.prepare(sql).all(...params) as Row[];
  }

  private scalar(sql: string, ...params: SQLInputValue[]): number {
    const row = this.row(sql, ...params);
    return row ? Number(Object.values(row)[0] ?? 0) : 0;
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  rules(version?: number, at = this.clock()): RuleSet {
    const row = required(version === undefined
      ? this.row("SELECT * FROM rules WHERE effective_at <= ? ORDER BY version DESC LIMIT 1", at.toISOString())
      : this.row("SELECT * FROM rules WHERE version = ?", version));
    return { version: Number(row.version), thresholdCents: Number(row.threshold_cents), silverVisits: Number(row.silver_visits), goldVisits: Number(row.gold_visits), monthlyLimit: Number(row.monthly_limit), effectiveAt: String(row.effective_at) };
  }

  private staffRecord(row: Row): Staff {
    return { id: String(row.id), name: String(row.name), role: row.role as Staff["role"], storeIds: JSON.parse(String(row.store_ids)) as string[], active: Boolean(row.active) };
  }

  persona(role: Role, id?: string): Session {
    if (role === "admin") {
      if (id && id !== "a001") throw new DomainError("UNAUTHORIZED", 401);
      return { role, userId: "a001", name: "Jordan Lee", storeIds: this.rows("SELECT id FROM stores").map((store) => String(store.id)), canManage: true };
    }
    if (role === "staff") {
      const row = this.row("SELECT * FROM staff WHERE id = ?", id ?? "s001");
      if (!row) throw new DomainError("UNAUTHORIZED", 401);
      const staff = this.staffRecord(row);
      if (!staff.active) throw new DomainError("UNAUTHORIZED", 401);
      return { role, userId: staff.id, name: staff.name, storeIds: staff.storeIds, canManage: staff.role === "supervisor" };
    }
    const member = this.row("SELECT id, name, status FROM members WHERE id = ?", id ?? "m001");
    if (!member) throw new DomainError("UNAUTHORIZED", 401);
    if (member.status !== "active") throw new DomainError("MEMBER_SUSPENDED", 403);
    return { role, userId: String(member.id), memberId: String(member.id), name: String(member.name), storeIds: [], canManage: false };
  }

  createSession(role: Role, personaId?: string): { token: string; session: Session; expiresAt: Date } {
    const session = this.persona(role, personaId);
    const token = `${randomUUID()}${randomUUID()}`;
    const expiresAt = new Date(this.clock().getTime() + 8 * 60 * 60 * 1000);
    this.database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(this.clock().toISOString());
    this.database.prepare("INSERT INTO sessions (token_hash, role, user_id, expires_at) VALUES (?, ?, ?, ?)").run(hash(token), role, session.userId, expiresAt.toISOString());
    return { token, session, expiresAt };
  }

  sessionForToken(role: Role, token: string): Session | null {
    const record = this.row("SELECT * FROM sessions WHERE token_hash = ? AND role = ? AND expires_at > ?", hash(token), role, this.clock().toISOString());
    if (!record) return null;
    try {
      return this.persona(role, String(record.user_id));
    } catch {
      return null;
    }
  }

  revokeSession(token: string): void {
    this.database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash(token));
  }

  private authorizeStore(session: Session, storeId: string, existingRecord = false): void {
    if (session.role === "member" || (session.role === "staff" && !session.storeIds.includes(storeId))) throw new DomainError("FORBIDDEN", 403);
    const store = required(this.row("SELECT status, deleted_at FROM stores WHERE id = ?", storeId));
    if (!existingRecord && (store.status !== "active" || store.deleted_at !== null)) throw new DomainError("STORE_INACTIVE");
  }

  private activeMember(id: string): Row {
    const member = required(this.row("SELECT * FROM members WHERE id = ?", id), "MEMBER_NOT_FOUND");
    if (member.status !== "active") throw new DomainError("MEMBER_SUSPENDED");
    return member;
  }

  private manager(session: Session): void {
    if (session.role === "member" || !session.canManage) throw new DomainError("FORBIDDEN", 403);
  }

  private audit(session: Session, action: string, entityId: string, storeId: string | null, details: unknown, now: string): void {
    this.database.prepare("INSERT INTO audit (id, actor, action, entity_id, store_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), session.userId, action, entityId, storeId, JSON.stringify(details), now);
  }

  private activity(kind: Activity["kind"], memberId: string, referenceId: string, storeId: string, delta: number, amount: number | null, now: string): void {
    if (delta !== 0) this.database.prepare("UPDATE members SET points = points + ? WHERE id = ?").run(delta, memberId);
    const balance = this.scalar("SELECT points FROM members WHERE id = ?", memberId);
    this.database.prepare("INSERT INTO activity (id, kind, member_id, reference_id, store_id, points_delta, balance_after, amount_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), kind, memberId, referenceId, storeId, delta, balance, amount, now);
  }

  private actionReceipt(referenceId: string, kind: "purchase" | "redemption", memberId: string, session: Session, now: string): ActionResult {
    const member = this.memberRecord(required(this.row("SELECT * FROM members WHERE id = ?", memberId)), this.rules(undefined, new Date(now)), session, new Date(now));
    if (kind === "purchase") {
      const purchase = this.purchaseRecord(required(this.row("SELECT p.*, m.name AS member_name FROM purchases p JOIN members m ON m.id = p.member_id WHERE p.id = ?", referenceId)));
      return { ok: true, referenceId, purchase, member };
    }
    const redemption = this.redemptionRecord(required(this.row("SELECT r.*, m.name AS member_name FROM redemptions r JOIN members m ON m.id = r.member_id WHERE r.id = ?", referenceId)));
    return { ok: true, referenceId, redemption, member };
  }

  execute(suppliedSession: Session, rawInput: unknown): ActionResult {
    const parsed = actionSchema.safeParse(rawInput);
    if (!parsed.success) throw new DomainError("INVALID_INPUT");
    const input = parsed.data as ActionInput;
    const fingerprint = hash(canonical(input));
    return this.transaction(() => {
      const now = this.clock().toISOString();
      const session = this.persona(suppliedSession.role, suppliedSession.userId);
      if (session.role === "member") throw new DomainError("FORBIDDEN", 403);
      if (["create", "update", "delete"].some((prefix) => input.action.startsWith(prefix)) && session.role !== "admin") throw new DomainError("FORBIDDEN", 403);
      const existing = this.row("SELECT fingerprint, result_json FROM idempotency WHERE actor = ? AND request_id = ?", session.userId, input.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new DomainError("IDEMPOTENCY_CONFLICT", 409);
        return existing.result_json ? JSON.parse(String(existing.result_json)) as ActionResult : { ok: true };
      }
      let result: ActionResult = { ok: true };
      switch (input.action) {
        case "purchase": {
          this.authorizeStore(session, input.storeId);
          this.activeMember(input.memberId);
          if (this.row("SELECT id FROM purchases WHERE store_id = ? AND receipt = ?", input.storeId, input.receipt)) throw new DomainError("DUPLICATE_RECEIPT", 409);
          const rules = this.rules(undefined, new Date(now));
          const points = pointsForAmount(input.amountCents, rules.thresholdCents);
          const id = randomUUID();
          this.database.prepare("INSERT INTO purchases (id, receipt, member_id, store_id, amount_cents, refunded_cents, points, rule_version, actor, created_at, business_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.receipt, input.memberId, input.storeId, input.amountCents, 0, points, rules.version, session.userId, now, businessDay(new Date(now)));
          this.activity("purchase", input.memberId, id, input.storeId, points, input.amountCents, now);
          this.audit(session, input.action, id, input.storeId, input, now);
          result = this.actionReceipt(id, "purchase", input.memberId, session, now);
          break;
        }
        case "redeem": {
          this.authorizeStore(session, input.storeId);
          const member = this.activeMember(input.memberId);
          const gift = required(this.row("SELECT * FROM gifts WHERE id = ?", input.giftId));
          if (!gift.active || gift.deleted_at !== null) throw new DomainError("GIFT_UNAVAILABLE");
          const rules = this.rules(undefined, new Date(now));
          const month = businessMonth(new Date(now));
          const redeemed = this.scalar("SELECT COALESCE(SUM(quantity), 0) FROM redemptions WHERE member_id = ? AND business_month = ? AND status != 'cancelled'", input.memberId, month);
          if (redeemed + input.quantity > rules.monthlyLimit) throw new DomainError("MONTHLY_LIMIT");
          const points = Number(gift.points) * input.quantity;
          if (Number(member.points) < points) throw new DomainError("INSUFFICIENT_POINTS");
          const stockUpdate = this.database.prepare("UPDATE gift_stock SET quantity = quantity - ? WHERE gift_id = ? AND store_id = ? AND quantity >= ?").run(input.quantity, input.giftId, input.storeId, input.quantity);
          if (Number(stockUpdate.changes) !== 1) throw new DomainError("INSUFFICIENT_STOCK");
          const id = randomUUID();
          this.database.prepare("INSERT INTO redemptions (id, member_id, store_id, gift_id, gift_name_en, gift_name_zh, quantity, points, status, actor, rule_version, business_month, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.memberId, input.storeId, input.giftId, gift.name_en, gift.name_zh, input.quantity, points, "confirmed", session.userId, rules.version, month, now, now);
          this.activity("redemption", input.memberId, id, input.storeId, -points, null, now);
          this.audit(session, input.action, id, input.storeId, input, now);
          result = this.actionReceipt(id, "redemption", input.memberId, session, now);
          break;
        }
        case "fulfill":
        case "cancel": {
          if (input.action === "cancel") this.manager(session);
          const redemption = required(this.row("SELECT * FROM redemptions WHERE id = ?", input.redemptionId));
          this.authorizeStore(session, String(redemption.store_id), true);
          if (redemption.status !== "confirmed") throw new DomainError("INVALID_REDEMPTION_STATE", 409);
          const nextStatus = input.action === "fulfill" ? "fulfilled" : "cancelled";
          const updated = this.database.prepare("UPDATE redemptions SET status = ?, updated_at = ? WHERE id = ? AND status = 'confirmed'").run(nextStatus, now, input.redemptionId);
          if (Number(updated.changes) !== 1) throw new DomainError("INVALID_REDEMPTION_STATE", 409);
          if (input.action === "cancel") this.database.prepare("UPDATE gift_stock SET quantity = quantity + ? WHERE gift_id = ? AND store_id = ?").run(redemption.quantity, redemption.gift_id, redemption.store_id);
          this.activity(nextStatus, String(redemption.member_id), input.redemptionId, String(redemption.store_id), input.action === "cancel" ? Number(redemption.points) : 0, null, now);
          this.audit(session, input.action, input.redemptionId, String(redemption.store_id), input, now);
          result = this.actionReceipt(input.redemptionId, "redemption", String(redemption.member_id), session, now);
          break;
        }
        case "refund": {
          this.manager(session);
          const purchase = required(this.row("SELECT * FROM purchases WHERE id = ?", input.purchaseId));
          this.authorizeStore(session, String(purchase.store_id), true);
          const refunded = Number(purchase.refunded_cents) + input.amountCents;
          if (refunded > Number(purchase.amount_cents)) throw new DomainError("REFUND_EXCEEDS_AMOUNT");
          const originalRules = this.rules(Number(purchase.rule_version));
          const remainingPoints = pointsForAmount(Number(purchase.amount_cents) - refunded, originalRules.thresholdCents);
          const delta = remainingPoints - Number(purchase.points);
          this.database.prepare("UPDATE purchases SET refunded_cents = ?, points = ? WHERE id = ?").run(refunded, remainingPoints, input.purchaseId);
          const id = randomUUID();
          this.database.prepare("INSERT INTO refunds (id, purchase_id, amount_cents, points, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, input.purchaseId, input.amountCents, delta, session.userId, now);
          this.activity("refund", String(purchase.member_id), input.purchaseId, String(purchase.store_id), delta, -input.amountCents, now);
          this.audit(session, input.action, id, String(purchase.store_id), input, now);
          result = this.actionReceipt(input.purchaseId, "purchase", String(purchase.member_id), session, now);
          break;
        }
        case "createGift": {
          const knownStores = new Set(this.rows("SELECT id FROM stores WHERE deleted_at IS NULL").map((store) => String(store.id)));
          if (Object.keys(input.stock).some((id) => !knownStores.has(id))) throw new DomainError("INVALID_INPUT");
          const id = randomUUID();
          this.database.prepare("INSERT INTO gifts (id, name_en, name_zh, category, points, active, image) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, input.name.en, input.name["zh-CN"], input.category, input.points, Number(input.active), input.image);
          for (const storeId of knownStores) this.database.prepare("INSERT INTO gift_stock (gift_id, store_id, quantity) VALUES (?, ?, ?)").run(id, storeId, input.stock[storeId] ?? 0);
          this.audit(session, input.action, id, null, input, now);
          result = { ok: true, referenceId: id, gift: this.giftRecord(required(this.row("SELECT * FROM gifts WHERE id = ?", id)), session) };
          break;
        }
        case "updateGift": {
          const gift = required(this.row("SELECT * FROM gifts WHERE id = ? AND deleted_at IS NULL", input.giftId));
          const knownStores = new Set(this.rows("SELECT id FROM stores WHERE deleted_at IS NULL").map((store) => String(store.id)));
          if (Object.keys(input.stock).some((id) => !knownStores.has(id))) throw new DomainError("INVALID_INPUT");
          this.database.prepare("UPDATE gifts SET name_en = ?, name_zh = ?, category = ?, image = ?, points = ?, active = ? WHERE id = ?").run(input.name?.en ?? gift.name_en, input.name?.["zh-CN"] ?? gift.name_zh, input.category ?? gift.category, input.image ?? gift.image, input.points, Number(input.active), input.giftId);
          for (const [storeId, stock] of Object.entries(input.stock)) this.database.prepare("INSERT INTO gift_stock (gift_id, store_id, quantity) VALUES (?, ?, ?) ON CONFLICT(gift_id, store_id) DO UPDATE SET quantity = excluded.quantity").run(input.giftId, storeId, stock);
          this.audit(session, input.action, input.giftId, null, input, now);
          result = { ok: true, referenceId: input.giftId, gift: this.giftRecord(required(this.row("SELECT * FROM gifts WHERE id = ?", input.giftId)), session) };
          break;
        }
        case "deleteGift": {
          required(this.row("SELECT id FROM gifts WHERE id = ? AND deleted_at IS NULL", input.giftId));
          if (this.row("SELECT id FROM redemptions WHERE gift_id = ? AND status = 'confirmed' LIMIT 1", input.giftId)) throw new DomainError("GIFT_IN_USE", 409);
          this.database.prepare("UPDATE gifts SET active = 0, deleted_at = ? WHERE id = ?").run(now, input.giftId);
          this.audit(session, input.action, input.giftId, null, input, now);
          result = { ok: true, referenceId: input.giftId, gift: this.giftRecord(required(this.row("SELECT * FROM gifts WHERE id = ?", input.giftId)), session) };
          break;
        }
        case "createStore": {
          const id = randomUUID();
          this.database.prepare("INSERT INTO stores (id, name_en, name_zh, address, status) VALUES (?, ?, ?, ?, ?)").run(id, input.name.en, input.name["zh-CN"], input.address, input.status);
          this.database.prepare("INSERT INTO gift_stock (gift_id, store_id, quantity) SELECT id, ?, 0 FROM gifts WHERE deleted_at IS NULL").run(id);
          this.audit(session, input.action, id, id, input, now);
          result = { ok: true, referenceId: id, store: this.storeRecord(required(this.row("SELECT * FROM stores WHERE id = ?", id))) };
          break;
        }
        case "updateStore": {
          required(this.row("SELECT id FROM stores WHERE id = ? AND deleted_at IS NULL", input.storeId));
          this.database.prepare("UPDATE stores SET name_en = ?, name_zh = ?, address = ?, status = ? WHERE id = ?").run(input.name.en, input.name["zh-CN"], input.address, input.status, input.storeId);
          this.audit(session, input.action, input.storeId, input.storeId, input, now);
          result = { ok: true, referenceId: input.storeId, store: this.storeRecord(required(this.row("SELECT * FROM stores WHERE id = ?", input.storeId))) };
          break;
        }
        case "deleteStore": {
          required(this.row("SELECT id FROM stores WHERE id = ? AND deleted_at IS NULL", input.storeId));
          if (this.row("SELECT id FROM redemptions WHERE store_id = ? AND status = 'confirmed' LIMIT 1", input.storeId)) throw new DomainError("STORE_IN_USE", 409);
          this.database.prepare("UPDATE stores SET status = 'inactive', deleted_at = ? WHERE id = ?").run(now, input.storeId);
          this.audit(session, input.action, input.storeId, input.storeId, input, now);
          result = { ok: true, referenceId: input.storeId, store: this.storeRecord(required(this.row("SELECT * FROM stores WHERE id = ?", input.storeId))) };
          break;
        }
        case "updateMember": {
          required(this.row("SELECT id FROM members WHERE id = ?", input.memberId));
          this.database.prepare("UPDATE members SET status = ? WHERE id = ?").run(input.status, input.memberId);
          if (input.status === "suspended") {
            this.database.prepare("DELETE FROM sessions WHERE role = 'member' AND user_id = ?").run(input.memberId);
            this.database.prepare("UPDATE member_otp_challenges SET consumed_at = ? WHERE phone = (SELECT phone FROM members WHERE id = ?) AND consumed_at IS NULL").run(now, input.memberId);
            this.database.prepare("UPDATE member_registration_tokens SET consumed_at = ? WHERE phone = (SELECT phone FROM members WHERE id = ?) AND consumed_at IS NULL").run(now, input.memberId);
          }
          this.audit(session, input.action, input.memberId, null, input, now);
          break;
        }
        case "updateStaff": {
          required(this.row("SELECT id FROM staff WHERE id = ?", input.staffId));
          const knownStores = new Set(this.rows("SELECT id FROM stores WHERE deleted_at IS NULL").map((store) => String(store.id)));
          if (new Set(input.storeIds).size !== input.storeIds.length || input.storeIds.some((id) => !knownStores.has(id))) throw new DomainError("INVALID_INPUT");
          this.database.prepare("UPDATE staff SET role = ?, store_ids = ?, active = ? WHERE id = ?").run(input.role, JSON.stringify(input.storeIds), Number(input.active), input.staffId);
          this.audit(session, input.action, input.staffId, null, input, now);
          break;
        }
        case "updateRules": {
          if (input.goldVisits <= input.silverVisits) throw new DomainError("INVALID_RULES");
          const version = this.scalar("SELECT MAX(version) FROM rules") + 1;
          this.database.prepare("INSERT INTO rules (version, threshold_cents, silver_visits, gold_visits, monthly_limit, effective_at) VALUES (?, ?, ?, ?, ?, ?)").run(version, input.thresholdCents, input.silverVisits, input.goldVisits, input.monthlyLimit, now);
          this.audit(session, input.action, String(version), null, input, now);
          break;
        }
      }
      this.database.prepare("INSERT INTO idempotency (actor, request_id, fingerprint, created_at, result_json) VALUES (?, ?, ?, ?, ?)").run(session.userId, input.requestId, fingerprint, now, JSON.stringify(result));
      return result;
    });
  }

  private storeRecord(store: Row): Store {
    return { id: String(store.id), name: { en: String(store.name_en), "zh-CN": String(store.name_zh) }, address: String(store.address), status: store.status as Store["status"], deleted: store.deleted_at !== null };
  }

  private storeRecords(session: Session): Store[] {
    return this.rows("SELECT * FROM stores ORDER BY id").filter((store) => session.role !== "staff" || session.storeIds.includes(String(store.id))).map((store) => this.storeRecord(store));
  }

  private giftRecord(gift: Row, session: Session, stock = this.rows("SELECT store_id, quantity FROM gift_stock WHERE gift_id = ?", gift.id)): Gift {
    return {
      id: String(gift.id), name: { en: String(gift.name_en), "zh-CN": String(gift.name_zh) }, category: gift.category as Gift["category"], points: Number(gift.points), active: Boolean(gift.active), image: String(gift.image), deleted: gift.deleted_at !== null,
      stock: Object.fromEntries(stock.filter((row) => session.role !== "staff" || session.storeIds.includes(String(row.store_id))).map((row) => [String(row.store_id), Number(row.quantity)])),
    };
  }

  private giftRecords(session: Session): Gift[] {
    const stock = new Map<string, Row[]>();
    for (const row of this.rows("SELECT gift_id, store_id, quantity FROM gift_stock")) {
      const giftId = String(row.gift_id);
      const entries = stock.get(giftId) ?? [];
      entries.push(row);
      stock.set(giftId, entries);
    }
    return this.rows("SELECT * FROM gifts ORDER BY id").map((gift) => this.giftRecord(gift, session, stock.get(String(gift.id)) ?? []));
  }

  private memberRecord(row: Row, rules: RuleSet, session: Session, now = this.clock()): Member {
    const month = businessMonth(now);
    const visits = this.scalar("SELECT COUNT(DISTINCT business_day) FROM purchases WHERE member_id = ? AND substr(business_day, 1, 7) = ? AND points > 0", row.id, month);
    const monthlyRedeemed = this.scalar("SELECT COALESCE(SUM(quantity), 0) FROM redemptions WHERE member_id = ? AND business_month = ? AND status != 'cancelled'", row.id, month);
    const scope = session.role === "staff" ? ` AND store_id IN (${session.storeIds.map(() => "?").join(",")})` : "";
    const totalSpendCents = this.scalar(`SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) FROM purchases WHERE member_id = ?${scope}`, row.id, ...(session.role === "staff" ? session.storeIds : []));
    return { id: String(row.id), number: String(row.number), code: String(row.code), name: String(row.name), phone: String(row.phone), joinedAt: String(row.joined_at), status: row.status as Member["status"], points: Number(row.points), visits, tier: tierForVisits(visits, rules), monthlyRedeemed, totalSpendCents };
  }

  private conditions(session: Session, query: StateQuery, alias: string, search = true, now = this.clock()): Conditions {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (session.role === "member") {
      clauses.push(`${alias}.member_id = ?`);
      params.push(required(session.memberId));
    } else if (query.memberId) {
      clauses.push(`${alias}.member_id = ?`);
      params.push(query.memberId);
    }
    if (session.role === "staff") {
      clauses.push(`${alias}.store_id IN (${session.storeIds.map(() => "?").join(",")})`);
      params.push(...session.storeIds);
    }
    if (query.storeId) {
      clauses.push(`${alias}.store_id = ?`);
      params.push(query.storeId);
    }
    if (alias === "a" && query.activityKind && query.activityKind !== "all") {
      clauses.push(query.activityKind === "purchases" ? "a.kind IN ('purchase', 'refund')" : "a.kind IN ('redemption', 'fulfilled', 'cancelled')");
    }
    if (alias === "r" && query.redemptionStatus) {
      clauses.push("r.status = ?");
      params.push(query.redemptionStatus);
    }
    if (query.period && query.period !== "all") {
      const start = query.period === "month"
        ? new Date(`${businessMonth(now)}-01T00:00:00+08:00`)
        : new Date(`${businessDay(new Date(now.getTime() - 6 * 86400000))}T00:00:00+08:00`);
      clauses.push(`${alias}.created_at >= ?`);
      params.push(start.toISOString());
    }
    if (search && query.search?.trim()) {
      clauses.push(`(${alias}.member_id IN (SELECT id FROM members WHERE name LIKE ? ESCAPE '\\' OR number LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\') OR ${alias}.id LIKE ? ESCAPE '\\'${alias === "p" ? " OR p.receipt LIKE ? ESCAPE '\\'" : ""})`);
      const term = `%${query.search.trim().replace(/[\\%_]/g, "\\$&")}%`;
      const phoneTerm = /^[+\d\s()-]+$/.test(query.search.trim()) ? `%${query.search.trim().replace(/[\s()-]/g, "")}%` : term;
      params.push(term, term, phoneTerm, term);
      if (alias === "p") params.push(term);
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  private purchaseRecord(row: Row): Purchase {
    return { id: String(row.id), receipt: String(row.receipt), memberId: String(row.member_id), memberName: String(row.member_name), storeId: String(row.store_id), amountCents: Number(row.amount_cents), refundedCents: Number(row.refunded_cents), points: Number(row.points), createdAt: String(row.created_at), ruleVersion: Number(row.rule_version) };
  }

  private redemptionRecord(row: Row): Redemption {
    return { id: String(row.id), memberId: String(row.member_id), memberName: String(row.member_name), storeId: String(row.store_id), giftId: String(row.gift_id), giftName: { en: String(row.gift_name_en), "zh-CN": String(row.gift_name_zh) }, quantity: Number(row.quantity), points: Number(row.points), status: row.status as Redemption["status"], createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
  }

  private activityRecord(row: Row): Activity {
    return { id: String(row.id), sequence: Number(row.sequence), kind: row.kind as Activity["kind"], memberId: String(row.member_id), memberName: String(row.member_name), referenceId: String(row.reference_id), storeId: String(row.store_id), pointsDelta: Number(row.points_delta), balanceAfter: Number(row.balance_after), ...(row.amount_cents === null ? {} : { amountCents: Number(row.amount_cents) }), createdAt: String(row.created_at) };
  }

  state(suppliedSession: Session, query: StateQuery = {}): AppData {
    this.database.exec("BEGIN");
    try {
      const state = this.readState(suppliedSession, query);
      this.database.exec("COMMIT");
      return state;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private readState(suppliedSession: Session, query: StateQuery): AppData {
    const now = this.clock();
    const session = this.persona(suppliedSession.role, suppliedSession.userId);
    if (session.role === "member" && query.memberId && query.memberId !== session.memberId) throw new DomainError("FORBIDDEN", 403);
    if (session.role === "staff" && query.storeId && !session.storeIds.includes(query.storeId)) throw new DomainError("FORBIDDEN", 403);
    const rules = this.rules(undefined, now);
    const page = query.page ?? 1;
    const pageSize = 12;
    const section = query.section ?? "overview";
    const offset = (page - 1) * pageSize;
    const p = this.conditions(session, query, "p", true, now);
    const r = this.conditions(session, query, "r", true, now);
    const a = this.conditions(session, query, "a", true, now);
    const memberWhere: string[] = [];
    const memberParams: SQLInputValue[] = [];
    if (session.role === "member") {
      memberWhere.push("id = ?");
      memberParams.push(required(session.memberId));
    } else if (query.search?.trim()) {
      const term = `%${query.search.trim().replace(/[\\%_]/g, "\\$&")}%`;
      memberWhere.push("(name LIKE ? ESCAPE '\\' OR number LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR code = ?)");
      const phoneTerm = /^[+\d\s()-]+$/.test(query.search.trim()) ? `%${query.search.trim().replace(/[\s()-]/g, "")}%` : term;
      memberParams.push(term, term, phoneTerm, query.search.trim());
    }
    if (session.role === "admin" && query.storeId) {
      const memberStore = this.conditions(session, { ...query, memberId: undefined }, "mp", false, now);
      memberWhere.push(`id IN (SELECT mp.member_id FROM purchases mp ${memberStore.sql})`);
      memberParams.push(...memberStore.params);
    }
    const memberSql = memberWhere.length ? `WHERE ${memberWhere.join(" AND ")}` : "";
    const members = this.rows(`SELECT * FROM members ${memberSql} ORDER BY id LIMIT ? OFFSET ?`, ...memberParams, pageSize, section === "members" ? offset : 0).map((row) => this.memberRecord(row, rules, session, now));
    const selectedId = session.role === "member" ? session.memberId : query.memberId;
    const selectedRow = selectedId ? this.row("SELECT * FROM members WHERE id = ?", selectedId) : undefined;
    if (selectedId && !selectedRow) throw new DomainError("MEMBER_NOT_FOUND", 404);
    const selectedMember = selectedRow ? this.memberRecord(selectedRow, rules, session, now) : null;
    const purchases = this.rows(`SELECT p.*, m.name AS member_name FROM purchases p JOIN members m ON m.id = p.member_id ${p.sql} ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`, ...p.params, section === "purchases" || section === "activity" ? pageSize : 6, section === "purchases" ? offset : 0).map((row) => this.purchaseRecord(row));
    const redemptions = this.rows(`SELECT r.*, m.name AS member_name FROM redemptions r JOIN members m ON m.id = r.member_id ${r.sql} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`, ...r.params, section === "redemptions" || section === "activity" ? pageSize : 6, section === "redemptions" ? offset : 0).map((row) => this.redemptionRecord(row));
    const activity = this.rows(`SELECT a.*, m.name AS member_name FROM activity a JOIN members m ON m.id = a.member_id ${a.sql} ORDER BY a.sequence DESC LIMIT ? OFFSET ?`, ...a.params, section === "activity" ? pageSize : 6, section === "activity" ? offset : 0).map((row) => this.activityRecord(row));
    const latestActivity = session.role === "member" ? this.rows("SELECT a.*, m.name AS member_name FROM activity a JOIN members m ON m.id = a.member_id WHERE a.member_id = ? ORDER BY a.sequence DESC LIMIT 12", required(session.memberId)).map((row) => this.activityRecord(row)) : [];
    if (section === "activity") {
      for (const event of activity) {
        if ((event.kind === "purchase" || event.kind === "refund") && !purchases.some((purchase) => purchase.id === event.referenceId)) {
          const row = this.row("SELECT p.*, m.name AS member_name FROM purchases p JOIN members m ON m.id = p.member_id WHERE p.id = ? AND p.member_id = ?", event.referenceId, event.memberId);
          if (row) purchases.push(this.purchaseRecord(row));
        }
        if (["redemption", "fulfilled", "cancelled"].includes(event.kind) && !redemptions.some((redemption) => redemption.id === event.referenceId)) {
          const row = this.row("SELECT r.*, m.name AS member_name FROM redemptions r JOIN members m ON m.id = r.member_id WHERE r.id = ? AND r.member_id = ?", event.referenceId, event.memberId);
          if (row) redemptions.push(this.redemptionRecord(row));
        }
      }
    }
    const sums = required(this.row(`SELECT COUNT(*) AS count, COALESCE(SUM(p.amount_cents - p.refunded_cents), 0) AS sales, COALESCE(SUM(p.points), 0) AS points FROM purchases p ${p.sql}`, ...p.params));
    const redemptionSums = required(this.row(`SELECT COALESCE(SUM(CASE WHEN r.status != 'cancelled' THEN r.quantity ELSE 0 END), 0) AS total, COALESCE(SUM(CASE WHEN r.status = 'confirmed' THEN 1 ELSE 0 END), 0) AS pending FROM redemptions r ${r.sql}`, ...r.params));
    const memberStatsConditions: string[] = [];
    const memberStatsParams: SQLInputValue[] = [];
    if (session.role === "member") {
      memberStatsConditions.push("m.id = ?");
      memberStatsParams.push(required(session.memberId));
    } else if (session.role === "staff" || query.storeId) {
      memberStatsConditions.push(`EXISTS (SELECT 1 FROM purchases p ${p.sql}${p.sql ? " AND" : " WHERE"} p.member_id = m.id)`);
      memberStatsParams.push(...p.params);
    }
    const memberStatsWhere = memberStatsConditions.length ? `WHERE ${memberStatsConditions.join(" AND ")}` : "";
    const visitScope = session.role === "member" ? " AND member_id = ?" : "";
    const memberStats = required(this.row(`WITH visits AS (SELECT member_id, COUNT(DISTINCT business_day) AS total FROM purchases WHERE substr(business_day, 1, 7) = ? AND points > 0${visitScope} GROUP BY member_id), eligible AS (SELECT m.status, COALESCE(v.total, 0) AS visits FROM members m LEFT JOIN visits v ON v.member_id = m.id ${memberStatsWhere}) SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active, COALESCE(SUM(CASE WHEN visits < ? THEN 1 ELSE 0 END), 0) AS bronze, COALESCE(SUM(CASE WHEN visits >= ? AND visits < ? THEN 1 ELSE 0 END), 0) AS silver, COALESCE(SUM(CASE WHEN visits >= ? THEN 1 ELSE 0 END), 0) AS gold FROM eligible`, businessMonth(now), ...(session.role === "member" ? [required(session.memberId)] : []), ...memberStatsParams, rules.silverVisits, rules.silverVisits, rules.goldVisits, rules.goldVisits));
    const tierCounts = { bronze: Number(memberStats.bronze), silver: Number(memberStats.silver), gold: Number(memberStats.gold) };
    const seriesRows = this.rows(`SELECT p.business_day AS date, SUM(p.amount_cents - p.refunded_cents) AS amount, COUNT(*) AS count FROM purchases p ${p.sql} GROUP BY p.business_day ORDER BY p.business_day DESC LIMIT 31`, ...p.params).reverse();
    const audit: AuditEvent[] = session.role === "admin" ? this.rows("SELECT * FROM audit ORDER BY sequence DESC LIMIT 12").map((row) => ({ id: String(row.id), actor: String(row.actor), action: String(row.action), entityId: String(row.entity_id), storeId: row.store_id === null ? null : String(row.store_id), createdAt: String(row.created_at) })) : [];
    const staffClauses: string[] = [];
    const staffParams: SQLInputValue[] = [];
    if (query.search?.trim()) {
      const term = `%${query.search.trim().replace(/[\\%_]/g, "\\$&")}%`;
      staffClauses.push("(name LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')");
      staffParams.push(term, term);
    }
    if (query.storeId) {
      staffClauses.push("EXISTS (SELECT 1 FROM json_each(staff.store_ids) scope WHERE scope.value = ?)");
      staffParams.push(query.storeId);
    }
    const staffWhere = staffClauses.length ? `WHERE ${staffClauses.join(" AND ")}` : "";
    const staff = session.role === "admin" ? this.rows(`SELECT * FROM staff ${staffWhere} ORDER BY id LIMIT ? OFFSET ?`, ...staffParams, pageSize, section === "staff" ? offset : 0).map((row) => this.staffRecord(row)) : [];
    const stores = this.storeRecords(session);
    const gifts = this.giftRecords(session);
    const totals: Record<string, number> = {
      members: this.scalar(`SELECT COUNT(*) FROM members ${memberSql}`, ...memberParams),
      purchases: Number(sums.count),
      redemptions: this.scalar(`SELECT COUNT(*) FROM redemptions r ${r.sql}`, ...r.params),
      activity: this.scalar(`SELECT COUNT(*) FROM activity a ${a.sql}`, ...a.params),
      staff: session.role === "admin" ? this.scalar(`SELECT COUNT(*) FROM staff ${staffWhere}`, ...staffParams) : 0,
      stores: stores.filter((store) => !store.deleted).length,
      gifts: gifts.filter((gift) => !gift.deleted).length,
    };
    return {
      session, serverTime: now.toISOString(), businessMonth: businessMonth(now), snapshotVersion: `${businessMonth(now)}-${this.scalar("SELECT COALESCE(MAX(sequence), 0) FROM audit")}-${rules.version}`,
      members, selectedMember, stores, gifts, purchases, redemptions, activity, latestActivity, latestActivitySequence: latestActivity[0]?.sequence ?? 0, staff, audit, rules,
      stats: { members: Number(memberStats.total), activeMembers: Number(memberStats.active), salesCents: Number(sums.sales), purchaseCount: Number(sums.count), pointsIssued: Number(sums.points), redemptionCount: Number(redemptionSums.total), pendingRedemptions: Number(redemptionSums.pending), tierCounts },
      series: seriesRows.map((row) => ({ date: String(row.date), amountCents: Number(row.amount), purchases: Number(row.count) })), pagination: { page, pageSize, total: totals[section] ?? 0 },
    };
  }

  exportCsv(suppliedSession: Session, query: StateQuery, locale: Locale = "en"): string {
    const session = this.persona(suppliedSession.role, suppliedSession.userId);
    if (session.role !== "admin") throw new DomainError("FORBIDDEN", 403);
    const section = query.section === "redemptions" ? "redemptions" : "purchases";
    const escape = (value: unknown): string => {
      let text = String(value ?? "");
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    };
    const rows: unknown[][] = [];
    const messages = exportMessages[locale];
    if (section === "purchases") {
      const p = this.conditions(session, query, "p");
      rows.push([...messages.purchaseHeaders]);
      for (const row of this.rows(`SELECT p.*, m.name AS member_name, s.name_en, s.name_zh FROM purchases p JOIN members m ON m.id = p.member_id JOIN stores s ON s.id = p.store_id ${p.sql} ORDER BY p.created_at DESC`, ...p.params)) rows.push([row.receipt, row.member_name, locale === "zh-CN" ? row.name_zh : row.name_en, (Number(row.amount_cents) / 100).toFixed(2), (Number(row.refunded_cents) / 100).toFixed(2), row.points, dateTime(String(row.created_at), locale)]);
    } else {
      const r = this.conditions(session, query, "r");
      const statuses = messages.redemptionStatuses;
      rows.push([...messages.redemptionHeaders]);
      for (const row of this.rows(`SELECT r.*, m.name AS member_name, s.name_en, s.name_zh FROM redemptions r JOIN members m ON m.id = r.member_id JOIN stores s ON s.id = r.store_id ${r.sql} ORDER BY r.created_at DESC`, ...r.params)) rows.push([row.id, row.member_name, locale === "zh-CN" ? row.name_zh : row.name_en, locale === "zh-CN" ? row.gift_name_zh : row.gift_name_en, row.quantity, row.points, statuses[row.status as Redemption["status"]], dateTime(String(row.created_at), locale)]);
    }
    return `\uFEFF${rows.map((row) => row.map(escape).join(",")).join("\r\n")}\r\n`;
  }
}

export function createService(path: string, clock: Clock = () => new Date(), seed = true): SspcService {
  return new SspcService(path, clock, seed);
}
