import type { Role } from "../lib/types";
import { DomainError } from "./errors";

export function appSurface(): Role | null {
  const value = process.env.APP_SURFACE ?? "member";
  return value === "member" || value === "staff" || value === "admin" ? value : null;
}

export function requireSurface(role: Role): void {
  if (appSurface() !== role) throw new DomainError("FORBIDDEN", 403);
}
