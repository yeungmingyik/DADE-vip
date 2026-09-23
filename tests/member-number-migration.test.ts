import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ActionInput, ActionResult, AppData } from "../src/lib/types";
import { createService, type SspcService } from "../src/server/service";
import { createDemoState, demoPersona, demoRequest, executeDemoAction, readSessionRole, type DemoState } from "../src/demo/service";
import { establishDemoSession } from "../src/demo/domain";
import { migrateDemoState } from "../src/demo/migrations";
import { DEMO_STORAGE_KEY } from "../src/demo/storage";
import { memberNumberChanges, nextMemberNumber } from "../src/modules/member-numbers";
import { createDemoCashierInput, parseMemberScan } from "../src/integrations/demo";

const instant = new Date("2026-09-22T06:00:00.000Z");
const services = new Set<SspcService>();
const directories: string[] = [];
const purchase: ActionInput = { action: "purchase", requestId: "migration-purchase", memberId: "m001", storeId: "st001", amountCents: 3000, receipt: "SSPC customer receipt" };

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "dade-member-numbers-"));
  directories.push(directory);
  return join(directory, "test.sqlite");
}

function open(path: string): SspcService {
  const service = createService(path, () => instant);
  services.add(service);
  return service;
}

function close(service: SspcService): void {
  services.delete(service);
  service.close();
}

function databaseSnapshot(database: DatabaseSync): Record<string, unknown[]> {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]));
}

function legacyDatabase(path: string): { service: SspcService; result: ActionResult; token: string } {
  const service = open(path);
  service.database.exec("UPDATE members SET number = 'SSPC ' || substr(number, 6); DELETE FROM migrations WHERE name = '005-member-numbers.ts';");
  service.database.prepare("UPDATE members SET code = ?, name = ? WHERE id = 'm001'").run("sspc_0123456789abcdef", "SSPC customer name");
  const result = service.execute(service.persona("staff"), purchase);
  const token = service.createSession("member", "m001").token;
  return { service, result, token };
}

function browserStorage(state: DemoState) {
  const entries = new Map([[DEMO_STORAGE_KEY, JSON.stringify(state)]]);
  let queue = Promise.resolve();
  const setItem = vi.fn((key: string, value: string) => entries.set(key, value));
  const lock = vi.fn((_name: string, _options: unknown, operation: () => unknown) => {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  });
  vi.stubGlobal("window", { localStorage: { getItem: (key: string) => entries.get(key) ?? null, setItem } });
  vi.stubGlobal("navigator", { locks: { request: lock } });
  return { entries, setItem, lock, current: () => JSON.parse(entries.get(DEMO_STORAGE_KEY)!) as DemoState };
}

