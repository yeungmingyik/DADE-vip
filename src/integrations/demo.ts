import { randomUUID } from "node:crypto";
import { DomainError } from "../server/errors";

export function requireDemoMode(): void {
  if (process.env.APP_MODE !== "demo") throw new DomainError("DEMO_DISABLED", 403);
}

export interface MemberScanInput {
  code: string;
}

export function parseMemberScan(input: MemberScanInput): string {
  const code = input.code.trim();
  if (!/^(?:dade|sspc)_[a-zA-Z0-9_-]{12,64}$/.test(code)) throw new DomainError("INVALID_MEMBER_CODE");
  return code;
}

export function createDemoCashierInput(amountCents: number): { amountCents: number; receipt: string } {
  requireDemoMode();
  return { amountCents, receipt: `DADE-${randomUUID()}` };
}
