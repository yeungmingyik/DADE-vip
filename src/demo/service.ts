import { z } from "zod";
import type { Role, Session } from "../lib/types";
import { nextMemberNumber } from "../modules/member-numbers";
import { sessionSchema, stateQuerySchema } from "../server/validation";
import { appendDemoAudit, createDemoState, DemoError, demoSession, establishDemoSession, executeDemoAction, exportDemoCsv, readDemoAppData, type DemoState } from "./domain";
import { readDemoStorage, withDemoStorage } from "./storage";

export { createDemoState, executeDemoAction, readDemoAppData, demoPersona, demoMember, DemoError } from "./domain";
export type { DemoState } from "./domain";

const memberAuthSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("request"), phone: z.string().trim().min(1).max(32) }).strict(),
  z.object({ action: z.literal("verify"), challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) }).strict(),
  z.object({ action: z.literal("register"), registrationToken: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().trim().min(1).max(80).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)) }).strict(),
]);

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

function failureResponse(error: unknown): Response {
  return error instanceof DemoError ? jsonResponse({ error: error.code, ...error.details }, error.status) : jsonResponse({ error: "INTERNAL_ERROR" }, 500);
}

function parseBody(init: RequestInit): unknown {
  if (new Headers(init.headers).get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json" || typeof init.body !== "string" || init.body.length > 16384) throw new DemoError("INVALID_INPUT");
  try { return JSON.parse(init.body); } catch { throw new DemoError("INVALID_INPUT"); }
}

function parseRole(value: string | null): Role {
  if (value !== "member" && value !== "staff" && value !== "admin") throw new DemoError("INVALID_INPUT");
  return value;
}

function requireSession(state: DemoState, role: Role, now: Date): Session {
  const session = demoSession(state, role, now);
  if (!session) throw new DemoError("UNAUTHORIZED", 401);
  return session;
}

function normalizedPhone(value: string): string {
  const compact = value.trim().replace(/[\s()-]/g, "");
  const phone = compact.startsWith("+65") ? compact.slice(3) : compact.length === 10 && compact.startsWith("65") ? compact.slice(2) : compact;
  if (!/^[89]\d{7}$/.test(phone)) throw new DemoError("INVALID_PHONE");
  return `+65${phone}`;
}

function authenticateMember(state: DemoState, body: unknown, now: Date): unknown {
  const parsed = memberAuthSchema.safeParse(body);
  if (!parsed.success) throw new DemoError("INVALID_INPUT");
  const input = parsed.data;
  const timestamp = now.toISOString();
  if (input.action === "request") {
    const phone = normalizedPhone(input.phone);
    const requests = state.challenges.filter((item) => item.phone === phone).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latest = requests[0];
    if (latest && latest.resendAt > timestamp) throw new DemoError("OTP_RATE_LIMITED", 429, { resendAt: latest.resendAt, retryAfterSeconds: Math.ceil((Date.parse(latest.resendAt) - now.getTime()) / 1000) });
    const recent = requests.filter((item) => Date.parse(item.createdAt) > now.getTime() - 3600000);
    if (recent.length >= 5) {
      const resendAt = new Date(Math.min(...recent.map((item) => Date.parse(item.createdAt))) + 3600000).toISOString();
      throw new DemoError("OTP_RATE_LIMITED", 429, { resendAt, retryAfterSeconds: Math.max(1, Math.ceil((Date.parse(resendAt) - now.getTime()) / 1000)) });
    }
    for (const challenge of state.challenges) if (challenge.phone === phone) challenge.consumed = true;
    for (const registration of state.registrations) if (registration.phone === phone) registration.consumed = true;
    const random = crypto.getRandomValues(new Uint32Array(1))[0];
    const challenge = { id: crypto.randomUUID(), phone, code: String(100000 + random % 900000), createdAt: timestamp, expiresAt: new Date(now.getTime() + 300000).toISOString(), resendAt: new Date(now.getTime() + 60000).toISOString(), attempts: 0, consumed: false };
    state.challenges.push(challenge);
    return { challengeId: challenge.id, maskedPhone: `+65 •••• ${phone.slice(-4)}`, expiresAt: challenge.expiresAt, resendAt: challenge.resendAt, demoCode: challenge.code };
  }
  if (input.action === "verify") {
    const challenge = state.challenges.find((item) => item.id === input.challengeId);
    if (!challenge || challenge.consumed) throw new DemoError("OTP_CHALLENGE_INVALID");
    if (challenge.expiresAt <= timestamp) throw new DemoError("OTP_EXPIRED");
    if (challenge.attempts >= 5) throw new DemoError("OTP_LOCKED", 429, { attemptsRemaining: 0 });
    if (input.code !== challenge.code) {
      challenge.attempts += 1;
      throw new DemoError(challenge.attempts >= 5 ? "OTP_LOCKED" : "OTP_INVALID", challenge.attempts >= 5 ? 429 : 400, { attemptsRemaining: 5 - challenge.attempts }, true);
    }
    challenge.consumed = true;
    const member = state.members.find((item) => item.phone === challenge.phone);
    if (member) {
      if (member.status !== "active") throw new DemoError("MEMBER_SUSPENDED", 403, {}, true);
      establishDemoSession(state, "member", member.id, now);
      return { status: "authenticated" };
    }
    for (const registration of state.registrations) if (registration.phone === challenge.phone) registration.consumed = true;
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) => value.toString(16).padStart(2, "0")).join("");
    state.registrations.push({ token, phone: challenge.phone, expiresAt: new Date(now.getTime() + 600000).toISOString(), consumed: false });
    return { status: "registration", registrationToken: token, phone: challenge.phone };
  }
  const registration = state.registrations.find((item) => item.token === input.registrationToken);
  if (!registration || registration.consumed) throw new DemoError("REGISTRATION_INVALID");
  if (registration.expiresAt <= timestamp) throw new DemoError("REGISTRATION_EXPIRED");
  registration.consumed = true;
  let member = state.members.find((item) => item.phone === registration.phone);
  if (member?.status === "suspended") throw new DemoError("MEMBER_SUSPENDED", 403, {}, true);
  if (!member) {
    const number = nextMemberNumber(state.members.map((item) => item.number));
    const id = `m-${crypto.randomUUID()}`;
    member = { id, number, code: `dade_${crypto.randomUUID().replaceAll("-", "")}`, name: input.name, phone: registration.phone, joinedAt: timestamp, status: "active", points: 0, visits: 0, tier: "bronze", monthlyRedeemed: 0, totalSpendCents: 0 };
    state.members.push(member);
    appendDemoAudit(state, id, "registerMember", id, null, now);
  }
  establishDemoSession(state, "member", member.id, now);
  return { status: "authenticated" };
}

