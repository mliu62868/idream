import { ZodError } from "zod";
import { devAdminLogin, devAdminLogout } from "@/server/admin/dev-login";
import { AppError } from "@/server/lib/errors";
import { fail } from "@/server/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type AdminAuthRouteContext = {
  params: Promise<{ action?: string }>;
};

async function route(request: Request, context: AdminAuthRouteContext) {
  try {
    const { action } = await context.params;
    if (action === "login") return await devAdminLogin(request);
    if (action === "logout") return await devAdminLogout(request);
    return fail(new AppError("not_found", "Unknown admin-auth action"));
  } catch (error) {
    if (error instanceof AppError) return fail(error);
    if (error instanceof ZodError) {
      return fail(new AppError("bad_request", "Validation failed", error.flatten()));
    }
    return fail(new AppError("internal", "Internal error"));
  }
}

export const POST = route;
