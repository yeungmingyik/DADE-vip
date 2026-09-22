import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { OtpDelivery } from "../integrations/member-otp";
import { DomainError } from "./errors";
import type { SspcService } from "./service";

export const memberAuthSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("request"), phone: z.string().trim().min(1).max(32) }).strict(),
  z.object({ action: z.literal("verify"), challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) }).strict(),
  z.object({ action: z.literal("register"), registrationToken: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().trim().min(1).max(80).refine((name) => !/[\u0000-\u001f\u007f]/.test(name)) }).strict(),
]);

export function normalizePhone(input: string): string {
  let phone = input.trim().replace(/[\s()-]/g, "");
  if (phone.startsWith("+65")) phone = phone.slice(3);
  else if (phone.length === 10 && phone.startsWith("65")) phone = phone.slice(2);
  if (!/^[89]\d{7}$/.test(phone)) throw new DomainError("INVALID_PHONE");
  return `+65${phone}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type SessionResult = ReturnType<SspcService["createSession"]>;
type AuthenticationResult = { status: "authenticated"; authentication: SessionResult };
type RegistrationResult = { status: "registration"; registrationToken: string; phone: string };
type ChallengeRow = { id: string; phone: string; code_hash: string; created_at: string; expires_at: string; resend_at: string; attempts: number; consumed_at: string | null; delivered: number };
type RegistrationRow = { phone: string; expires_at: string; consumed_at: string | null };

export class MemberAuthService {
  constructor(private readonly service: SspcService, private readonly delivery: OtpDelivery) {}

  private transact<T>(operation: () => T): T {
    this.service.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.service.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.service.database.exec("ROLLBACK");
      throw error;
    }
  }

  async requestCode(rawPhone: string): Promise<{ challengeId: string; maskedPhone: string; expiresAt: string; resendAt: string; demoCode?: string }> {
    const phone = normalizePhone(rawPhone);
    const code = String(randomInt(100000, 1000000));
    const challenge = this.transact(() => {
      const now = this.service.clock();
      const createdAt = now.toISOString();
      const latest = this.service.database.prepare("SELECT * FROM member_otp_challenges WHERE phone = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(phone) as ChallengeRow | undefined;
      if (latest && latest.resend_at > createdAt) throw new DomainError("OTP_RATE_LIMITED", 429, { retryAfterSeconds: Math.ceil((Date.parse(latest.resend_at) - now.getTime()) / 1000), resendAt: latest.resend_at });
      const requests = this.service.database.prepare("SELECT COUNT(*) AS total, MIN(created_at) AS first_at FROM member_otp_challenges WHERE phone = ? AND created_at > ?").get(phone, new Date(now.getTime() - 3600000).toISOString()) as { total: number; first_at: string | null };
      if (requests.total >= 5) {
        const resendAt = new Date(Date.parse(requests.first_at!) + 3600000).toISOString();
        throw new DomainError("OTP_RATE_LIMITED", 429, { retryAfterSeconds: Math.max(1, Math.ceil((Date.parse(resendAt) - now.getTime()) / 1000)), resendAt });
      }
      const challengeId = randomUUID();
      const expiresAt = new Date(now.getTime() + 300000).toISOString();
      const resendAt = new Date(now.getTime() + 60000).toISOString();
      this.service.database.prepare("UPDATE member_otp_challenges SET consumed_at = ? WHERE phone = ? AND consumed_at IS NULL").run(createdAt, phone);
      this.service.database.prepare("UPDATE member_registration_tokens SET consumed_at = ? WHERE phone = ? AND consumed_at IS NULL").run(createdAt, phone);
      this.service.database.prepare("INSERT INTO member_otp_challenges (id, phone, code_hash, created_at, expires_at, resend_at) VALUES (?, ?, ?, ?, ?, ?)").run(challengeId, phone, digest(`${challengeId}:${code}`), createdAt, expiresAt, resendAt);
      return { challengeId, expiresAt, resendAt };
    });
    try {
      const delivered = await this.delivery.send({ phone, code, expiresAt: challenge.expiresAt });
      this.service.database.prepare("UPDATE member_otp_challenges SET delivered = 1 WHERE id = ?").run(challenge.challengeId);
      return { ...challenge, maskedPhone: `+65 •••• ${phone.slice(-4)}`, ...(delivered.demoCode ? { demoCode: delivered.demoCode } : {}) };
    } catch {
      const now = this.service.clock().toISOString();
      this.service.database.prepare("UPDATE member_otp_challenges SET consumed_at = ?, resend_at = ? WHERE id = ?").run(now, now, challenge.challengeId);
      throw new DomainError("OTP_DELIVERY_FAILED", 503);
    }
  }

  verifyCode(challengeId: string, code: string): AuthenticationResult | RegistrationResult {
    const result = this.transact<AuthenticationResult | RegistrationResult | DomainError>(() => {
      const now = this.service.clock().toISOString();
      const challenge = this.service.database.prepare("SELECT * FROM member_otp_challenges WHERE id = ?").get(challengeId) as ChallengeRow | undefined;
      if (!challenge || challenge.consumed_at || !challenge.delivered) return new DomainError("OTP_CHALLENGE_INVALID");
      if (challenge.expires_at <= now) return new DomainError("OTP_EXPIRED");
      if (challenge.attempts >= 5) return new DomainError("OTP_LOCKED", 429, { attemptsRemaining: 0 });
      const match = /^\d{6}$/.test(code) && timingSafeEqual(Buffer.from(digest(`${challengeId}:${code}`), "hex"), Buffer.from(challenge.code_hash, "hex"));
      if (!match) {
        const attempts = challenge.attempts + 1;
        this.service.database.prepare("UPDATE member_otp_challenges SET attempts = ? WHERE id = ?").run(attempts, challengeId);
        return new DomainError(attempts >= 5 ? "OTP_LOCKED" : "OTP_INVALID", attempts >= 5 ? 429 : 400, { attemptsRemaining: 5 - attempts });
      }
      this.service.database.prepare("UPDATE member_otp_challenges SET consumed_at = ? WHERE id = ?").run(now, challengeId);
      const member = this.service.database.prepare("SELECT id, status FROM members WHERE phone = ?").get(challenge.phone) as { id: string; status: string } | undefined;
      if (member) {
        if (member.status !== "active") return new DomainError("MEMBER_SUSPENDED", 403);
        return { status: "authenticated", authentication: this.service.createSession("member", member.id) };
      }
      const registrationToken = randomBytes(32).toString("hex");
      this.service.database.prepare("UPDATE member_registration_tokens SET consumed_at = ? WHERE phone = ? AND consumed_at IS NULL").run(now, challenge.phone);
      this.service.database.prepare("INSERT INTO member_registration_tokens (token_hash, phone, created_at, expires_at) VALUES (?, ?, ?, ?)").run(digest(registrationToken), challenge.phone, now, new Date(Date.parse(now) + 600000).toISOString());
      return { status: "registration", registrationToken, phone: challenge.phone };
    });
    if (result instanceof DomainError) throw result;
    return result;
  }

  register(registrationToken: string, rawName: string): AuthenticationResult {
    const parsed = memberAuthSchema.safeParse({ action: "register", registrationToken, name: rawName });
    if (!parsed.success || parsed.data.action !== "register") throw new DomainError("INVALID_INPUT");
    const name = parsed.data.name;
    const result = this.transact<AuthenticationResult | DomainError>(() => {
      const now = this.service.clock().toISOString();
      const registration = this.service.database.prepare("SELECT phone, expires_at, consumed_at FROM member_registration_tokens WHERE token_hash = ?").get(digest(registrationToken)) as RegistrationRow | undefined;
      if (!registration || registration.consumed_at) return new DomainError("REGISTRATION_INVALID");
      if (registration.expires_at <= now) return new DomainError("REGISTRATION_EXPIRED");
      this.service.database.prepare("UPDATE member_registration_tokens SET consumed_at = ? WHERE token_hash = ?").run(now, digest(registrationToken));
      let member = this.service.database.prepare("SELECT id, status FROM members WHERE phone = ?").get(registration.phone) as { id: string; status: string } | undefined;
      if (member?.status === "suspended") return new DomainError("MEMBER_SUSPENDED", 403);
      if (!member) {
        const id = `m-${randomUUID()}`;
        const sequence = this.service.database.prepare("SELECT COALESCE(MAX(CAST(substr(number, 6) AS INTEGER)), 10000) + 1 AS value FROM members").get() as { value: number };
        this.service.database.prepare("INSERT INTO members (id, number, code, name, phone, joined_at, status, points) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, `SSPC ${sequence.value}`, `sspc_${randomUUID().replaceAll("-", "")}`, name, registration.phone, now, "active", 0);
        this.service.database.prepare("INSERT INTO audit (id, actor, action, entity_id, store_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), id, "registerMember", id, null, "{}", now);
        member = { id, status: "active" };
      }
      return { status: "authenticated", authentication: this.service.createSession("member", member.id) };
    });
    if (result instanceof DomainError) throw result;
    return result;
  }
}
