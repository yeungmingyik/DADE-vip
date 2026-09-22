import type { Locale, Role, StateQuery } from "../lib/types";
import { DomainError } from "./errors";
import { stateQuerySchema } from "./validation";
import { requireSurface } from "./surface";

export function requestRole(request: Request): Role {
  const role = new URL(request.url).searchParams.get("role");
  if (role !== "member" && role !== "staff" && role !== "admin") throw new DomainError("INVALID_INPUT");
  requireSurface(role);
  return role;
}

export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const requestUrl = new URL(request.url);
  const host = request.headers.get("host") ?? requestUrl.host;
  if (/[\\/?#@\s]/.test(host)) throw new DomainError("FORBIDDEN", 403);
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(`${requestUrl.protocol}//${host}`).origin;
  } catch {
    throw new DomainError("FORBIDDEN", 403);
  }
  if (!origin || origin !== expectedOrigin) throw new DomainError("FORBIDDEN", 403);
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") throw new DomainError("FORBIDDEN", 403);
}

export async function requestJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new DomainError("INVALID_INPUT");
  const body = await request.text();
  if (body.length > 16384) throw new DomainError("INVALID_INPUT");
  try {
    return JSON.parse(body);
  } catch {
    throw new DomainError("INVALID_INPUT");
  }
}

export function requestStateQuery(request: Request): StateQuery & { role: Role; locale?: Locale } {
  const parsed = stateQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) throw new DomainError("INVALID_INPUT");
  return parsed.data;
}
