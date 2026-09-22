import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import type { ActionInput, Session } from "../src/lib/types";
import { businessDay, businessMonth } from "../src/modules/rules";
import { createService, type SspcService } from "../src/server/service";
import { requireDemoMode } from "../src/integrations/demo";
import { requestJson, requestRole, requestStateQuery, requireSameOrigin } from "../src/server/request";

const services: SspcService[] = [];
const temporaryDirectories: string[] = [];
let requestNumber = 0;

function setup(clock = () => new Date("2026-09-22T06:00:00.000Z"), path = ":memory:"): SspcService {
  const service = createService(path, clock);
  services.push(service);
  return service;
}

function request<T extends Omit<ActionInput, "requestId">>(payload: T): T & { requestId: string } {
  return { ...payload, requestId: `request-${++requestNumber}` };
}

function purchase(service: SspcService, amountCents = 3000, storeId = "st001", memberId = "m001", session?: Session): ActionInput {
  const input = request({ action: "purchase" as const, memberId, storeId, amountCents, receipt: `RECEIPT-${++requestNumber}` });
  service.execute(session ?? service.persona("staff"), input);
  return input;
}

function persistentSetup(): { service: SspcService; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "sspc-domain-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "test.sqlite");
  return { service: setup(undefined, path), path };
}

async function competingActions(path: string, inputs: ActionInput[]): Promise<{ ok: boolean; error?: string }[]> {
  const source = `const { parentPort, workerData } = require('node:worker_threads'); const { registerHooks } = require('node:module'); registerHooks({ resolve(specifier, context, nextResolve) { try { return nextResolve(specifier, context); } catch (error) { if (specifier.startsWith('.')) return nextResolve(specifier + '.ts', context); throw error; } } }); (async () => { const { createService } = await import(workerData.moduleUrl); const service = createService(workerData.path, () => new Date('2026-09-22T06:00:00.000Z')); parentPort.postMessage('ready'); parentPort.once('message', () => { try { service.execute(service.persona('staff'), workerData.input); parentPort.postMessage({ok: true}); } catch (error) { parentPort.postMessage({ok: false, error: error.code ?? error.message}); } finally { service.close(); } }); })();`;
  const workers = inputs.map((input) => new Worker(source, { eval: true, execArgv: ["--experimental-transform-types"], workerData: { path, input, moduleUrl: pathToFileURL(resolve("src/server/service.ts")).href } }));
  try {
    await Promise.all(workers.map((worker) => once(worker, "message")));
    const completion = workers.map((worker) => new Promise<{ ok: boolean; error?: string }>((resolveResult, reject) => {
      let result: { ok: boolean; error?: string } | undefined;
      worker.on("message", (message) => { result = message; });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code === 0 && result) resolveResult(result);
        else reject(new Error("WORKER_FAILED"));
      });
    }));
    for (const worker of workers) worker.postMessage("execute");
    return await Promise.all(completion);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

afterEach(() => {
  for (const service of services.splice(0)) service.close();
  const temporaryRoot = realpathSync(tmpdir());
  for (const directory of temporaryDirectories.splice(0)) {
    const target = realpathSync(directory);
    if (dirname(target) !== temporaryRoot || !basename(target).startsWith("sspc-domain-")) throw new Error("INVALID_TEST_DIRECTORY");
    rmSync(target, { recursive: true });
  }
});