export function executeDemoRequest(state: DemoState, input: string, init: RequestInit = {}, now = new Date()): { state: DemoState; response: Response } {
  const draft = structuredClone(state);
  try {
    init.signal?.throwIfAborted();
    const url = new URL(input, "https://demo.local");
    const method = (init.method ?? "GET").toUpperCase();
    if (url.pathname === "/api/auth/member" && method === "POST") {
      const result = authenticateMember(draft, parseBody(init), now);
      draft.revision += 1;
      return { state: draft, response: jsonResponse(result) };
    }
    if (url.pathname === "/api/session") {
      if (method === "POST") {
        const parsed = sessionSchema.safeParse(parseBody(init));
        if (!parsed.success) throw new DemoError("INVALID_INPUT");
        if (parsed.data.role === "member") throw new DemoError("FORBIDDEN", 403);
        establishDemoSession(draft, parsed.data.role, parsed.data.personaId ?? (parsed.data.role === "staff" ? "s001" : "a001"), now);
      } else if (method === "DELETE") {
        delete draft.sessions[parseRole(url.searchParams.get("role"))];
      } else throw new DemoError("INVALID_INPUT", 405);
      draft.revision += 1;
      return { state: draft, response: jsonResponse({ ok: true }) };
    }
    if (url.pathname === "/api/actions" && method === "POST") {
      const session = requireSession(state, parseRole(url.searchParams.get("role")), now);
      const result = executeDemoAction(state, session, parseBody(init), now);
      return { state: result.state, response: jsonResponse(result.result) };
    }
    if ((url.pathname === "/api/state" || url.pathname === "/api/export") && method === "GET") {
      const parsed = stateQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) throw new DemoError("INVALID_INPUT");
      const query = parsed.data;
      const session = requireSession(state, query.role, now);
      if (url.pathname === "/api/state") return { state, response: jsonResponse(readDemoAppData(state, session, query, now)) };
      const csv = exportDemoCsv(state, session, query, query.locale ?? "en", now);
      return { state, response: new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="dade-${query.section === "redemptions" ? "redemptions" : "purchases"}.csv"` } }) };
    }
    throw new DemoError("NOT_FOUND", 404);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    if (error instanceof DemoError && error.commit) { draft.revision += 1; return { state: draft, response: failureResponse(error) }; }
    return { state, response: failureResponse(error) };
  }
}

export async function demoRequest(input: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await withDemoStorage(createDemoState, (state) => {
      const result = executeDemoRequest(state, input, init);
      return { state: result.state, value: result.response };
    }, init.signal);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    return failureResponse(error);
  }
}

export function readSessionRole(role: Role): Session | null {
  try {
    const state = readDemoStorage();
    return state ? demoSession(state, role) : null;
  } catch { return null; }
}

export function demoHasSession(role: Role): boolean { return readSessionRole(role) !== null; }
