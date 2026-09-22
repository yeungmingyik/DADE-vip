import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { ActionInput, ActionPayload, ActionResult } from "../src/lib/types";
import { seedDatabase } from "../src/server/seed";
import { createService, type SspcService } from "../src/server/service";

const services: SspcService[] = [];
const temporaryDirectories: string[] = [];
const now = () => new Date("2026-09-22T06:00:00.000Z");
let requestNumber = 0;

function setup(path = ":memory:"): SspcService {
  const service = createService(path, now);
  services.push(service);
  return service;
}

function request(payload: ActionPayload): ActionInput {
  return { ...payload, requestId: `catalog-${++requestNumber}` };
}

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "sspc-catalog-"));
  temporaryDirectories.push(directory);
  return join(directory, "test.sqlite");
}

function createGift(service: SspcService, stock: Record<string, number> = { st001: 4 }): ActionResult {
  return service.execute(service.persona("admin"), request({ action: "createGift", name: { en: "Socket set", "zh-CN": "套筒组" }, category: "tools", image: "/gifts/toolkit.webp", points: 10, active: true, stock }));
}

function createStore(service: SspcService): ActionResult {
  return service.execute(service.persona("admin"), request({ action: "createStore", name: { en: "Tampines", "zh-CN": "淡滨尼" }, address: "12 Tampines Street, Singapore", status: "active" }));
}