describe("Singapore loyalty rules", () => {
  it.each([[2999, 0], [3000, 1], [6000, 1], [18640, 1]])("awards %i cents correctly", (amount, points) => {
    const service = setup();
    const session = service.persona("member");
    const before = service.state(session).selectedMember!.points;
    purchase(service, amount);
    const after = service.state(session);
    expect(after.selectedMember!.points - before).toBe(points);
    expect(after.activity[0].pointsDelta).toBe(points);
    expect(after.activity[0].kind).toBe("purchase");
  });

  it("counts same-day cross-store purchases as one visit", () => {
    const service = setup();
    purchase(service, 3000, "st001");
    purchase(service, 6000, "st002");
    const member = service.state(service.persona("member")).selectedMember!;
    expect(member.visits).toBe(8);
    expect(member.tier).toBe("gold");
    expect(member.points).toBe(33);
  });

  it("uses Singapore day and month boundaries", () => {
    expect(businessDay(new Date("2026-09-30T15:59:59.999Z"))).toBe("2026-09-30");
    expect(businessMonth(new Date("2026-09-30T16:00:00.000Z"))).toBe("2026-10");
    let now = new Date("2026-09-30T15:59:00.000Z");
    const service = setup(() => now);
    purchase(service);
    expect(service.state(service.persona("member")).selectedMember!.tier).toBe("gold");
    now = new Date("2026-09-30T16:00:00.000Z");
    const member = service.state(service.persona("member")).selectedMember!;
    expect(member.visits).toBe(0);
    expect(member.tier).toBe("bronze");
    expect(member.points).toBe(32);
  });

  it("retains a daily visit if another qualifying purchase remains", () => {
    const service = setup();
    purchase(service);
    purchase(service);
    const latest = service.state(service.persona("member")).purchases[0];
    service.execute(service.persona("staff"), request({ action: "refund", purchaseId: latest.id, amountCents: 3000 }));
    expect(service.state(service.persona("member")).selectedMember!.visits).toBe(8);
  });
});

describe("transactions and permissions", () => {
  it("replays identical requests without duplicate effects and rejects conflicting payloads", () => {
    const service = setup();
    const input = purchase(service);
    const before = service.state(service.persona("member"));
    service.execute(service.persona("staff"), input);
    const after = service.state(service.persona("member"));
    expect(after.selectedMember!.points).toBe(before.selectedMember!.points);
    expect(after.activity[0].id).toBe(before.activity[0].id);
    expect(() => service.execute(service.persona("staff"), { ...input, amountCents: 6000 })).toThrow("IDEMPOTENCY_CONFLICT");
    expect(() => service.execute(service.persona("staff"), { ...input, requestId: "another-request" })).toThrow("DUPLICATE_RECEIPT");
  });

  it("rejects unauthorized stores, members, managers and export", () => {
    const service = setup();
    expect(() => purchase(service, 3000, "st003")).toThrow("FORBIDDEN");
    expect(() => purchase(service, 3000, "st001", "m001", service.persona("member"))).toThrow("FORBIDDEN");
    expect(() => service.state(service.persona("member"), { memberId: "m002" })).toThrow("FORBIDDEN");
    expect(() => service.state(service.persona("staff"), { storeId: "st003" })).toThrow("FORBIDDEN");
    expect(() => service.exportCsv(service.persona("staff"), {})).toThrow("FORBIDDEN");
    expect(() => service.execute(service.persona("staff", "s002"), request({ action: "refund", purchaseId: "p-m001-2", amountCents: 100 }))).toThrow("FORBIDDEN");
  });

  it("returns only authorized staff store transactions and one member's history", () => {
    const service = setup();
    const staff = service.state(service.persona("staff", "s002"), { section: "activity" });
    expect(staff.activity.every((entry) => entry.storeId === "st002")).toBe(true);
    expect(staff.purchases.every((entry) => entry.storeId === "st002")).toBe(true);
    expect(staff.staff).toHaveLength(0);
    expect(staff.audit).toHaveLength(0);
    const member = service.state(service.persona("member"), { section: "activity", page: 1 });
    expect(member.members).toHaveLength(1);
    expect(member.activity.every((entry) => entry.memberId === "m001")).toBe(true);
  });

  it("rechecks changed staff permissions in existing sessions", () => {
    const service = setup();
    const session = service.createSession("staff");
    service.execute(service.persona("admin"), request({ action: "updateStaff", staffId: "s001", role: "cashier", storeIds: ["st002"], active: true }));
    expect(service.sessionForToken("staff", session.token)!.canManage).toBe(false);
    expect(service.sessionForToken("staff", session.token)!.storeIds).toEqual(["st002"]);
    expect(() => purchase(service, 3000, "st001", "m001", session.session)).toThrow("FORBIDDEN");
    service.execute(service.persona("admin"), request({ action: "updateStaff", staffId: "s001", role: "cashier", storeIds: ["st002"], active: false }));
    expect(service.sessionForToken("staff", session.token)).toBeNull();
  });

  it("isolates role sessions and revokes only the requested token", () => {
    const service = setup();
    const member = service.createSession("member");
    const admin = service.createSession("admin");
    expect(service.sessionForToken("admin", member.token)).toBeNull();
    service.revokeSession(member.token);
    expect(service.sessionForToken("member", member.token)).toBeNull();
    expect(service.sessionForToken("admin", admin.token)!.role).toBe("admin");
  });

  it("rejects invalid numeric inputs and suspended members", () => {
    const service = setup();
    expect(() => purchase(service, 3000.1)).toThrow("INVALID_INPUT");
    expect(() => purchase(service, -1)).toThrow("INVALID_INPUT");
    expect(() => purchase(service, 3000, "st001", "m023")).toThrow("MEMBER_SUSPENDED");
  });

  it("fails closed outside explicit demo mode independently of NODE_ENV", () => {
    const original = process.env.APP_MODE;
    try {
      delete process.env.APP_MODE;
      expect(() => requireDemoMode()).toThrow("DEMO_DISABLED");
      process.env.APP_MODE = "production";
      expect(() => requireDemoMode()).toThrow("DEMO_DISABLED");
      process.env.APP_MODE = "demo";
      expect(() => requireDemoMode()).not.toThrow();
    } finally {
      if (original === undefined) delete process.env.APP_MODE;
      else process.env.APP_MODE = original;
    }
  });
});

