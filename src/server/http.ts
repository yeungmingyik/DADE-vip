import { NextResponse } from "next/server";
import type { Session } from "../lib/types";
import { DomainError, isDomainError } from "./errors";
import { requireRole } from "./session";
import { requestRole } from "./request";

export { requestJson, requestRole, requestStateQuery, requireSameOrigin } from "./request";

export async function authorizedSession(request: Request): Promise<Session> {
  const session = await requireRole(requestRole(request));
  if (!session) throw new DomainError("UNAUTHORIZED", 401);
  return session;
}

export function jsonResponse(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function errorResponse(error: unknown): NextResponse {
  if (isDomainError(error)) return jsonResponse({ error: error.code, ...error.details }, error.status);
  console.error(error);
  return jsonResponse({ error: "INTERNAL_ERROR" }, 500);
}