async function competingActions(path: string, inputs: ActionInput[]): Promise<{ ok: boolean; error?: string; result?: ActionResult }[]> {
  const source = `const { parentPort, workerData } = require('node:worker_threads'); const { registerHooks } = require('node:module'); registerHooks({ resolve(specifier, context, nextResolve) { try { return nextResolve(specifier, context); } catch (error) { if (specifier.startsWith('.')) return nextResolve(specifier + '.ts', context); throw error; } } }); (async () => { const { createService } = await import(workerData.moduleUrl); const service = createService(workerData.path, () => new Date('2026-09-22T06:00:00.000Z')); parentPort.postMessage('ready'); parentPort.once('message', () => { try { const result = service.execute(service.persona('admin'), workerData.input); parentPort.postMessage({ok: true, result}); } catch (error) { parentPort.postMessage({ok: false, error: error.code ?? error.message}); } finally { service.close(); } }); })();`;
  const workers = inputs.map((input) => new Worker(source, { eval: true, execArgv: ["--experimental-transform-types"], workerData: { path, input, moduleUrl: pathToFileURL(resolve("src/server/service.ts")).href } }));
  try {
    await Promise.all(workers.map((worker) => once(worker, "message")));
    const completion = workers.map((worker) => new Promise<{ ok: boolean; error?: string; result?: ActionResult }>((resolveResult, reject) => {
      let result: { ok: boolean; error?: string; result?: ActionResult } | undefined;
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
    if (dirname(target) !== temporaryRoot || !basename(target).startsWith("sspc-catalog-")) throw new Error("INVALID_TEST_DIRECTORY");
    rmSync(target, { recursive: true });
  }
});

describe("catalog creation and updates", () => {
  it("creates complete stock grids and replays the original creation receipt", () => {
    const service = setup();
    const admin = service.persona("admin");
    const input = request({ action: "createGift", name: { en: " Socket set ", "zh-CN": " 套筒组 " }, category: "tools", image: "/gifts/toolkit.webp", points: 15, active: true, stock: { st001: 5 } });
    const first = service.execute(admin, input);
    expect(first.gift).toMatchObject({ id: first.referenceId, name: { en: "Socket set", "zh-CN": "套筒组" }, stock: { st001: 5, st002: 0, st003: 0 }, deleted: false });
    const update = service.execute(admin, request({ action: "updateGift", giftId: first.referenceId!, points: 20, active: false, stock: { st002: 8 }, name: { en: "Bottle", "zh-CN": "水瓶" }, category: "lifestyle", image: "/gifts/bottle.webp" }));
    expect(update.gift).toMatchObject({ name: { en: "Bottle", "zh-CN": "水瓶" }, category: "lifestyle", points: 20, active: false, stock: { st001: 5, st002: 8, st003: 0 } });
    expect(service.execute(admin, input)).toEqual(first);
    expect(() => service.execute(admin, { ...input, points: 16 })).toThrow("IDEMPOTENCY_CONFLICT");
    expect(service.database.prepare("SELECT COUNT(*) AS total FROM gifts").get()?.total).toBe(4);
    expect(service.database.prepare("SELECT COUNT(*) AS total FROM audit WHERE entity_id = ?").get(first.referenceId!)?.total).toBe(2);
    const legacyUpdate = service.execute(admin, request({ action: "updateGift", giftId: first.referenceId!, points: 12, active: true, stock: {} }));
    expect(legacyUpdate.gift).toMatchObject({ name: update.gift!.name, category: "lifestyle", image: "/gifts/bottle.webp", points: 12 });
  });

  it("creates a store without granting staff access and supports later assignment", () => {
    const service = setup();
    const admin = service.persona("admin");
    const input = request({ action: "createStore", name: { en: " Tampines ", "zh-CN": " 淡滨尼 " }, address: " 12 Tampines Street, Singapore ", status: "inactive" });
    const first = service.execute(admin, input);
    expect(first.store).toMatchObject({ id: first.referenceId, name: { en: "Tampines", "zh-CN": "淡滨尼" }, address: "12 Tampines Street, Singapore", status: "inactive", deleted: false });
    expect(service.persona("staff").storeIds).not.toContain(first.referenceId);
    expect(service.state(service.persona("staff")).stores.some((store) => store.id === first.referenceId)).toBe(false);
    expect(service.state(admin).gifts.every((gift) => gift.stock[first.referenceId!] === 0)).toBe(true);
    const purchase = request({ action: "purchase", memberId: "m001", storeId: first.referenceId!, amountCents: 3000, receipt: "NEW-STORE" });
    expect(() => service.execute(service.persona("staff"), purchase)).toThrow("FORBIDDEN");
    service.execute(admin, request({ action: "updateStaff", staffId: "s001", role: "supervisor", storeIds: ["st001", first.referenceId!], active: true }));
    expect(() => service.execute(service.persona("staff"), purchase)).toThrow("STORE_INACTIVE");
    const updated = service.execute(admin, request({ action: "updateStore", storeId: first.referenceId!, name: { en: "Tampines Central", "zh-CN": "淡滨尼中心" }, address: "24 Tampines Street, Singapore", status: "active" }));
    expect(updated.store).toMatchObject({ status: "active", address: "24 Tampines Street, Singapore" });
    expect(service.execute(service.persona("staff"), purchase).purchase?.storeId).toBe(first.referenceId);
    expect(service.execute(admin, input)).toEqual(first);
  });

  it("rejects invalid stock references without creating a partial gift or changing existing details", () => {
    const service = setup();
    const admin = service.persona("admin");
    const before = service.state(admin);
    expect(() => createGift(service, { missing: 1 })).toThrow("INVALID_INPUT");
    expect(() => service.execute(admin, request({ action: "updateGift", giftId: "g001", name: { en: "Incorrect", "zh-CN": "错误" }, points: 1, active: false, stock: { st001: 10, missing: 1 } }))).toThrow("INVALID_INPUT");
    const after = service.state(admin);
    expect(after.gifts).toEqual(before.gifts);
    expect(after.audit).toEqual(before.audit);
  });

  it.each([
    { image: "https://example.com/gift.webp" },
    { image: "/gifts/../private.webp" },
    { name: { en: " ", "zh-CN": "礼品" } },
    { name: { en: "Bad\u0000name", "zh-CN": "礼品" } },
    { name: { en: "x".repeat(101), "zh-CN": "礼品" } },
    { name: { en: "Gift" } },
    { category: "unknown" },
    { points: 0 },
    { stock: { st001: -1 } },
    { stock: { st001: 0.5 } },
  ])("rejects invalid gift data %#", (invalid) => {
    const service = setup();
    expect(() => service.execute(service.persona("admin"), { ...request({ action: "createGift", name: { en: "Gift", "zh-CN": "礼品" }, category: "care", image: "/gifts/care.webp", points: 10, active: true, stock: {} }), ...invalid })).toThrow("INVALID_INPUT");
  });

  it.each([{ address: " " }, { address: "x".repeat(241) }, { address: "Block\nStreet" }, { status: "deleted" }])("rejects invalid store data %#", (invalid) => {
    const service = setup();
    expect(() => service.execute(service.persona("admin"), { ...request({ action: "createStore", name: { en: "Store", "zh-CN": "门店" }, address: "12 Ubi Road", status: "active" }), ...invalid })).toThrow("INVALID_INPUT");
  });

  it.each(["staff", "member"] as const)("rejects every catalog mutation from %s", (role) => {
    const service = setup();
    const payloads: ActionPayload[] = [
      { action: "createGift", name: { en: "Gift", "zh-CN": "礼品" }, category: "tools", image: "/gifts/toolkit.webp", points: 10, active: true, stock: {} },
      { action: "updateGift", giftId: "g001", points: 10, active: true, stock: {} },
      { action: "deleteGift", giftId: "g001" },
      { action: "createStore", name: { en: "Store", "zh-CN": "门店" }, address: "12 Ubi Road", status: "active" },
      { action: "updateStore", storeId: "st001", name: { en: "Store", "zh-CN": "门店" }, address: "12 Ubi Road", status: "active" },
      { action: "deleteStore", storeId: "st001" },
    ];
    for (const payload of payloads) expect(() => service.execute(service.persona(role), request(payload))).toThrow("FORBIDDEN");
    expect(service.database.prepare("SELECT COUNT(*) AS total FROM idempotency").get()?.total).toBe(0);
  });
});

describe("catalog lifecycle and history", () => {
  it("blocks deleting reserved gifts and preserves completed redemption snapshots after renaming and deletion", () => {
    const service = setup();
    const admin = service.persona("admin");
    const created = createGift(service);
    const giftId = created.referenceId!;
    const redemption = service.execute(service.persona("staff"), request({ action: "redeem", memberId: "m001", storeId: "st001", giftId, quantity: 1 }));
    const deletion = request({ action: "deleteGift", giftId });
    expect(() => service.execute(admin, deletion)).toThrow("GIFT_IN_USE");
    expect(service.state(admin).gifts.find((gift) => gift.id === giftId)?.deleted).toBe(false);
    service.execute(admin, request({ action: "updateGift", giftId, name: { en: "Renamed", "zh-CN": "已改名" }, points: 15, active: false, stock: {} }));
    service.execute(service.persona("staff"), request({ action: "fulfill", redemptionId: redemption.referenceId! }));
    const deleted = service.execute(admin, deletion);
    expect(deleted.gift).toMatchObject({ id: giftId, active: false, deleted: true, stock: { st001: 3 } });
    expect(service.execute(admin, deletion)).toEqual(deleted);
    expect(() => service.execute(admin, request({ action: "updateGift", giftId, active: true, points: 10, stock: {} }))).toThrow("NOT_FOUND");
    expect(() => service.execute(service.persona("staff"), request({ action: "redeem", memberId: "m001", storeId: "st001", giftId, quantity: 1 }))).toThrow("GIFT_UNAVAILABLE");
    for (const role of ["admin", "staff", "member"] as const) {
      const state = service.state(service.persona(role), { section: "redemptions", memberId: "m001" });
      expect(state.gifts.find((gift) => gift.id === giftId)?.deleted).toBe(true);
      expect(state.redemptions.find((entry) => entry.id === redemption.referenceId)).toMatchObject({ status: "fulfilled", giftName: { en: "Socket set", "zh-CN": "套筒组" }, points: 10 });
    }
    expect(service.state(admin, { section: "gifts" }).pagination.total).toBe(3);
    expect(service.exportCsv(admin, { section: "redemptions", memberId: "m001" })).toContain("Socket set");
    const store = createStore(service).referenceId!;
    expect(service.database.prepare("SELECT * FROM gift_stock WHERE gift_id = ? AND store_id = ?").get(giftId, store)).toBeUndefined();
  });

  it("allows existing fulfillment and cancellation at inactive stores while blocking new transactions", () => {
    const service = setup();
    const admin = service.persona("admin");
    const storeId = createStore(service).referenceId!;
    const giftId = createGift(service, { [storeId]: 3 }).referenceId!;
    service.execute(admin, request({ action: "updateStaff", staffId: "s001", role: "supervisor", storeIds: [storeId], active: true }));
    const staff = service.persona("staff");
    const purchased = service.execute(staff, request({ action: "purchase", memberId: "m001", storeId, amountCents: 3000, receipt: "INACTIVE-REFUND" }));
    const first = service.execute(staff, request({ action: "redeem", memberId: "m001", storeId, giftId, quantity: 1 }));
    const second = service.execute(staff, request({ action: "redeem", memberId: "m001", storeId, giftId, quantity: 1 }));
    service.execute(admin, request({ action: "updateStore", storeId, name: { en: "Tampines", "zh-CN": "淡滨尼" }, address: "12 Tampines Street", status: "inactive" }));
    expect(() => service.execute(staff, request({ action: "purchase", memberId: "m001", storeId, amountCents: 3000, receipt: "BLOCKED" }))).toThrow("STORE_INACTIVE");
    expect(() => service.execute(staff, request({ action: "redeem", memberId: "m001", storeId, giftId, quantity: 1 }))).toThrow("STORE_INACTIVE");
    const deletion = request({ action: "deleteStore", storeId });
    expect(() => service.execute(admin, deletion)).toThrow("STORE_IN_USE");
    expect(service.execute(staff, request({ action: "fulfill", redemptionId: first.referenceId! })).redemption?.status).toBe("fulfilled");
    expect(service.execute(staff, request({ action: "cancel", redemptionId: second.referenceId! })).redemption?.status).toBe("cancelled");
    const deleted = service.execute(admin, deletion);
    expect(deleted.store).toMatchObject({ status: "inactive", deleted: true });
    expect(service.execute(admin, deletion)).toEqual(deleted);
    expect(service.execute(staff, request({ action: "refund", purchaseId: purchased.referenceId!, amountCents: 3000 })).purchase?.refundedCents).toBe(3000);
    expect(() => service.execute(service.persona("staff", "s002"), request({ action: "refund", purchaseId: purchased.referenceId!, amountCents: 1 }))).toThrow("FORBIDDEN");
    expect(service.persona("staff").storeIds).toContain(storeId);
    expect(service.state(staff, { storeId, section: "purchases" }).purchases[0].id).toBe(purchased.referenceId);
    expect(service.state(service.persona("member")).stores.find((store) => store.id === storeId)?.deleted).toBe(true);
    expect(service.exportCsv(admin, { storeId })).toContain("Tampines");
    expect(service.state(admin, { section: "stores" }).pagination.total).toBe(3);
    expect(() => service.execute(admin, request({ action: "updateStore", storeId, name: { en: "Reopen", "zh-CN": "恢复" }, address: "12 Tampines Street", status: "active" }))).toThrow("NOT_FOUND");
    expect(() => service.execute(admin, request({ action: "updateStaff", staffId: "s002", role: "cashier", storeIds: [storeId], active: true }))).toThrow("INVALID_INPUT");
    expect(() => service.execute(admin, request({ action: "updateGift", giftId, points: 10, active: true, stock: { [storeId]: 100 } }))).toThrow("INVALID_INPUT");
    expect(() => createGift(service, { [storeId]: 1 })).toThrow("INVALID_INPUT");
    const freshGift = createGift(service).gift!;
    expect(freshGift.stock[storeId]).toBeUndefined();
    expect(service.database.prepare("SELECT quantity FROM gift_stock WHERE gift_id = ? AND store_id = ?").get(giftId, storeId)?.quantity).toBe(2);
  });

  it("migrates pre-catalog databases without reseeding or dropping member and transaction records", () => {
    const path = temporaryDatabase();
    const legacy = new DatabaseSync(path);
    legacy.exec("CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const name of ["001-initial.sql", "002-member-auth.sql", "003-action-receipts.sql"]) {
      legacy.exec(readFileSync(join(process.cwd(), "db", "migrations", name), "utf8"));
      legacy.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)").run(name, now().toISOString());
    }
    seedDatabase(legacy, now());
    const before = legacy.prepare("SELECT COUNT(*) AS total FROM purchases").get()?.total;
    legacy.prepare("UPDATE members SET name = ? WHERE id = 'm001'").run("Preserved Member");
    legacy.close();
    const service = setup(path);
    const state = service.state(service.persona("member"));
    expect(state.selectedMember?.name).toBe("Preserved Member");
    expect(state.gifts.every((gift) => gift.deleted === false)).toBe(true);
    expect(state.stores.every((store) => store.deleted === false)).toBe(true);
    expect(service.database.prepare("SELECT COUNT(*) AS total FROM purchases").get()?.total).toBe(before);
    expect(service.database.prepare("SELECT COUNT(*) AS total FROM migrations WHERE name = '004-catalog-lifecycle.sql'").get()?.total).toBe(1);
    createGift(service);
    const reopened = setup(path);
    expect(reopened.state(reopened.persona("admin")).gifts).toHaveLength(4);
  });
});

describe("catalog concurrent transactions", () => {
  it("creates one gift for concurrent retries across separate database connections", async () => {
    const path = temporaryDatabase();
    const service = setup(path);
    const input = request({ action: "createGift", name: { en: "Concurrent gift", "zh-CN": "并发礼品" }, category: "care", image: "/gifts/care.webp", points: 10, active: true, stock: { st001: 1 } });
    const results = await competingActions(path, [input, input]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results[0].result).toEqual(results[1].result);
    expect(service.database.prepare("SELECT COUNT(*) AS total FROM gifts").get()?.total).toBe(4);
  });

  it.each(["gift", "store"] as const)("serializes %s deletion against reservation without orphaning a pending redemption", async (entity) => {
    const path = temporaryDatabase();
    const service = setup(path);
    const storeId = createStore(service).referenceId!;
    const giftId = createGift(service, { [storeId]: 1 }).referenceId!;
    const deletion = request(entity === "gift" ? { action: "deleteGift", giftId } : { action: "deleteStore", storeId });
    const redemption = request({ action: "redeem", memberId: "m001", storeId, giftId, quantity: 1 });
    const results = await competingActions(path, [deletion, redemption]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const state = service.state(service.persona("admin"), { storeId, section: "redemptions" });
    const deleted = entity === "gift" ? state.gifts.find((gift) => gift.id === giftId)!.deleted : state.stores.find((store) => store.id === storeId)!.deleted;
    if (results[0].ok) {
      expect(deleted).toBe(true);
      expect(results[1].error).toBe(entity === "gift" ? "GIFT_UNAVAILABLE" : "STORE_INACTIVE");
      expect(state.redemptions).toHaveLength(0);
      expect(service.state(service.persona("member")).selectedMember?.points).toBe(31);
    } else {
      expect(results[0].error).toBe(entity === "gift" ? "GIFT_IN_USE" : "STORE_IN_USE");
      expect(deleted).toBe(false);
      expect(state.redemptions).toHaveLength(1);
      expect(state.redemptions[0].status).toBe("confirmed");
    }
  });
});
