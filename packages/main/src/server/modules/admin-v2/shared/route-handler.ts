import { ZodError } from "zod";
import {
  findAdminV2ApiOperation,
  narrowAdminV2ResponseData,
  narrowAdminV2ResponseEnvelope,
  type AdminV2ResponseViolation,
} from "@idream/shared/admin";
import { AppError, Errors } from "@/server/lib/errors";
import { fail } from "@/server/lib/http";

/**
 * SPEC: the single door every Admin v2 Route Handler leaves through, and the only place a
 * success response is built. It resolves the operation from the request the runtime actually
 * received, then ships only what that operation's declared response contract admits.
 *
 * INTENT: the manifest declared a `response` ref for all 103 operations while 23 of them never
 * applied it — the ref described the shape rather than governing it. The check could not live
 * in the handlers (23 shallow call sites, each free to forget); it belongs here, where the
 * request and the manifest already meet. Keying off `request` rather than an operation-id
 * argument means there is no second declaration to drift from `findAdminV2ApiOperation`.
 *
 * INVARIANT: `execute` may still hand back a `Response` — modules that pick their own status or
 * `Cache-Control` need one — but that no longer buys an exit past the contract. A success
 * envelope is re-narrowed from its own bytes; only non-2xx and non-`ok` responses (`fail`)
 * pass through, because an error is not the success contract.
 */
export async function adminV2Route<T>(
  request: Request,
  execute: () => Promise<T | Response> | T | Response,
) {
  try {
    const operation = findAdminV2ApiOperation(
      request.method,
      new URL(request.url).pathname,
    );
    if (!operation) {
      // Fail closed: a route the manifest does not declare has no contract to answer to,
      // and `bootstrap`-style blanket trust is exactly what the manifest exists to replace.
      throw Errors.internal("Admin v2 route is not declared by the manifest", {
        method: request.method,
        pathname: new URL(request.url).pathname,
      });
    }
    const result = await execute();
    if (!(result instanceof Response)) {
      const narrowed = narrowAdminV2ResponseData(operation, result);
      if (!narrowed.ok) throw contractViolation(narrowed.violation);
      return Response.json({ ok: true, data: narrowed.data });
    }
    if (!result.ok) return result;
    const rawBody = await result.text();
    const narrowed = narrowAdminV2ResponseEnvelope(
      request.method,
      new URL(request.url).pathname,
      rawBody,
    );
    if (!narrowed.ok) throw contractViolation(narrowed.violation);
    const headers = new Headers(result.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify({ ok: true, data: narrowed.data }), {
      status: result.status,
      statusText: result.statusText,
      headers,
    });
  } catch (error) {
    if (error instanceof AppError) return fail(error);
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return fail(Errors.badRequest("Validation failed", error instanceof ZodError ? error.flatten() : undefined));
    }
    throw error;
  }
}

function contractViolation(violation: AdminV2ResponseViolation) {
  return Errors.internal(
    "Admin authority produced a response outside its declared contract",
    violation,
  );
}
