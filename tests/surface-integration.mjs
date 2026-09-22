import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const surfaces = [{ role: "member", port: 3100 }, { role: "staff", port: 3101 }, { role: "admin", port: 3102 }];
const cookies = new Map();
const children = [];
let temporaryDirectory;
let assertions = 0;

function equal(actual, expected) {
  assert.deepEqual(actual, expected);
  assertions++;
}

async function request(surface, path, options = {}) {
  const origin = `http://127.0.0.1:${surface.port}`;
  const response = await fetch(origin + path, {
    method: options.method ?? "GET",
    redirect: "manual",
    headers: {
      Origin: options.origin ?? origin,
      Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    const split = pair.indexOf("=");
    cookies.set(pair.slice(0, split), pair.slice(split + 1));
  }
  const body = await response.text();
  return { status: response.status, headers: response.headers, body: response.headers.get("Content-Type")?.includes("application/json") ? JSON.parse(body) : body };
}

async function portAvailable(port) {
  await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close(resolvePort));
  });
}

async function start(surface, databasePath) {
  const child = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(surface.port)], {
    cwd: process.cwd(),
    env: { ...process.env, APP_MODE: "demo", APP_SURFACE: surface.role, DATABASE_PATH: databasePath, NEXT_TELEMETRY_DISABLED: "1" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(child.pid);
  const owned = { child, pid: child.pid, port: surface.port, exited: once(child, "exit"), logs: "" };
  children.push(owned);
  child.stdout.on("data", (chunk) => { owned.logs = (owned.logs + chunk.toString()).slice(-4000); });
  child.stderr.on("data", (chunk) => { owned.logs = (owned.logs + chunk.toString()).slice(-4000); });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(owned.logs);
    try {
      const response = await request(surface, "/en/login");
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`SURFACE_START_FAILED: ${surface.role} ${owned.logs}`);
}

async function execute() {
  await Promise.all(surfaces.map((surface) => portAvailable(surface.port)));
  temporaryDirectory = mkdtempSync(join(tmpdir(), "sspc-surface-"));
  const databasePath = join(temporaryDirectory, "test.sqlite");
  await Promise.all(surfaces.map((surface) => start(surface, databasePath)));
  const [member, staff, admin] = surfaces;
  const post = (surface, path, body, options = {}) => request(surface, path, { ...options, method: "POST", body });
  const action = (payload, requestId = randomUUID()) => post(staff, "/api/actions?role=staff", { ...payload, requestId });
  const adminAction = (payload, requestId = randomUUID()) => post(admin, "/api/actions?role=admin", { ...payload, requestId });
  const memberAuth = (body) => post(member, "/api/auth/member", body);

  for (const surface of surfaces) {
    const home = await request(surface, "/en");
    equal(home.status, 307);
    equal(home.headers.get("location"), "/en/login");
    equal((await request(surface, "/en/login")).status, 200);
    for (const role of ["member", "staff", "admin"]) {
      if (surface.role !== role) equal((await request(surface, `/en/${role}`)).status, 404);
    }
  }
  equal((await post(member, "/api/session", { role: "member" })).status, 403);
  equal((await post(member, "/api/session", { role: "staff" })).status, 403);
  equal((await post(staff, "/api/session", { role: "staff" }, { origin: `http://127.0.0.1:${member.port}` })).status, 403);
  equal((await post(staff, "/api/session", { role: "staff" })).status, 200);
  equal((await post(admin, "/api/session", { role: "admin" })).status, 200);
  equal((await post(staff, "/api/auth/member", { action: "request", phone: "80001001" })).status, 403);
  equal((await post(admin, "/api/auth/member", { action: "request", phone: "80001001" })).status, 403);

  const seeded = await memberAuth({ action: "request", phone: "+65 8000 1001" });
  equal(seeded.status, 200);
  equal((await memberAuth({ action: "verify", challengeId: seeded.body.challengeId, code: seeded.body.demoCode })).body, { status: "authenticated" });
  equal((await request(member, "/api/state?role=member")).body.selectedMember.id, "m001");
  equal((await memberAuth({ action: "verify", challengeId: seeded.body.challengeId, code: seeded.body.demoCode })).body.error, "OTP_CHALLENGE_INVALID");

  for (const surface of surfaces) {
    for (const role of ["member", "staff", "admin"]) {
      equal((await request(surface, `/api/state?role=${role}`)).status, surface.role === role ? 200 : 403);
      if (surface.role !== role) {
        equal((await post(surface, `/api/actions?role=${role}`, { action: "purchase", requestId: randomUUID(), memberId: "m001", storeId: "st001", amountCents: 3000, receipt: randomUUID() })).status, 403);
        equal((await request(surface, `/api/export?role=${role}`)).status, 403);
      }
    }
  }
  equal((await request(member, "/api/export?role=member")).status, 403);
  equal((await request(staff, "/api/export?role=staff")).status, 403);
  equal((await request(admin, "/api/export?role=admin")).status, 200);
  equal((await post(member, "/api/actions?role=member", { action: "purchase", requestId: randomUUID(), memberId: "m001", storeId: "st001", amountCents: 3000, receipt: randomUUID() })).status, 403);

  const requested = await memberAuth({ action: "request", phone: "81234567" });
  equal(requested.status, 200);
  equal((await memberAuth({ action: "request", phone: "+6581234567" })).status, 429);
  equal((await memberAuth({ action: "verify", challengeId: requested.body.challengeId, code: "000000" })).body.error, "OTP_INVALID");
  const verified = await memberAuth({ action: "verify", challengeId: requested.body.challengeId, code: requested.body.demoCode });
  equal(verified.body.status, "registration");
  equal((await memberAuth({ action: "register", registrationToken: verified.body.registrationToken, name: "Taylor Wu" })).body, { status: "authenticated" });
  equal((await memberAuth({ action: "register", registrationToken: verified.body.registrationToken, name: "Taylor Wu" })).body.error, "REGISTRATION_INVALID");
  const newState = (await request(member, "/api/state?role=member")).body;
  const memberId = newState.selectedMember.id;
  equal(newState.selectedMember.points, 0);
  equal(newState.selectedMember.tier, "bronze");
  equal(newState.activity.length, 0);
  const search = await request(staff, `/api/state?role=staff&storeId=st002&memberId=${memberId}&search=${encodeURIComponent("+65 8123 4567")}`);
  equal(search.body.selectedMember.id, memberId);
  equal(search.body.members.some((entry) => entry.id === memberId), true);

  const firstRequest = randomUUID();
  const firstPayload = { action: "purchase", memberId, storeId: "st001", amountCents: 3000, receipt: `SSPC-${randomUUID()}` };
  const first = await action(firstPayload, firstRequest);
  equal(first.status, 200);
  equal(first.body.purchase.receipt, firstPayload.receipt);
  equal(first.body.referenceId, first.body.purchase.id);
  equal(first.body.member.points, 1);
  equal((await action(firstPayload, firstRequest)).body, first.body);
  for (let index = 0; index < 9; index++) equal((await action({ action: "purchase", memberId, storeId: index % 2 ? "st001" : "st002", amountCents: 6000, receipt: `SSPC-${randomUUID()}` })).status, 200);
  equal((await request(member, "/api/state?role=member")).body.selectedMember.points, 10);
  equal((await request(member, "/api/state?role=member")).body.selectedMember.visits, 1);
  equal((await action(firstPayload, firstRequest)).body, first.body);
  const redemption = await action({ action: "redeem", memberId, storeId: "st001", giftId: "g001", quantity: 1 });
  equal(redemption.status, 200);
  equal(redemption.body.redemption.status, "confirmed");
  equal(redemption.body.member.points, 0);
  const pending = await request(staff, `/api/state?role=staff&section=redemptions&redemptionStatus=confirmed&memberId=${memberId}`);
  equal(pending.body.pagination.total, 1);
  equal(pending.body.redemptions[0].id, redemption.body.referenceId);
  equal((await action({ action: "fulfill", redemptionId: redemption.body.referenceId })).body.redemption.status, "fulfilled");
  equal((await action({ action: "cancel", redemptionId: redemption.body.referenceId })).body.error, "INVALID_REDEMPTION_STATE");
  const csv = await request(admin, `/api/export?role=admin&section=purchases&memberId=${memberId}&search=${encodeURIComponent(firstPayload.receipt)}`);
  equal(csv.status, 200);
  equal(csv.body.trim().split("\r\n").length, 2);
  const storePayload = { action: "createStore", name: { en: "Tampines Test", "zh-CN": "淡滨尼测试" }, address: "12 Tampines Street, Singapore", status: "active" };
  equal((await action(storePayload)).status, 403);
  const storeRequest = randomUUID();
  const storeCreated = await adminAction(storePayload, storeRequest);
  equal(storeCreated.status, 200);
  const storeId = storeCreated.body.referenceId;
  equal(storeCreated.body.store.id, storeId);
  equal(storeCreated.body.store.deleted, false);
  equal((await adminAction(storePayload, storeRequest)).body, storeCreated.body);
  const initialStaff = await request(staff, "/api/state?role=staff");
  equal(initialStaff.body.session.storeIds.includes(storeId), false);
  equal((await request(admin, "/api/state?role=admin")).body.gifts.every((gift) => gift.stock[storeId] === 0), true);
  const giftPayload = { action: "createGift", name: { en: "Integration Toolkit", "zh-CN": "测试工具套装" }, category: "tools", image: "/gifts/toolkit.webp", points: 1, active: true, stock: { [storeId]: 2 } };
  equal((await adminAction({ ...giftPayload, image: "https://example.com/gift.png" })).body.error, "INVALID_INPUT");
  equal((await action(giftPayload)).status, 403);
  const giftRequest = randomUUID();
  const giftCreated = await adminAction(giftPayload, giftRequest);
  equal(giftCreated.status, 200);
  const giftId = giftCreated.body.referenceId;
  equal(giftCreated.body.gift.stock[storeId], 2);
  equal((await adminAction(giftPayload, giftRequest)).body, giftCreated.body);
  const newPurchasePayload = { action: "purchase", memberId, storeId, amountCents: 3000, receipt: `CATALOG-${randomUUID()}` };
  equal((await action(newPurchasePayload)).body.error, "FORBIDDEN");
  equal((await adminAction({ action: "updateStaff", staffId: "s001", role: "supervisor", active: true, storeIds: ["st001", "st002", storeId] })).status, 200);
  const catalogPurchase = await action(newPurchasePayload);
  equal(catalogPurchase.status, 200);
  const catalogRedemption = await action({ action: "redeem", memberId, storeId, giftId, quantity: 1 });
  equal(catalogRedemption.status, 200);
  const giftDeletionRequest = randomUUID();
  const storeDeletionRequest = randomUUID();
  const blockedGift = await adminAction({ action: "deleteGift", giftId }, giftDeletionRequest);
  equal(blockedGift.status, 409);
  equal(blockedGift.body.error, "GIFT_IN_USE");
  const blockedStore = await adminAction({ action: "deleteStore", storeId }, storeDeletionRequest);
  equal(blockedStore.status, 409);
  equal(blockedStore.body.error, "STORE_IN_USE");
  equal((await adminAction({ action: "updateGift", giftId, name: { en: "Updated Toolkit", "zh-CN": "新工具套装" }, category: "care", image: "/gifts/care.webp", points: 2, active: false, stock: {} })).status, 200);
  equal((await adminAction({ action: "updateStore", storeId, name: storePayload.name, address: storePayload.address, status: "inactive" })).status, 200);
  equal((await action({ ...newPurchasePayload, receipt: randomUUID() })).body.error, "STORE_INACTIVE");
  const catalogFulfilled = await action({ action: "fulfill", redemptionId: catalogRedemption.body.referenceId });
  equal(catalogFulfilled.status, 200);
  equal(catalogFulfilled.body.redemption.giftName.en, "Integration Toolkit");
  equal(catalogFulfilled.body.redemption.points, 1);
  const giftDeleted = await adminAction({ action: "deleteGift", giftId }, giftDeletionRequest);
  equal(giftDeleted.status, 200);
  equal(giftDeleted.body.gift.deleted, true);
  equal((await adminAction({ action: "deleteGift", giftId }, giftDeletionRequest)).body, giftDeleted.body);
  const storeDeleted = await adminAction({ action: "deleteStore", storeId }, storeDeletionRequest);
  equal(storeDeleted.status, 200);
  equal(storeDeleted.body.store.deleted, true);
  equal((await adminAction({ action: "deleteStore", storeId }, storeDeletionRequest)).body, storeDeleted.body);
  equal((await adminAction({ action: "updateGift", giftId, points: 1, active: true, stock: {} })).body.error, "NOT_FOUND");
  equal((await adminAction({ action: "updateStore", storeId, name: storePayload.name, address: storePayload.address, status: "active" })).body.error, "NOT_FOUND");
  const catalogMemberState = await request(member, "/api/state?role=member&section=redemptions");
  equal(catalogMemberState.body.stores.find((store) => store.id === storeId).deleted, true);
  equal(catalogMemberState.body.gifts.find((gift) => gift.id === giftId).deleted, true);
  equal(catalogMemberState.body.redemptions.find((entry) => entry.id === catalogRedemption.body.referenceId).status, "fulfilled");
  equal((await action({ action: "refund", purchaseId: catalogPurchase.body.referenceId, amountCents: 3000 })).body.purchase.refundedCents, 3000);
  const historicalCsv = await request(admin, `/api/export?role=admin&section=redemptions&storeId=${storeId}`);
  equal(historicalCsv.status, 200);
  equal(historicalCsv.body.includes("Integration Toolkit"), true);
  equal(historicalCsv.body.includes("Tampines Test"), true);
  equal((await post(admin, "/api/actions?role=admin", { action: "updateMember", requestId: randomUUID(), memberId, status: "suspended" })).status, 200);
  equal((await request(member, "/api/state?role=member")).status, 401);
  equal((await post(admin, "/api/actions?role=admin", { action: "updateMember", requestId: randomUUID(), memberId, status: "active" })).status, 200);
  equal((await request(member, "/api/state?role=member")).status, 401);
  console.log(JSON.stringify({ status: "passed", assertions, surfaces: surfaces.map((surface) => surface.role), database: "isolated" }));
}

try {
  await execute();
} catch (error) {
  console.error(JSON.stringify({ surfaces: children.map((owned) => ({ port: owned.port, logs: owned.logs })) }));
  throw error;
} finally {
  for (const owned of children) {
    assert.equal(owned.child.pid, owned.pid);
    if (owned.child.exitCode === null && owned.child.signalCode === null) owned.child.kill("SIGTERM");
  }
  await Promise.all(children.map((owned) => owned.exited));
  await Promise.all(children.map((owned) => portAvailable(owned.port)));
  if (temporaryDirectory) {
    const target = realpathSync(temporaryDirectory);
    if (dirname(target) !== realpathSync(tmpdir()) || !basename(target).startsWith("sspc-surface-")) throw new Error("INVALID_TEST_DIRECTORY");
    rmSync(target, { recursive: true });
  }
  console.log(JSON.stringify({ stoppedOwnedPids: children.map((owned) => owned.pid), portsReleased: children.map((owned) => owned.port), temporaryDatabaseRemoved: Boolean(temporaryDirectory) }));
}
