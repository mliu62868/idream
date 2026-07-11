import { proxyToMain } from "../../../../../server/main-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type AdminV2RouteContext = {
  params: Promise<{
    resource?: string[];
  }>;
};

export function adminV2Path(resource: readonly string[]) {
  return `/api/v2/admin/${resource.map(encodeURIComponent).join("/")}`;
}

async function route(request: Request, context: AdminV2RouteContext) {
  const { resource = [] } = await context.params;
  return proxyToMain(request, adminV2Path(resource));
}

export const GET = route;
export const POST = route;
export const PATCH = route;
export const PUT = route;
export const DELETE = route;
