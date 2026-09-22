import { authorizedSession, errorResponse, jsonResponse, requestStateQuery } from "../../../server/http";
import { getService } from "../../../server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const query = requestStateQuery(request);
    const session = await authorizedSession(request);
    return jsonResponse(getService().state(session, query));
  } catch (error) {
    return errorResponse(error);
  }
}
