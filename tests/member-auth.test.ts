import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { DemoOtpDelivery } from "../src/integrations/member-otp";
import { MemberAuthService, memberAuthSchema, normalizePhone } from "../src/server/member-auth";
import { createService, type SspcService } from "../src/server/service";
import { appSurface } from "../src/server/surface";
import { requestRole } from "../src/server/request";
import { POST as sessionPost } from "../src/app/api/session/route";
import { POST as memberAuthPost } from "../src/app/api/auth/member/route";
import { DomainError, isDomainError } from "../src/server/errors";
import { errorResponse } from "../src/server/http";

const services: SspcService[] = [];
const directories: string[] = [];
const originalSurface = process.env.APP_SURFACE;

function setup(path = ":memory:", clock = () => new Date("2026-09-22T06:00:00.000Z")) {
  const service = createService(path, clock);
  services.push(service);
  return { service, auth: new MemberAuthService(service, new DemoOtpDelivery()) };
}

function filePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "sspc-auth-"));
  directories.push(directory);
  return join(directory, "test.sqlite");
}

afterEach(() => {
  for (const service of services.splice(0)) service.close();
  const root = realpathSync(tmpdir());
  for (const directory of directories.splice(0)) {
    const target = realpathSync(directory);
    if (dirname(target) !== root || !basename(target).startsWith("sspc-auth-")) throw new Error("INVALID_TEST_DIRECTORY");
    rmSync(target, { recursive: true });
  }
  if (originalSurface === undefined) delete process.env.APP_SURFACE;
  else process.env.APP_SURFACE = originalSurface;
});