describe("redemptions and refunds", () => {
  it("deducts atomically and restores cancelled redemption only once", () => {
    const service = setup();
    const staff = service.persona("staff");
    const before = service.state(service.persona("member"));
    service.execute(staff, request({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g001", quantity: 1 }));
    const redeemed = service.state(service.persona("member"));
    expect(redeemed.selectedMember!.points).toBe(before.selectedMember!.points - 10);
    expect(redeemed.selectedMember!.monthlyRedeemed).toBe(1);
    expect(redeemed.gifts[0].stock.st001).toBe(before.gifts[0].stock.st001 - 1);
    const cancel = request({ action: "cancel", redemptionId: redeemed.redemptions[0].id });
    service.execute(staff, cancel);
    service.execute(staff, cancel);
    const after = service.state(service.persona("member"));
    expect(after.selectedMember!.points).toBe(before.selectedMember!.points);
    expect(after.selectedMember!.monthlyRedeemed).toBe(0);
    expect(after.gifts[0].stock.st001).toBe(before.gifts[0].stock.st001);
  });

  it("fulfills only once and rejects cancellation after handover", () => {
    const service = setup();
    const staff = service.persona("staff");
    service.execute(staff, request({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g001", quantity: 1 }));
    const id = service.state(service.persona("member")).redemptions[0].id;
    const fulfill = request({ action: "fulfill", redemptionId: id });
    service.execute(staff, fulfill);
    service.execute(staff, fulfill);
    expect(() => service.execute(staff, request({ action: "cancel", redemptionId: id }))).toThrow("INVALID_REDEMPTION_STATE");
    expect(service.state(service.persona("member")).selectedMember!.points).toBe(21);
  });

  it("keeps a cancelled prior-month redemption out of current quota", () => {
    let now = new Date("2026-09-22T06:00:00.000Z");
    const service = setup(() => now);
    const staff = service.persona("staff");
    service.execute(staff, request({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g001", quantity: 2 }));
    const oldId = service.state(service.persona("member")).redemptions[0].id;
    now = new Date("2026-10-01T00:00:00.000Z");
    service.execute(staff, request({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g002", quantity: 1 }));
    service.execute(staff, request({ action: "cancel", redemptionId: oldId }));
    expect(service.state(service.persona("member")).selectedMember!.monthlyRedeemed).toBe(1);
    expect(service.state(service.persona("member")).selectedMember!.points).toBe(21);
  });

  it("enforces global monthly unit limits across stores", () => {
    const service = setup();
    const staff = service.persona("staff");
    service.execute(staff, request({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g001", quantity: 1 }));
    service.execute(staff, request({ action: "redeem", memberId: "m001", storeId: "st002", giftId: "g001", quantity: 1 }));
    expect(() => service.execute(staff, request({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g002", quantity: 1 }))).toThrow("MONTHLY_LIMIT");
  });

  it("rolls back failed redemptions without changing ledger or balances", () => {
    const service = setup();
    service.execute(service.persona("admin"), request({ action: "updateGift", giftId: "g001", points: 10, active: true, stock: { st001: 0 } }));
    const before = service.state(service.persona("member"));
    expect(() => service.execute(service.persona("staff"), request({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g001", quantity: 1 }))).toThrow("INSUFFICIENT_STOCK");
    const after = service.state(service.persona("member"));
    expect(after.selectedMember!.points).toBe(before.selectedMember!.points);
    expect(after.activity[0].id).toBe(before.activity[0].id);
    expect(after.redemptions).toHaveLength(0);
  });

  it("uses original rules for partial refunds and never revokes an award twice", () => {
    const service = setup();
    purchase(service, 6000);
    const id = service.state(service.persona("member")).purchases[0].id;
    service.execute(service.persona("admin"), request({ action: "updateRules", thresholdCents: 1000, silverVisits: 4, goldVisits: 8, monthlyLimit: 2 }));
    const staff = service.persona("staff");
    service.execute(staff, request({ action: "refund", purchaseId: id, amountCents: 3000 }));
    expect(service.state(service.persona("member")).selectedMember!.points).toBe(32);
    service.execute(staff, request({ action: "refund", purchaseId: id, amountCents: 1 }));
    expect(service.state(service.persona("member")).selectedMember!.points).toBe(31);
    service.execute(staff, request({ action: "refund", purchaseId: id, amountCents: 2999 }));
    expect(service.state(service.persona("member")).selectedMember!.points).toBe(31);
    expect(() => service.execute(staff, request({ action: "refund", purchaseId: id, amountCents: 1 }))).toThrow("REFUND_EXCEEDS_AMOUNT");
  });

  it("allows refund compensation to make points negative and blocks further redemption", () => {
    const service = setup();
    service.execute(service.persona("admin"), request({ action: "updateGift", giftId: "g001", points: 31, active: true, stock: { st001: 8 } }));
    service.execute(service.persona("staff"), request({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g001", quantity: 1 }));
    service.execute(service.persona("admin"), request({ action: "refund", purchaseId: "p-m001-1", amountCents: 4800 }));
    expect(service.state(service.persona("member")).selectedMember!.points).toBe(-1);
    expect(() => service.execute(service.persona("staff"), request({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g002", quantity: 1 }))).toThrow("INSUFFICIENT_POINTS");
  });

  it("waits for a competing database writer before checking the final stock", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sspc-domain-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "test.sqlite");
    const service = setup(undefined, path);
    service.execute(service.persona("admin"), request({ action: "updateGift", giftId: "g001", points: 10, active: true, stock: { st001: 1 } }));
    const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads'); const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(workerData); db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE'); db.prepare('UPDATE gift_stock SET quantity = 0 WHERE gift_id = ? AND store_id = ?').run('g001', 'st001'); parentPort.postMessage('locked'); setTimeout(() => { db.exec('COMMIT'); db.close(); }, 150);`, { eval: true, workerData: path, execArgv: [] });
    await new Promise<void>((resolve, reject) => { worker.once("message", () => resolve()); worker.once("error", reject); });
    const exit = new Promise<number>((resolve, reject) => { worker.once("exit", resolve); worker.once("error", reject); });
    expect(() => service.execute(service.persona("staff"), request({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g001", quantity: 1 }))).toThrow("INSUFFICIENT_STOCK");
    expect(service.state(service.persona("member")).selectedMember!.points).toBe(31);
    expect(await exit).toBe(0);
  });
});

describe("persistent queries", () => {
  it("persists mutations across connections and does not reseed", () => {
    const directory = mkdtempSync(join(tmpdir(), "sspc-domain-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "test.sqlite");
    const first = setup(undefined, path);
    purchase(first);
    const second = setup(undefined, path);
    expect(second.state(second.persona("member")).selectedMember!.points).toBe(32);
    expect(second.state(second.persona("admin"), { section: "members" }).pagination.total).toBe(24);
  });

  it("paginates members, searches literal wildcard characters and aligns CSV filters", () => {
    const service = setup();
    const admin = service.persona("admin");
    const first = service.state(admin, { section: "members", page: 1 });
    const second = service.state(admin, { section: "members", page: 2 });
    expect(first.members).toHaveLength(12);
    expect(second.members).toHaveLength(12);
    expect(first.members[0].id).not.toBe(second.members[0].id);
    expect(service.state(admin, { section: "members", search: "%" }).members).toHaveLength(0);
    const query = { section: "purchases" as const, storeId: "st001", period: "month" as const, search: "Alex" };
    const state = service.state(admin, query);
    const csv = service.exportCsv(admin, query);
    expect(csv.trim().split("\r\n").length - 1).toBe(state.pagination.total);
    expect(csv).toContain("Alex Chen");
    expect(csv).not.toContain("Jurong");
  });

  it("includes older activity references for paginated member receipts", () => {
    const service = setup();
    for (let index = 0; index < 16; index++) purchase(service);
    const state = service.state(service.persona("member"), { section: "activity", page: 2 });
    const purchaseEvents = state.activity.filter((event) => event.kind === "purchase");
    expect(purchaseEvents.every((event) => state.purchases.some((item) => item.id === event.referenceId))).toBe(true);
    expect(state.activity).toHaveLength(12);
    expect(state.latestActivity).toHaveLength(12);
    expect(state.latestActivitySequence).toBe(state.latestActivity[0].sequence);
    expect(state.latestActivitySequence).toBeGreaterThan(state.activity[0].sequence);
    expect(state.latestActivity.every((event) => event.memberId === "m001")).toBe(true);
  });

  it("keeps the append-only ledger equal to member balances after compensation", () => {
    const service = setup();
    const staff = service.persona("staff");
    purchase(service);
    const purchaseId = service.state(service.persona("member")).purchases[0].id;
    service.execute(staff, request({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g001", quantity: 1 }));
    const redemptionId = service.state(service.persona("member")).redemptions[0].id;
    service.execute(service.persona("admin"), request({ action: "updateGift", giftId: "g001", points: 20, active: true, stock: { st001: 10 } }));
    service.execute(staff, request({ action: "cancel", redemptionId }));
    service.execute(staff, request({ action: "refund", purchaseId, amountCents: 3000 }));
    const inconsistent = service.database.prepare("SELECT m.id FROM members m JOIN activity a ON a.member_id = m.id GROUP BY m.id HAVING m.points != SUM(a.points_delta)").all();
    expect(inconsistent).toHaveLength(0);
    expect(service.state(service.persona("member")).selectedMember!.points).toBe(31);
  });

  it("filters activity before pagination without filtering the new-event cursor", () => {
    const service = setup();
    const staff = service.persona("staff");
    service.execute(staff, request({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g001", quantity: 1 }));
    const redemptionId = service.state(service.persona("member")).redemptions[0].id;
    service.execute(staff, request({ action: "cancel", redemptionId }));
    for (let index = 0; index < 13; index++) purchase(service);
    const redemptions = service.state(service.persona("member"), { section: "activity", activityKind: "redemptions" });
    expect(redemptions.pagination.total).toBe(2);
    expect(redemptions.activity).toHaveLength(2);
    expect(redemptions.latestActivity[0].kind).toBe("purchase");
    const purchases = service.state(service.persona("member"), { section: "activity", activityKind: "purchases", page: 2 });
    expect(purchases.pagination.total).toBe(20);
    expect(purchases.activity).toHaveLength(8);
    expect(purchases.activity.every((event) => event.kind === "purchase")).toBe(true);
  });

  it("aligns staff search, store scopes and pagination totals", () => {
    const service = setup();
    const admin = service.persona("admin");
    const all = service.state(admin, { section: "staff" });
    expect(all.staff).toHaveLength(3);
    expect(all.pagination.total).toBe(3);
    const scoped = service.state(admin, { section: "staff", search: "Ryan", storeId: "st002" });
    expect(scoped.staff.map((staff) => staff.id)).toEqual(["s002"]);
    expect(scoped.pagination.total).toBe(1);
    expect(service.state(admin, { section: "staff", search: "Ryan", storeId: "st001" }).pagination.total).toBe(0);
    const members = service.state(admin, { section: "members", storeId: "st003", search: "Alex" });
    expect(members.members).toHaveLength(1);
    expect(members.pagination.total).toBe(1);
  });
});

describe("API request boundaries", () => {
  it("accepts only matching mutation origins", () => {
    const sameOrigin = new Request("http://localhost:3000/api/actions?role=staff", { method: "POST", headers: { Origin: "http://localhost:3000", "Sec-Fetch-Site": "same-origin" } });
    expect(() => requireSameOrigin(sameOrigin)).not.toThrow();
    expect(() => requireSameOrigin(new Request("http://localhost:3000/api/actions", { method: "POST" }))).toThrow("FORBIDDEN");
    expect(() => requireSameOrigin(new Request("http://localhost:3000/api/actions", { method: "POST", headers: { Origin: "http://other.example" } }))).toThrow("FORBIDDEN");
    expect(() => requireSameOrigin(new Request("http://localhost:3000/api/actions", { method: "POST", headers: { Origin: "http://localhost:3000", "Sec-Fetch-Site": "cross-site" } }))).toThrow("FORBIDDEN");
  });

  it("uses the real Host when Next normalizes its internal request hostname", () => {
    const request = new Request("http://localhost:3000/api/session", { method: "POST", headers: { Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000", "Sec-Fetch-Site": "same-origin" } });
    expect(() => requireSameOrigin(request)).not.toThrow();
    expect(() => requireSameOrigin(new Request("http://localhost:3000/api/session", { method: "POST", headers: { Host: "127.0.0.1:3000", Origin: "http://localhost:3000" } }))).toThrow("FORBIDDEN");
    expect(() => requireSameOrigin(new Request("http://localhost:3000/api/session", { method: "POST", headers: { Host: "127.0.0.1:3000", Origin: "http://foreign.example", "X-Forwarded-Host": "foreign.example" } }))).toThrow("FORBIDDEN");
    expect(() => requireSameOrigin(new Request("http://localhost:3000/api/session", { method: "POST", headers: { Host: "127.0.0.1:3000", Origin: "https://127.0.0.1:3000" } }))).toThrow("FORBIDDEN");
    expect(() => requireSameOrigin(new Request("http://localhost:3000/api/session", { method: "POST", headers: { Host: "foreign.example@127.0.0.1:3000", Origin: "http://127.0.0.1:3000" } }))).toThrow("FORBIDDEN");
  });

  it("rejects unknown roles and malformed query bounds", () => {
    expect(requestRole(new Request("http://localhost:3000/api/state?role=member"))).toBe("member");
    expect(() => requestRole(new Request("http://localhost:3000/api/state?role=superuser"))).toThrow("INVALID_INPUT");
    expect(() => requestStateQuery(new Request("http://localhost:3000/api/state?role=member&page=0"))).toThrow("INVALID_INPUT");
    expect(() => requestStateQuery(new Request("http://localhost:3000/api/state?role=member&activityKind=unknown"))).toThrow("INVALID_INPUT");
    expect(requestStateQuery(new Request("http://localhost:3000/api/state?role=member&activityKind=purchases&page=2")).page).toBe(2);
  });

  it("rejects malformed, oversized and non-JSON mutation bodies", async () => {
    const json = (body: string, contentType = "application/json") => new Request("http://localhost:3000/api/actions", { method: "POST", headers: { "Content-Type": contentType }, body });
    expect(await requestJson(json('{"action":"purchase"}'))).toEqual({ action: "purchase" });
    await expect(requestJson(json("{"))).rejects.toThrow("INVALID_INPUT");
    await expect(requestJson(json(`"${"x".repeat(16400)}"`))).rejects.toThrow("INVALID_INPUT");
    await expect(requestJson(json("{}", "text/plain"))).rejects.toThrow("INVALID_INPUT");
    await expect(requestJson(json("{}", "application/jsonp"))).rejects.toThrow("INVALID_INPUT");
  });

  it("expires existing sessions after their fixed lifetime", () => {
    let now = new Date("2026-09-22T06:00:00.000Z");
    const service = setup(() => now);
    const session = service.createSession("member");
    now = new Date("2026-09-22T14:00:00.000Z");
    expect(service.sessionForToken("member", session.token)).toBeNull();
  });
});

describe("competing business transactions", () => {
  it("grants the last stock unit to only one concurrent redemption", async () => {
    const { service, path } = persistentSetup();
    service.execute(service.persona("admin"), request({ action: "updateGift", giftId: "g001", points: 10, active: true, stock: { st001: 1 } }));
    const results = await competingActions(path, [
      request({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g001", quantity: 1 }),
      request({ action: "redeem", memberId: "m007", storeId: "st001", giftId: "g001", quantity: 1 }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)?.error).toBe("INSUFFICIENT_STOCK");
    expect(service.state(service.persona("member")).gifts[0].stock.st001).toBe(0);
  });

  it("grants the last monthly unit across stores only once", async () => {
    const { service, path } = persistentSetup();
    service.execute(service.persona("staff"), request({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g001", quantity: 1 }));
    const results = await competingActions(path, [
      request({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g002", quantity: 1 }),
      request({ action: "redeem", memberId: "m001", storeId: "st002", giftId: "g003", quantity: 1 }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)?.error).toBe("MONTHLY_LIMIT");
    const member = service.state(service.persona("member")).selectedMember!;
    expect(member.monthlyRedeemed).toBe(2);
    expect(member.points).toBe(11);
  });

  it("prevents two concurrent redemptions spending the same balance", async () => {
    const { service, path } = persistentSetup();
    service.execute(service.persona("admin"), request({ action: "updateGift", giftId: "g001", points: 16, active: true, stock: { st001: 5, st002: 5 } }));
    const results = await competingActions(path, [
      request({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g001", quantity: 1 }),
      request({ action: "redeem", memberId: "m001", storeId: "st002", giftId: "g001", quantity: 1 }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)?.error).toBe("INSUFFICIENT_POINTS");
    expect(service.state(service.persona("member")).selectedMember!.points).toBe(15);
  });

  it("commits exactly one outcome when collection and cancellation compete", async () => {
    const { service, path } = persistentSetup();
    service.execute(service.persona("staff"), request({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g001", quantity: 1 }));
    const redemptionId = service.state(service.persona("member")).redemptions[0].id;
    const results = await competingActions(path, [request({ action: "fulfill", redemptionId }), request({ action: "cancel", redemptionId })]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)?.error).toBe("INVALID_REDEMPTION_STATE");
    const state = service.state(service.persona("member"));
    expect(state.selectedMember!.points).toBe(state.redemptions[0].status === "cancelled" ? 31 : 21);
    expect(state.activity.filter((event) => event.kind === "fulfilled" || event.kind === "cancelled")).toHaveLength(1);
  });

  it("rejects retired gifts and invalid rules without mutating business balances", () => {
    const service = setup();
    service.execute(service.persona("admin"), request({ action: "updateGift", giftId: "g001", points: 10, active: false, stock: { st001: 5 } }));
    expect(() => service.execute(service.persona("staff"), request({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g001", quantity: 1 }))).toThrow("GIFT_UNAVAILABLE");
    expect(() => service.execute(service.persona("admin"), request({ action: "updateRules", thresholdCents: 3000, silverVisits: 8, goldVisits: 4, monthlyLimit: 2 }))).toThrow("INVALID_RULES");
    expect(service.state(service.persona("member")).selectedMember!.points).toBe(31);
    expect(service.rules().version).toBe(1);
  });
});

describe("transaction receipts", () => {
  it("returns the submitted purchase and preserves its original snapshot on retry", () => {
    const service = setup();
    const staff = service.persona("staff");
    const input = request({ action: "purchase", memberId: "m001", storeId: "st001", amountCents: 3000, receipt: "EXACT-RECEIPT" });
    const first = service.execute(staff, input);
    expect(first.purchase?.receipt).toBe("EXACT-RECEIPT");
    expect(first.referenceId).toBe(first.purchase?.id);
    expect(first.member?.points).toBe(32);
    expect(first.member?.tier).toBe("gold");
    purchase(service, 6000);
    expect(service.execute(staff, input)).toEqual(first);
    service.database.prepare("UPDATE idempotency SET result_json = NULL WHERE request_id = ?").run(input.requestId);
    expect(service.execute(staff, input)).toEqual({ ok: true });
  });

  it("returns immutable redemption receipts while status queries filter before pagination", () => {
    const service = setup();
    const staff = service.persona("staff");
    const input = request({ action: "redeem", memberId: "m001", storeId: "st001", giftId: "g001", quantity: 1 });
    const first = service.execute(staff, input);
    expect(first.redemption?.status).toBe("confirmed");
    expect(first.member?.points).toBe(21);
    const fulfilled = service.execute(staff, request({ action: "fulfill", redemptionId: first.redemption!.id }));
    expect(fulfilled.redemption?.status).toBe("fulfilled");
    expect(service.execute(staff, input)).toEqual(first);
    const awaiting = service.state(staff, { section: "redemptions", redemptionStatus: "confirmed" });
    expect(awaiting.redemptions.every((redemption) => redemption.status === "confirmed")).toBe(true);
    expect(awaiting.pagination.total).toBe(awaiting.redemptions.length);
    expect(awaiting.redemptions.some((redemption) => redemption.id === first.referenceId)).toBe(false);
  });
});
