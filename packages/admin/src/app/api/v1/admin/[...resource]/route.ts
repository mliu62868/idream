import { proxyToMain } from "../../../../../server/main-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type AdminApiRouteContext = {
  params: Promise<{
    resource?: string[];
  }>;
};

async function route(request: Request, context: AdminApiRouteContext) {
  const { resource = [] } = await context.params;
  const suffix = resource.map(encodeURIComponent).join("/");
  return proxyToMain(request, `/api/v1/admin/${suffix}`);
}

export const GET = route;
export const POST = route;
export const PATCH = route;
export const PUT = route;
export const DELETE = route;
