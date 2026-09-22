import { cookies } from "next/headers";
import { requireDemoMode } from "../../../../integrations/demo";
import { DemoOtpDelivery } from "../../../../integrations/member-otp";
import { DomainError } from "../../../../server/errors";
import { errorResponse, jsonResponse, requestJson, requireSameOrigin } from "../../../../server/http";
import { MemberAuthService, memberAuthSchema } from "../../../../server/member-auth";
import { getService } from "../../../../server/runtime";
import { sessionCookieName } from "../../../../server/session";
import { requireSurface } from "../../../../server/surface";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOrigin(request);
    requireDemoMode();
    requireSurface("member");
    const parsed = memberAuthSchema.safeParse(await requestJson(request));
    if (!parsed.success) throw new DomainError("INVALID_INPUT");
    const service = getService();
    const authentication = new MemberAuthService(service, new DemoOtpDelivery());
    const input = parsed.data;
    if (input.action === "request") return jsonResponse(await authentication.requestCode(input.phone));
    const result = input.action === "verify" ? authentication.verifyCode(input.challengeId, input.code) : authentication.register(input.registrationToken, input.name);
    if (result.status === "registration") return jsonResponse(result);
    const current = (await cookies()).get(sessionCookieName("member"))?.value;
    if (current) service.revokeSession(current);
    const response = jsonResponse({ status: "authenticated" });
    response.cookies.set(sessionCookieName("member"), result.authentication.token, { httpOnly: true, secure: new URL(request.url).protocol === "https:", sameSite: "lax", path: "/", expires: result.authentication.expiresAt });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