describe("member OTP authentication", () => {
  it.each(["80001001", "+65 8000 1001", "65 8000-1001", "+65 (8000) 1001"])("normalizes %s to one account", (phone) => {
    expect(normalizePhone(phone)).toBe("+6580001001");
  });

  it.each(["+86 13800001001", "70001001", "8000100", "+65800010011", "80001abc"])("rejects %s", (phone) => {
    expect(() => normalizePhone(phone)).toThrow("INVALID_PHONE");
  });

  it("authenticates a seeded member without changing loyalty records", async () => {
    const { service, auth } = setup();
    const challenge = await auth.requestCode("+65 8000 1001");
    expect(challenge.maskedPhone).toBe("+65 •••• 1001");
    expect(challenge.demoCode).toMatch(/^\d{6}$/);
    const result = auth.verifyCode(challenge.challengeId, challenge.demoCode!);
    expect(result.status).toBe("authenticated");
    if (result.status !== "authenticated") throw new Error("AUTHENTICATION_REQUIRED");
    expect(service.sessionForToken("member", result.authentication.token)?.memberId).toBe("m001");
    expect(service.state(result.authentication.session).selectedMember?.points).toBe(31);
    expect(() => auth.verifyCode(challenge.challengeId, challenge.demoCode!)).toThrow("OTP_CHALLENGE_INVALID");
  });

  it("creates no account until a verified registration is submitted", async () => {
    const { service, auth } = setup();
    const challenge = await auth.requestCode("81234567");
    const verification = auth.verifyCode(challenge.challengeId, challenge.demoCode!);
    expect(verification.status).toBe("registration");
    if (verification.status !== "registration") throw new Error("REGISTRATION_REQUIRED");
    expect(service.database.prepare("SELECT id FROM members WHERE phone = ?").get("+6581234567")).toBeUndefined();
    const result = auth.register(verification.registrationToken, "  New Member  ");
    const member = service.state(result.authentication.session).selectedMember!;
    expect(member).toMatchObject({ number: "DADE 10025", name: "New Member", phone: "+6581234567", points: 0, visits: 0, tier: "bronze", monthlyRedeemed: 0 });
    expect(member.code).toMatch(/^dade_[a-f0-9]{32}$/);
    expect(service.state(service.persona("staff"), { search: member.number }).members.map((entry) => entry.id)).toEqual([member.id]);
    expect(() => auth.register(verification.registrationToken, "Renamed")).toThrow("REGISTRATION_INVALID");
    expect(service.state(service.persona("staff", "s002"), { storeId: "st002", memberId: member.id, search: "+65 8123 4567" }).members.map((item) => item.id)).toContain(member.id);
    expect(service.state(service.persona("staff", "s003"), { storeId: "st003", memberId: member.id }).selectedMember?.id).toBe(member.id);
  });

  it("persists wrong-code attempts and locks the fifth failure", async () => {
    const { auth } = setup();
    const challenge = await auth.requestCode("80001001");
    for (let attempt = 1; attempt < 5; attempt++) expect(() => auth.verifyCode(challenge.challengeId, "000000")).toThrow("OTP_INVALID");
    expect(() => auth.verifyCode(challenge.challengeId, "000000")).toThrow("OTP_LOCKED");
    expect(() => auth.verifyCode(challenge.challengeId, challenge.demoCode!)).toThrow("OTP_LOCKED");
  });

  it("enforces expiration, resend cooldown and old-challenge invalidation", async () => {
    let now = new Date("2026-09-22T06:00:00.000Z");
    const { auth } = setup(":memory:", () => now);
    const first = await auth.requestCode("80001001");
    await expect(auth.requestCode("+65 8000 1001")).rejects.toThrow("OTP_RATE_LIMITED");
    now = new Date(now.getTime() + 60000);
    const second = await auth.requestCode("80001001");
    expect(() => auth.verifyCode(first.challengeId, first.demoCode!)).toThrow("OTP_CHALLENGE_INVALID");
    now = new Date(now.getTime() + 300000);
    expect(() => auth.verifyCode(second.challengeId, second.demoCode!)).toThrow("OTP_EXPIRED");
  });

  it("caps requests in a rolling hour and allows requests when the window expires", async () => {
    let now = new Date("2026-09-22T06:00:00.000Z");
    const { auth } = setup(":memory:", () => now);
    for (let index = 0; index < 5; index++) {
      await auth.requestCode("81234567");
      now = new Date(now.getTime() + 60000);
    }
    await expect(auth.requestCode("81234567")).rejects.toThrow("OTP_RATE_LIMITED");
    now = new Date("2026-09-22T07:00:00.000Z");
    expect((await auth.requestCode("81234567")).challengeId).toBeTruthy();
  });

  it("expires registration tokens and rejects invalid names without consuming a valid token", async () => {
    let now = new Date("2026-09-22T06:00:00.000Z");
    const { auth } = setup(":memory:", () => now);
    const challenge = await auth.requestCode("81234567");
    const verified = auth.verifyCode(challenge.challengeId, challenge.demoCode!);
    if (verified.status !== "registration") throw new Error("REGISTRATION_REQUIRED");
    expect(() => auth.register(verified.registrationToken, " ")).toThrow("INVALID_INPUT");
    expect(() => auth.register(verified.registrationToken, "x".repeat(81))).toThrow("INVALID_INPUT");
    expect(memberAuthSchema.safeParse({ action: "register", registrationToken: verified.registrationToken, name: "A\nB" }).success).toBe(false);
    now = new Date(now.getTime() + 600000);
    expect(() => auth.register(verified.registrationToken, "New Member")).toThrow("REGISTRATION_EXPIRED");
  });

  it("rejects suspended members and invalidates their previously issued sessions", async () => {
    const { service, auth } = setup();
    const existing = service.createSession("member", "m001");
    service.execute(service.persona("admin"), { action: "updateMember", requestId: randomUUID(), memberId: "m001", status: "suspended" });
    expect(service.sessionForToken("member", existing.token)).toBeNull();
    const challenge = await auth.requestCode("80001001");
    expect(() => auth.verifyCode(challenge.challengeId, challenge.demoCode!)).toThrow("MEMBER_SUSPENDED");
    expect(() => auth.verifyCode(challenge.challengeId, challenge.demoCode!)).toThrow("OTP_CHALLENGE_INVALID");
    service.execute(service.persona("admin"), { action: "updateMember", requestId: randomUUID(), memberId: "m001", status: "active" });
    expect(service.sessionForToken("member", existing.token)).toBeNull();
  });

  it("invalidates a challenge when delivery fails without sending external messages", async () => {
    const { service } = setup();
    const auth = new MemberAuthService(service, { send: async () => { throw new Error("DELIVERY_FAILED"); } });
    await expect(auth.requestCode("81234567")).rejects.toThrow("OTP_DELIVERY_FAILED");
    const row = service.database.prepare("SELECT consumed_at, delivered FROM member_otp_challenges").get() as { consumed_at: string; delivered: number };
    expect(row.consumed_at).toBeTruthy();
    expect(row.delivered).toBe(0);
  });

  it("migrates old phone formatting, preserves balances and revokes old member personas", async () => {
    const path = filePath();
    const database = new DatabaseSync(path);
    database.exec(readFileSync(resolve("db/migrations/001-initial.sql"), "utf8"));
    database.exec("CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    database.prepare("INSERT INTO migrations VALUES (?, ?)").run("001-initial.sql", "2026-09-01T00:00:00.000Z");
    database.prepare("INSERT INTO members VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("m001", "SSPC 10001", "sspc_0123456789abcdef", "Legacy Member", "+65 8000 1001", "2026-09-01T00:00:00.000Z", "active", 17);
    database.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(createHash("sha256").update("old-session").digest("hex"), "member", "m001", "2026-10-01T00:00:00.000Z");
    database.close();
    const { service, auth } = setup(path);
    expect(service.sessionForToken("member", "old-session")).toBeNull();
    const challenge = await auth.requestCode("80001001");
    expect(auth.verifyCode(challenge.challengeId, challenge.demoCode!).status).toBe("authenticated");
    expect(service.database.prepare("SELECT phone, points FROM members WHERE id = 'm001'").get()).toMatchObject({ phone: "+6580001001", points: 17 });
  });
});

describe("surface boundaries", () => {
  it("preserves branded business errors across separate server module instances", async () => {
    vi.resetModules();
    const { DomainError: SeparateDomainError } = await import("../src/server/errors");
    expect(SeparateDomainError).not.toBe(DomainError);
    const error = new SeparateDomainError("OTP_RATE_LIMITED", 429, { retryAfterSeconds: 60 });
    expect(isDomainError(error)).toBe(true);
    expect(isDomainError({ name: "DomainError", code: "FORBIDDEN", status: 403 })).toBe(false);
    const response = errorResponse(error);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "OTP_RATE_LIMITED", retryAfterSeconds: 60 });
  });

  it("defaults to member and rejects other role parameters", () => {
    delete process.env.APP_SURFACE;
    expect(appSurface()).toBe("member");
    expect(requestRole(new Request("http://localhost:3000/api/state?role=member"))).toBe("member");
    expect(() => requestRole(new Request("http://localhost:3000/api/state?role=admin"))).toThrow("FORBIDDEN");
    process.env.APP_SURFACE = "invalid";
    expect(appSurface()).toBeNull();
    expect(() => requestRole(new Request("http://localhost:3000/api/state?role=member"))).toThrow("FORBIDDEN");
  });

  it.each(["member", "staff", "admin"])("accepts only the %s role on its surface", (surface) => {
    process.env.APP_SURFACE = surface;
    for (const role of ["member", "staff", "admin"]) {
      const request = new Request(`http://localhost:3000/api/state?role=${role}`);
      if (role === surface) expect(requestRole(request)).toBe(role);
      else expect(() => requestRole(request)).toThrow("FORBIDDEN");
    }
  });

  it("blocks public member-persona login and OTP on staff surfaces", async () => {
    const request = (path: string, body: unknown) => new Request(`http://localhost:3000${path}`, { method: "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    process.env.APP_SURFACE = "member";
    expect((await sessionPost(request("/api/session", { role: "member" }))).status).toBe(403);
    process.env.APP_SURFACE = "staff";
    expect((await memberAuthPost(request("/api/auth/member", { action: "request", phone: "80001001" }))).status).toBe(403);
  });
});

describe("concurrent registration", () => {
  it("consumes one registration token once across independent connections", async () => {
    const path = filePath();
    const { service, auth } = setup(path);
    const challenge = await auth.requestCode("81234567");
    const verified = auth.verifyCode(challenge.challengeId, challenge.demoCode!);
    if (verified.status !== "registration") throw new Error("REGISTRATION_REQUIRED");
    const source = `const {parentPort,workerData}=require('node:worker_threads'); const {registerHooks}=require('node:module'); registerHooks({resolve(specifier,context,nextResolve){try{return nextResolve(specifier,context)}catch(error){if(specifier.startsWith('.'))return nextResolve(specifier+'.ts',context);throw error}}}); (async()=>{const {createService}=await import(workerData.service);const {MemberAuthService}=await import(workerData.auth);const service=createService(workerData.path,()=>new Date('2026-09-22T06:00:00.000Z'));const auth=new MemberAuthService(service,{send:async()=>({})});parentPort.postMessage('ready');parentPort.once('message',()=>{try{const result=auth.register(workerData.token,'Concurrent Member');parentPort.postMessage({status:result.status,id:result.authentication.session.memberId})}catch(error){parentPort.postMessage({error:error.code})}finally{service.close()}})})();`;
    const workers = [1, 2].map(() => new Worker(source, { eval: true, execArgv: ["--experimental-transform-types"], workerData: { path, token: verified.registrationToken, service: pathToFileURL(resolve("src/server/service.ts")).href, auth: pathToFileURL(resolve("src/server/member-auth.ts")).href } }));
    try {
      await Promise.all(workers.map((worker) => once(worker, "message")));
      const results = workers.map((worker) => new Promise<{ status?: string; error?: string }>((resolveResult, reject) => {
        let response: { status?: string; error?: string } | undefined;
        worker.on("message", (message) => { response = message; });
        worker.once("error", reject);
        worker.once("exit", (code) => code === 0 && response ? resolveResult(response) : reject(new Error("WORKER_FAILED")));
      }));
      for (const worker of workers) worker.postMessage("register");
      const completed = await Promise.all(results);
      expect(completed.filter((result) => result.status === "authenticated")).toHaveLength(1);
      expect(completed.filter((result) => result.error === "REGISTRATION_INVALID")).toHaveLength(1);
      expect(service.database.prepare("SELECT COUNT(*) AS total FROM members WHERE phone = ?").get("+6581234567")).toMatchObject({ total: 1 });
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  });
});