afterEach(() => {
  for (const service of services) service.close();
  services.clear();
  for (const directory of directories.splice(0)) {
    const target = realpathSync(directory);
    if (dirname(target) !== realpathSync(tmpdir()) || !basename(target).startsWith("dade-member-numbers-")) throw new Error("INVALID_TEST_DIRECTORY");
    rmSync(target, { recursive: true });
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("member number compatibility migration", () => {
  it("migrates SQLite numbers and cached receipts once without changing member identity, sessions or transactions", () => {
    const path = temporaryDatabase();
    const legacy = legacyDatabase(path);
    const before = databaseSnapshot(legacy.service.database);
    close(legacy.service);
    const migrated = open(path);
    const after = databaseSnapshot(migrated.database);
    const expectedMembers = (before.members as { number: string }[]).map((member) => ({ ...member, number: member.number.replace(/^SSPC ([0-9]+)$/, "DADE $1") }));
    expect(after.members).toEqual(expectedMembers);
    for (const [table, rows] of Object.entries(before)) if (!["members", "migrations", "idempotency"].includes(table)) expect(after[table], table).toEqual(rows);
    expect(after.migrations).toHaveLength(before.migrations.length + 1);
    expect(after.idempotency).toEqual((before.idempotency as { result_json: string }[]).map((entry) => ({ ...entry, result_json: JSON.stringify({ ...legacy.result, member: { ...legacy.result.member, number: "DADE 10001" } }) })));
    const replay = migrated.execute(migrated.persona("staff"), purchase);
    expect(replay).toEqual({ ...legacy.result, member: { ...legacy.result.member, number: "DADE 10001" } });
    expect(migrated.sessionForToken("member", legacy.token)?.memberId).toBe("m001");
    expect(migrated.state(migrated.persona("staff"), { search: "DADE 10001" }).members.map((member) => member.id)).toEqual(["m001"]);
    expect(migrated.state(migrated.persona("staff"), { search: parseMemberScan({ code: "sspc_0123456789abcdef" }) }).members.map((member) => member.id)).toEqual(["m001"]);
    const admin = migrated.persona("admin");
    expect(migrated.exportCsv(admin, { search: "DADE 10001" })).toEqual(migrated.exportCsv(admin, { memberId: "m001" }));
    close(migrated);
    const reopened = open(path);
    expect(databaseSnapshot(reopened.database)).toEqual(after);
  });

  it("resolves SQLite collisions without merging accounts or rewriting arbitrary text", () => {
    const path = temporaryDatabase();
    const legacy = legacyDatabase(path);
    legacy.service.database.prepare("UPDATE members SET number = ? WHERE id = ?").run("DADE 10001", "m002");
    legacy.service.database.prepare("UPDATE members SET number = ? WHERE id = ?").run("SSPC customer 10003", "m003");
    legacy.service.database.prepare("UPDATE members SET number = ? WHERE id = ?").run("SSPC 10004 extra", "m004");
    close(legacy.service);
    const migrated = open(path);
    const rows = migrated.database.prepare("SELECT id, number, name FROM members ORDER BY id LIMIT 4").all();
    expect(rows).toMatchObject([
      { id: "m001", number: "DADE 10025", name: "SSPC customer name" },
      { id: "m002", number: "DADE 10001" },
      { id: "m003", number: "SSPC customer 10003" },
      { id: "m004", number: "SSPC 10004 extra" },
    ]);
    expect(migrated.database.prepare("SELECT COUNT(*) AS total, COUNT(DISTINCT number) AS unique_numbers FROM members").get()).toMatchObject({ total: 24, unique_numbers: 24 });
    expect(migrated.execute(migrated.persona("staff"), purchase).member?.number).toBe("DADE 10025");
  });

  it("rolls back the whole SQLite migration on a write failure and can safely retry", () => {
    const path = temporaryDatabase();
    const legacy = legacyDatabase(path);
    legacy.service.database.exec("CREATE TRIGGER deny_number_update BEFORE UPDATE OF number ON members WHEN OLD.id = 'm002' BEGIN SELECT RAISE(ABORT, 'MIGRATION_WRITE_BLOCKED'); END;");
    const before = databaseSnapshot(legacy.service.database);
    close(legacy.service);
    expect(() => open(path)).toThrow("MIGRATION_WRITE_BLOCKED");
    const inspection = new DatabaseSync(path);
    try {
      expect(databaseSnapshot(inspection)).toEqual(before);
      inspection.exec("DROP TRIGGER deny_number_update;");
    } finally { inspection.close(); }
    const retried = open(path);
    expect(retried.state(retried.persona("member")).selectedMember?.number).toBe("DADE 10001");
  });

  it("persists existing browser data migration under the original lock and keeps sessions and idempotent receipts", async () => {
    let state = createDemoState(new Date());
    for (const member of state.members) member.number = member.number.replace(/^DADE /, "SSPC ");
    state.members[0].name = "SSPC customer name";
    for (const [role, id] of [["member", "m001"], ["staff", "s001"], ["admin", "a001"]] as const) establishDemoSession(state, role, id, new Date());
    const purchased = executeDemoAction(state, demoPersona(state, "staff"), purchase, new Date());
    state = purchased.state;
    const before = structuredClone(state);
    const storage = browserStorage(state);
    const queries = await Promise.all([demoRequest("/api/state?role=member"), demoRequest("/api/state?role=staff&search=DADE%2010001")]);
    const member = (await queries[0].json() as AppData).selectedMember!;
    expect(member.number).toBe("DADE 10001");
    expect((await queries[1].json() as AppData).members.map((entry) => entry.id)).toEqual(["m001"]);
    const migrated = storage.current();
    expect(migrated).toEqual({
      ...before,
      revision: before.revision + 1,
      members: before.members.map((entry) => ({ ...entry, number: entry.number.replace(/^SSPC /, "DADE ") })),
      idempotency: { ...before.idempotency, "s001:migration-purchase": { ...before.idempotency["s001:migration-purchase"], result: { ...purchased.result, member: { ...purchased.result.member, number: "DADE 10001" } } } },
    });
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.lock).toHaveBeenCalledWith(DEMO_STORAGE_KEY, { mode: "exclusive" }, expect.any(Function));
    expect(readSessionRole("member")?.memberId).toBe("m001");
    const replay = await demoRequest("/api/actions?role=staff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(purchase) });
    expect(await replay.json()).toEqual({ ...purchased.result, member: { ...purchased.result.member, number: "DADE 10001" } });
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    const scan = await demoRequest(`/api/state?role=staff&search=${encodeURIComponent(parseMemberScan({ code: member.code }))}`);
    expect((await scan.json() as AppData).members.map((entry) => entry.id)).toEqual(["m001"]);
    const byNumber = await demoRequest("/api/export?role=admin&search=DADE%2010001");
    const byId = await demoRequest("/api/export?role=admin&memberId=m001");
    expect(await byNumber.text()).toEqual(await byId.text());
  });

  it("retains an existing DADE browser number and never writes an incomplete migration", async () => {
    const state = createDemoState(new Date());
    state.members[0].number = "SSPC 10001";
    state.members[1].number = "DADE 10001";
    state.members[2].number = "SSPC notes";
    const migrated = migrateDemoState(state);
    expect(migrated.members.slice(0, 3).map((member) => member.number)).toEqual(["DADE 10025", "DADE 10001", "SSPC notes"]);
    expect(migrateDemoState(migrated)).toBe(migrated);
    expect(state.members[0].number).toBe("SSPC 10001");
    const storage = browserStorage(state);
    storage.setItem.mockImplementation(() => { throw new Error("QUOTA_EXCEEDED"); });
    const response = await demoRequest("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "staff" }) });
    expect(response.status).toBe(500);
    expect(storage.current()).toEqual(state);
  });

  it("migrates new legacy members written by an older browser tab after the first upgrade", async () => {
    const state = createDemoState(new Date());
    state.members[0].number = "SSPC 10001";
    establishDemoSession(state, "staff", "s001", new Date());
    const storage = browserStorage(state);
    expect((await demoRequest("/api/state?role=staff")).status).toBe(200);
    const upgraded = storage.current();
    const oldClientMember = { ...upgraded.members[0], id: "m-old-client", number: "SSPC 10025", code: "sspc_oldclient0123456789", phone: "+6587654321", points: 0 };
    upgraded.members.push(oldClientMember);
    upgraded.revision += 1;
    storage.entries.set(DEMO_STORAGE_KEY, JSON.stringify(upgraded));
    const result = await demoRequest("/api/state?role=staff&search=DADE%2010025");
    expect((await result.json() as AppData).members.map((member) => ({ id: member.id, number: member.number, code: member.code }))).toEqual([{ id: oldClientMember.id, number: "DADE 10025", code: oldClientMember.code }]);
    const migrated = storage.current();
    expect(migrated.members).toHaveLength(25);
    expect(migrated.purchases).toEqual(upgraded.purchases);
    expect(migrated.redemptions).toEqual(upgraded.redemptions);
    expect(migrated.sessions).toEqual(upgraded.sessions);
    expect(migrated.revision).toBe(upgraded.revision + 1);
    expect(storage.setItem).toHaveBeenCalledTimes(2);
  });

  it("allocates precise sequential numbers and accepts legacy or new QR tokens", () => {
    expect(nextMemberNumber(["SSPC arbitrary text", "DADE 10024", "SSPC 10025"])).toBe("DADE 10026");
    expect(nextMemberNumber(["DADE 9007199254740993"])).toBe("DADE 9007199254740994");
    expect(memberNumberChanges([{ id: "a", number: "SSPC 10001 " }, { id: "b", number: "sspc 10002" }, { id: "c", number: "SSPC\n10003" }]).size).toBe(0);
    expect(parseMemberScan({ code: " dade_0123456789abcdef " })).toBe("dade_0123456789abcdef");
    expect(parseMemberScan({ code: "sspc_0123456789abcdef" })).toBe("sspc_0123456789abcdef");
    expect(() => parseMemberScan({ code: "other_0123456789abcdef" })).toThrow("INVALID_MEMBER_CODE");
    vi.stubEnv("APP_MODE", "demo");
    expect(createDemoCashierInput(3000)).toEqual({ amountCents: 3000, receipt: expect.stringMatching(/^DADE-[a-f0-9-]{36}$/) });
  });
});
