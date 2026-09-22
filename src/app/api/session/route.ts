import { cookies } from "next/headers";
import { requireDemoMode } from "../../../integrations/demo";
import { errorResponse, jsonResponse, requestJson, requestRole, requireSameOrigin } from "../../../server/http";
import { DomainError } from "../../../server/errors";
import { getService } from "../../../server/runtime";
import { sessionCookieName } from "../../../server/session";
import { sessionSchema } from "../../../server/validation";
import { requireSurface } from "../../../server/surface";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOrigin(request);
    requireDemoMode();
    const parsed = sessionSchema.safeParse(await requestJson(request));
    if (!parsed.success) throw new DomainError("INVALID_INPUT");
    requireSurface(parsed.data.role);
    if (parsed.data.role === "member") throw new DomainError("FORBIDDEN", 403);
    const service = getService();
    service.persona(parsed.data.role, parsed.data.personaId);
    const current = (await cookies()).get(sessionCookieName(parsed.data.role))?.value;
    if (current) service.revokeSession(current);
    const result = service.createSession(parsed.data.role, parsed.data.personaId);
    const response = jsonResponse({ ok: true });
    response.cookies.set(sessionCookieName(parsed.data.role), result.token, { httpOnly: true, secure: new URL(request.url).protocol === "https:", sameSite: "lax", path: "/", expires: result.expiresAt });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    requireSameOrigin(request);
    requireDemoMode();
    const role = requestRole(request);
    const token = (await cookies()).get(sessionCookieName(role))?.value;
    if (token) getService().revokeSession(token);
    const response = jsonResponse({ ok: true });
    response.cookies.set(sessionCookieName(role), "", { httpOnly: true, secure: new URL(request.url).protocol === "https:", sameSite: "lax", path: "/", maxAge: 0 });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
