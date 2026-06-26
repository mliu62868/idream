import { ZodError } from "zod";
import { dispatchAdmin } from "@/server/modules/admin/service";
import { AppError } from "@/server/lib/errors";
import { fail } from "@/server/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type AdminApiRouteContext = {
  params: Promise<{
    resource?: string[];
  }>;
};

async function route(request: Request, context: AdminApiRouteContext) {
  try {
    const { resource = [] } = await context.params;
    return await dispatchAdmin(request, resource);
  } catch (error) {
    if (error instanceof AppError) return fail(error);

    if (error instanceof ZodError) {
      return fail(new AppError("bad_request", "Validation failed", error.flatten()));
    }

    return fail(new AppError("internal", "Internal error"));
  }
}

export const GET = route;
export const POST = route;
export const PATCH = route;
export const PUT = route;
export const DELETE = route;
