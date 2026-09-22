import { authorizedSession, errorResponse, requestStateQuery } from "../../../server/http";
import { getService } from "../../../server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const query = requestStateQuery(request);
    const session = await authorizedSession(request);
    const csv = getService().exportCsv(session, query, query.locale);
    return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="sspc-${query.section === "redemptions" ? "redemptions" : "purchases"}.csv"`, "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
