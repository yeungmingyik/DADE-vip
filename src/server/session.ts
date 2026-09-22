import { cookies } from "next/headers";
import type { Role, Session } from "../lib/types";
import { getService } from "./runtime";
import { appSurface } from "./surface";

export function sessionCookieName(role: Role): string {
  return `sspc_${role}`;
}

export async function requireRole(role: Role): Promise<Session | null> {
  if (process.env.APP_MODE !== "demo" || appSurface() !== role) return null;
  const token = (await cookies()).get(sessionCookieName(role))?.value;
  return token ? getService().sessionForToken(role, token) : null;
}
