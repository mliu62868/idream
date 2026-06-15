import { dispatchV1 } from "@/server/modules/ourdream/service";

type ApiRouteContext = {
  params: Promise<{
    resource?: string[];
  }>;
};

async function route(request: Request, context: ApiRouteContext) {
  const { resource = [] } = await context.params;
  return dispatchV1(request, resource);
}

export const GET = route;
export const POST = route;
export const PATCH = route;
export const PUT = route;
export const DELETE = route;
