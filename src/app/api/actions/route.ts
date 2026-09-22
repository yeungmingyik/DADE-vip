import { requireDemoMode } from "../../../integrations/demo";
import { authorizedSession, errorResponse, jsonResponse, requestJson, requireSameOrigin } from "../../../server/http";
import { getService } from "../../../server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOrigin(request);
    requireDemoMode();
    const session = await authorizedSession(request);
    return jsonResponse(getService().execute(session, await requestJson(request)));
  } catch (error) {
    return errorResponse(error);
  }
}
