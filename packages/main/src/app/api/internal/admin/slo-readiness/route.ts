import { env } from "@/server/lib/env";
import { adminSloReadiness } from "@/server/observability/admin-slo-readiness";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  if (request.headers.get("x-internal-token") !== env.INTERNAL_TOKEN) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json(await adminSloReadiness(), { headers: { "cache-control": "no-store" } });
}
