import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionPayload, AppData, Role } from "../src/lib/types";
import { businessMonth } from "../src/modules/rules";
import { createService } from "../src/server/service";
import { createDemoState, demoHasSession, demoPersona, demoRequest, executeDemoAction, executeDemoRequest, readDemoAppData, readSessionRole, type DemoState } from "../src/demo/service";
import { DEMO_STORAGE_KEY } from "../src/demo/storage";

const instant = new Date("2026-09-22T06:00:00.000Z");
let sequence = 0;
const input = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function setup(initial = createDemoState(instant)) {
  let state = initial;
  return {
    get state() { return state; },
    action(payload: ActionPayload, role: Role = "staff", userId?: string, now = instant, requestId = `request-${++sequence}`) {
      const result = executeDemoAction(state, demoPersona(state, role, userId), { ...payload, requestId }, now);
      state = result.state;
      return result.result;
    },
    async request<T = Record<string, unknown>>(path: string, options: RequestInit = {}, now = instant) {
      const result = executeDemoRequest(state, path, options, now);
      state = result.state;
      return { response: result.response, body: await result.response.clone().json() as T, status: result.response.status };
    },
    data(role: Role = "admin", query: Parameters<typeof readDemoAppData>[2] = {}, now = instant, userId?: string) { return readDemoAppData(state, demoPersona(state, role, userId), query, now); },
  };
}

interface Challenge { challengeId: string; demoCode: string; resendAt: string; expiresAt: string }

afterEach(() => { vi.unstubAllGlobals(); });

