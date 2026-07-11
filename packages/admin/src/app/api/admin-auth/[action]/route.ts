import { proxyToMain } from "../../../../server/main-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type AdminAuthRouteContext = {
  params: Promise<{ action?: string }>;
};

async function route(request: Request, context: AdminAuthRouteContext) {
  const { action = "" } = await context.params;
  return proxyToMain(request, `/api/admin-auth/${encodeURIComponent(action)}`);
}

export const POST = route;