describe("browser demo business engine", () => {
  it("starts from the complete server synthetic dataset and matches query totals", () => {
    const service = createService(":memory:", () => instant);
    try {
      const demo = setup();
      for (const role of ["member", "staff", "admin"] as const) {
        const query = { section: "activity" as const, period: "month" as const };
        const actual = demo.data(role, query);
        const expected = service.state(service.persona(role), query);
        expect(actual.stats).toEqual(expected.stats);
        expect(actual.series).toEqual(expected.series);
        expect(actual.pagination).toEqual(expected.pagination);
        expect(actual.stores).toEqual(expected.stores);
        expect(actual.gifts).toEqual(expected.gifts);
        const memberDetails = (members: AppData["members"]) => members.map((member) => Object.fromEntries(Object.entries(member).filter(([key]) => key !== "code")));
        expect(memberDetails(actual.members)).toEqual(memberDetails(expected.members));
      }
    } finally { service.close(); }
  });

  it("migrates seed dates to the current timeline without changing balances", () => {
    const future = new Date("2028-04-22T06:00:00.000Z");
    const state = createDemoState(future);
    const member = readDemoAppData(state, demoPersona(state, "member"), {}, future).selectedMember!;
    expect(member.points).toBe(31);
    expect(member.visits).toBe(7);
    expect(state.purchases.every((item) => businessMonth(new Date(item.createdAt)) === "2028-04")).toBe(true);
  });

  it("records exact receipt thresholds and counts one cross-store visit per day", () => {
    const demo = setup();
    const before = demo.data("member").selectedMember!;
    const results = [2999, 3000, 6000, 18640].map((amountCents, index) => demo.action({ action: "purchase", memberId: "m001", storeId: index % 2 ? "st002" : "st001", amountCents, receipt: `boundary-${index}` }));
    expect(results.map((item) => item.purchase!.points)).toEqual([0, 1, 1, 1]);
    const member = demo.data("member").selectedMember!;
    expect(member.points).toBe(before.points + 3);
    expect(member.visits).toBe(before.visits + 1);
    expect(member.tier).toBe("gold");
  });

  it("returns the original result for retries and rolls back conflicting writes", () => {
    const demo = setup();
    const payload = { action: "purchase" as const, memberId: "m001", storeId: "st001", amountCents: 3000, receipt: "same-receipt" };
    const first = demo.action(payload, "staff", undefined, instant, "purchase-once");
    const after = structuredClone(demo.state);
    expect(demo.action(payload, "staff", undefined, instant, "purchase-once")).toEqual(first);
    expect(demo.state).toEqual(after);
    expect(() => demo.action({ ...payload, amountCents: 6000 }, "staff", undefined, instant, "purchase-once")).toThrow("IDEMPOTENCY_CONFLICT");
    expect(() => demo.action(payload)).toThrow("DUPLICATE_RECEIPT");
    expect(demo.state).toEqual(after);
  });

  it("refunds under the original rule version and rejects excess refunds", () => {
    const demo = setup();
    const purchase = demo.action({ action: "purchase", memberId: "m001", storeId: "st001", amountCents: 6000, receipt: "refund-rule" }).purchase!;
    demo.action({ action: "updateRules", thresholdCents: 7000, silverVisits: 4, goldVisits: 8, monthlyLimit: 2 }, "admin");
    const first = demo.action({ action: "refund", purchaseId: purchase.id, amountCents: 2000 });
    expect(first.purchase!.points).toBe(1);
    const second = demo.action({ action: "refund", purchaseId: purchase.id, amountCents: 1001 });
    expect(second.purchase!.points).toBe(0);
    expect(second.member!.visits).toBe(7);
    const before = structuredClone(demo.state);
    expect(() => demo.action({ action: "refund", purchaseId: purchase.id, amountCents: 3000 })).toThrow("REFUND_EXCEEDS_AMOUNT");
    expect(demo.state).toEqual(before);
    expect(demo.state.refunds).toHaveLength(2);
  });

  it("atomically enforces stock, points, quota and redemption state", () => {
    const demo = setup();
    const baseline = demo.data("member").selectedMember!.points;
    demo.action({ action: "updateGift", giftId: "g001", points: 10, active: true, stock: { st001: 1 } }, "admin");
    const redemption = demo.action({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g001", quantity: 1 }).redemption!;
    const after = structuredClone(demo.state);
    expect(() => demo.action({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g001", quantity: 1 })).toThrow("INSUFFICIENT_STOCK");
    expect(demo.state).toEqual(after);
    const cancelled = demo.action({ action: "cancel", redemptionId: redemption.id });
    expect(cancelled.member!.points).toBe(baseline);
    expect(cancelled.member!.monthlyRedeemed).toBe(0);
    expect(demo.state.gifts.find((item) => item.id === "g001")!.stock.st001).toBe(1);
    expect(() => demo.action({ action: "cancel", redemptionId: redemption.id })).toThrow("INVALID_REDEMPTION_STATE");
    const next = demo.action({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g002", quantity: 2 }).redemption!;
    expect(() => demo.action({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g002", quantity: 1 })).toThrow("MONTHLY_LIMIT");
    expect(demo.action({ action: "fulfill", redemptionId: next.id }).redemption!.status).toBe("fulfilled");
    expect(() => demo.action({ action: "cancel", redemptionId: next.id })).toThrow("INVALID_REDEMPTION_STATE");
  });

  it("keeps new-month quotas independent of old-month cancellation", () => {
    const state = createDemoState(instant);
    state.members.find((item) => item.id === "m001")!.points = 100;
    const demo = setup(state);
    const prior = demo.action({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g001", quantity: 2 }).redemption!;
    const nextMonth = new Date("2026-10-01T01:00:00.000Z");
    demo.action({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g002", quantity: 2 }, "staff", undefined, nextMonth);
    demo.action({ action: "cancel", redemptionId: prior.id }, "staff", undefined, nextMonth);
    const member = demo.data("member", {}, nextMonth).selectedMember!;
    expect(member.monthlyRedeemed).toBe(2);
    expect(member.visits).toBe(0);
    expect(member.tier).toBe("bronze");
  });

  it("retains historical catalog records and prevents deletion with pending handover", () => {
    const demo = setup();
    const store = demo.action({ action: "createStore", name: { en: "West", "zh-CN": "西区" }, address: "Synthetic address", status: "active" }, "admin").store!;
    expect(demo.state.gifts.every((item) => item.stock[store.id] === 0)).toBe(true);
    const gift = demo.action({ action: "createGift", name: { en: "Gift", "zh-CN": "礼品" }, category: "care", image: "/gifts/care.webp", points: 10, active: true, stock: { [store.id]: 2 } }, "admin").gift!;
    expect(gift.stock.st001).toBe(0);
    const redemption = demo.action({ action: "redeem", memberId: "m001", storeId: store.id, giftId: gift.id, quantity: 1 }, "admin").redemption!;
    expect(() => demo.action({ action: "deleteGift", giftId: gift.id }, "admin")).toThrow("GIFT_IN_USE");
    expect(() => demo.action({ action: "deleteStore", storeId: store.id }, "admin")).toThrow("STORE_IN_USE");
    demo.action({ action: "fulfill", redemptionId: redemption.id }, "admin");
    demo.action({ action: "deleteGift", giftId: gift.id }, "admin");
    demo.action({ action: "deleteStore", storeId: store.id }, "admin");
    expect(demo.data().gifts.find((item) => item.id === gift.id)?.deleted).toBe(true);
    expect(demo.data().stores.find((item) => item.id === store.id)?.deleted).toBe(true);
    expect(demo.state.redemptions.find((item) => item.id === redemption.id)!.giftName).toEqual({ en: "Gift", "zh-CN": "礼品" });
    expect(() => demo.action({ action: "updateStore", storeId: store.id, name: store.name, address: store.address, status: "active" }, "admin")).toThrow("NOT_FOUND");
    expect(() => demo.action({ action: "updateGift", giftId: "g001", points: 10, active: true, stock: { [store.id]: 2 } }, "admin")).toThrow("INVALID_INPUT");
  });

  it("enforces roles and store scope while allowing historical refunds at inactive stores", () => {
    const demo = setup();
    const purchase = demo.action({ action: "purchase", memberId: "m001", storeId: "st001", amountCents: 3000, receipt: "scope" }).purchase!;
    expect(() => demo.action({ action: "refund", purchaseId: purchase.id, amountCents: 1 }, "staff", "s002")).toThrow("FORBIDDEN");
    expect(() => demo.action({ action: "deleteGift", giftId: "g003" }, "staff")).toThrow("FORBIDDEN");
    expect(() => demo.data("member", { memberId: "m002" })).toThrow("FORBIDDEN");
    expect(() => demo.data("staff", { storeId: "st003" })).toThrow("FORBIDDEN");
    const store = demo.state.stores.find((item) => item.id === "st001")!;
    demo.action({ action: "updateStore", storeId: store.id, name: store.name, address: store.address, status: "inactive" }, "admin");
    expect(demo.action({ action: "refund", purchaseId: purchase.id, amountCents: 1 }).purchase!.refundedCents).toBe(1);
    expect(() => demo.action({ action: "purchase", memberId: "m001", storeId: "st001", amountCents: 3000, receipt: "inactive" })).toThrow("STORE_INACTIVE");
  });

  it("filters and paginates histories and includes receipt records for old activity", () => {
    const demo = setup();
    expect(demo.data("admin", { section: "members", search: "+65 8000 1001" }).members.map((item) => item.id)).toEqual(["m001"]);
    const first = demo.data("admin", { section: "purchases", page: 1, storeId: "st001", search: "Alex" });
    expect(first.purchases.every((item) => item.storeId === "st001" && item.memberId === "m001")).toBe(true);
    expect(first.stats.purchaseCount).toBe(first.pagination.total);
    expect(demo.data("admin", { section: "members", page: 2 }).members).toHaveLength(12);
    const activity = demo.data("member", { section: "activity", activityKind: "purchases" });
    expect(activity.activity.every((item) => activity.purchases.some((purchase) => purchase.id === item.referenceId))).toBe(true);
  });
});

describe("browser demo authentication and HTTP responses", () => {
  it("logs in existing members while retaining independent workplace sessions", async () => {
    const demo = setup();
    expect((await demo.request("/api/state?role=member")).status).toBe(401);
    await demo.request("/api/session", input({ role: "staff", personaId: "s001" }));
    await demo.request("/api/session", input({ role: "admin", personaId: "a001" }));
    const challenge = (await demo.request<Challenge>("/api/auth/member", input({ action: "request", phone: "+65 (8000) 1001" }))).body;
    expect((await demo.request("/api/auth/member", input({ action: "verify", challengeId: challenge.challengeId, code: challenge.demoCode }))).body.status).toBe("authenticated");
    const member = await demo.request<AppData>("/api/state?role=member");
    expect(member.body.selectedMember!.points).toBe(31);
    expect(member.response.headers.get("cache-control")).toBe("no-store");
    await demo.request("/api/session?role=member", { method: "DELETE" });
    expect((await demo.request("/api/state?role=member")).status).toBe(401);
    expect((await demo.request("/api/state?role=staff")).status).toBe(200);
    expect((await demo.request("/api/state?role=admin")).status).toBe(200);
    expect((await demo.request("/api/session", input({ role: "member", personaId: "m001" }))).status).toBe(403);
  });

  it("creates a zero-balance member only after consuming registration credentials", async () => {
    const demo = setup();
    const challenge = (await demo.request<Challenge>("/api/auth/member", input({ action: "request", phone: "90001001" }))).body;
    const verified = (await demo.request<{ status: string; registrationToken: string }>("/api/auth/member", input({ action: "verify", challengeId: challenge.challengeId, code: challenge.demoCode }))).body;
    expect(verified.status).toBe("registration");
    expect(demo.state.members).toHaveLength(24);
    expect((await demo.request("/api/auth/member", input({ action: "register", registrationToken: verified.registrationToken, name: "  New Member  " }))).body.status).toBe("authenticated");
    const member = (await demo.request<AppData>("/api/state?role=member")).body.selectedMember!;
    expect(member).toMatchObject({ name: "New Member", phone: "+6590001001", points: 0, visits: 0, tier: "bronze", monthlyRedeemed: 0 });
    expect((await demo.request("/api/auth/member", input({ action: "register", registrationToken: verified.registrationToken, name: "Duplicate" }))).body.error).toBe("REGISTRATION_INVALID");
    expect(demo.state.members).toHaveLength(25);
  });

  it("persists failed attempts, locks used challenges and enforces resend timers", async () => {
    const demo = setup();
    const challenge = (await demo.request<Challenge>("/api/auth/member", input({ action: "request", phone: "80001001" }))).body;
    expect((await demo.request("/api/auth/member", input({ action: "request", phone: "80001001" }))).body).toMatchObject({ error: "OTP_RATE_LIMITED", retryAfterSeconds: 60 });
    const wrong = challenge.demoCode === "111111" ? "222222" : "111111";
    for (let attempt = 1; attempt <= 5; attempt++) {
      const response = await demo.request("/api/auth/member", input({ action: "verify", challengeId: challenge.challengeId, code: wrong }));
      expect(response.body).toMatchObject({ error: attempt === 5 ? "OTP_LOCKED" : "OTP_INVALID", attemptsRemaining: 5 - attempt });
    }
    expect((await demo.request("/api/auth/member", input({ action: "verify", challengeId: challenge.challengeId, code: challenge.demoCode }))).body.error).toBe("OTP_LOCKED");
    const later = new Date(instant.getTime() + 60000);
    const replacement = await demo.request<Challenge>("/api/auth/member", input({ action: "request", phone: "80001001" }), later);
    expect(replacement.status).toBe(200);
    expect((await demo.request("/api/auth/member", input({ action: "verify", challengeId: challenge.challengeId, code: challenge.demoCode }), later)).body.error).toBe("OTP_CHALLENGE_INVALID");
    expect((await demo.request("/api/auth/member", input({ action: "verify", challengeId: replacement.body.challengeId, code: replacement.body.demoCode }), new Date(later.getTime() + 300000))).body.error).toBe("OTP_EXPIRED");
  });

  it("expires registration credentials and invalidates suspended member sessions", async () => {
    const demo = setup();
    const challenge = (await demo.request<Challenge>("/api/auth/member", input({ action: "request", phone: "90001001" }))).body;
    const verified = (await demo.request<{ registrationToken: string }>("/api/auth/member", input({ action: "verify", challengeId: challenge.challengeId, code: challenge.demoCode }))).body;
    expect((await demo.request("/api/auth/member", input({ action: "register", registrationToken: verified.registrationToken, name: "New" }), new Date(instant.getTime() + 600000))).body.error).toBe("REGISTRATION_EXPIRED");
    const existing = (await demo.request<Challenge>("/api/auth/member", input({ action: "request", phone: "80001001" }))).body;
    await demo.request("/api/auth/member", input({ action: "verify", challengeId: existing.challengeId, code: existing.demoCode }));
    demo.action({ action: "updateMember", memberId: "m001", status: "suspended" }, "admin");
    expect((await demo.request("/api/state?role=member")).status).toBe(401);
    expect((await demo.request("/api/state?role=admin&unknown=1")).status).toBe(400);
  });

  it("exports all filtered rows with bilingual headers and formula escaping", async () => {
    const demo = setup();
    demo.action({ action: "purchase", memberId: "m001", storeId: "st001", amountCents: 3000, receipt: "=SUM(A1:A2)" });
    await demo.request("/api/session", input({ role: "admin" }));
    const result = executeDemoRequest(demo.state, "/api/export?role=admin&section=purchases&locale=zh-CN&storeId=st001&search=Alex&page=999", {}, instant);
    const csv = await result.response.text();
    expect(result.response.status).toBe(200);
    expect(csv).toContain('"收据编号","会员"');
    expect(csv).toContain('"\'=SUM(A1:A2)"');
    expect(csv).not.toContain("Rachel Tan");
    expect(csv.split("\r\n").length - 2).toBe(demo.data("admin", { section: "purchases", storeId: "st001", search: "Alex" }).pagination.total);
  });

  it("serializes competing localStorage transactions and restores synchronous sessions", async () => {
    const entries = new Map<string, string>();
    entries.set(DEMO_STORAGE_KEY, JSON.stringify(createDemoState(new Date())));
    let queue = Promise.resolve();
    const lock = vi.fn((_name: string, _options: unknown, operation: () => unknown) => {
      const result = queue.then(operation);
      queue = result.then(() => undefined, () => undefined);
      return result;
    });
    vi.stubGlobal("window", { localStorage: { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value) } });
    vi.stubGlobal("navigator", { locks: { request: lock } });
    await demoRequest("/api/session", input({ role: "staff", personaId: "s001" }));
    await demoRequest("/api/session", input({ role: "admin", personaId: "a001" }));
    expect(demoHasSession("staff")).toBe(true);
    expect(readSessionRole("admin")!.name).toBe("Jordan Lee");
    await demoRequest("/api/actions?role=admin", input({ action: "updateGift", requestId: "set-single-stock", giftId: "g001", points: 10, active: true, stock: { st001: 1 } }));
    const results = await Promise.all(["stock-race-one", "stock-race-two"].map((requestId) => demoRequest("/api/actions?role=staff", input({ action: "redeem", requestId, memberId: "m001", storeId: "st001", giftId: "g001", quantity: 1 }))));
    expect(results.map((response) => response.status).sort()).toEqual([200, 400]);
    const state = JSON.parse(entries.get(DEMO_STORAGE_KEY)!) as DemoState;
    expect(state.gifts.find((gift) => gift.id === "g001")!.stock.st001).toBe(0);
    expect(state.redemptions.filter((item) => item.memberId === "m001")).toHaveLength(1);
    await demoRequest("/api/session?role=staff", { method: "DELETE" });
    expect(demoHasSession("staff")).toBe(false);
    expect(demoHasSession("admin")).toBe(true);
    expect(lock).toHaveBeenCalledTimes(6);
  });
});
