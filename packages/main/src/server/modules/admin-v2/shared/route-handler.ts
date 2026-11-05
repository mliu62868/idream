import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import {
  findAdminV2ApiOperation,
  adminV2BinaryResponseHeaders,
  narrowAdminV2BinaryResponse,
  narrowAdminV2ResponseData,
  narrowAdminV2ResponseEnvelope,
  requireExecutableAdminV2Contract,
  type AdminV2ResponseViolation,
} from "@idream/shared/admin";
import { AppError, Errors } from "@/server/lib/errors";
import { fail } from "@/server/lib/http";
import { logger } from "@/server/lib/logger";
import { IdempotencyConflictError } from "./control-plane-command";
import { isSerializableWriteConflict } from "./prisma-transaction-conflict";
import { assertAdminRequestEnvelopeInput } from "./request-input-guard";

/** Resolve once, then validate the complete decorated receipt inside its transaction. */
export function adminMutationResultValidator(request: Request) {
  const operation = findAdminV2ApiOperation(request.method, new URL(request.url).pathname);
  if (!operation) throw Errors.internal("Admin mutation route is not declared by the manifest");
  const { schema } = requireExecutableAdminV2Contract(operation.contract.response);
  return (value: unknown) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw Errors.internal("Admin mutation produced a response outside its declared contract", {
      operationId: operation.id,
      issues: parsed.error.issues.map(({ code, path }) => ({ code, path })),
    });
    return parsed.data;
  };
}

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
 * envelope is re-narrowed from its own bytes. An explicit manifest binary operation
 * validates media metadata and preserves its authorized stream; arbitrary Responses
 * cannot opt out of the JSON contract by changing Content-Type.
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
    assertAdminRequestEnvelopeInput(request);
    const result = await execute();
    if (operation.responseBody === "binary") {
      if (!(result instanceof Response)) throw Errors.internal("Binary Admin operation did not return a Response");
      if (result.ok) {
        const narrowed = narrowAdminV2BinaryResponse(operation, result);
        if (!narrowed.ok) throw contractViolation(narrowed.violation);
      }
      return new Response(result.body, {
        status: result.status,
        statusText: result.statusText,
        headers: adminV2BinaryResponseHeaders(result),
      });
    }
    if (!(result instanceof Response)) {
      const narrowed = narrowAdminV2ResponseData(operation, result);
      if (!narrowed.ok) throw contractViolation(narrowed.violation);
      return Response.json({ ok: true, data: narrowed.data });
    }
    if (!result.ok) {
      // A module that caught its own AppError and built the response skipped `failAppError` below.
      if (result.status >= 500) {
        logger.error({
          status: result.status,
          body: await result.clone().text(),
          method: request.method,
          path: new URL(request.url).pathname,
          requestId: request.headers.get("x-request-id"),
        }, "Admin v2 route answered with a server error");
      }
      return result;
    }
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
    if (error instanceof AppError) return failAppError(request, error);
    // INVARIANT: the same key with a different request is the caller's conflict on every path,
    // including those that accept a command outside `commandResponse`.
    if (error instanceof IdempotencyConflictError) {
      return Response.json(
        {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            requestId: request.headers.get("x-request-id")?.trim() || "unknown",
            commandId: error.existingCommandId,
          },
        },
        { status: 409 },
      );
    }
    const prismaFailure = appErrorFromPrismaFailure(error);
    if (prismaFailure) return failAppError(request, prismaFailure);
    // Request input is explicitly parsed as bad_request at its ingress, including
    // path parameters and multipart fields. A remaining ZodError is an authority
    // contract failure regardless of which domain module validated the output.
    if (error instanceof ZodError) {
      logger.error({
        issues: error.issues.slice(0, 5).map(({ code, path }) => ({ code, path })),
        method: request.method,
        path: new URL(request.url).pathname,
        requestId: request.headers.get("x-request-id"),
      }, "Admin v2 route rejected data outside its contract");
      return fail(Errors.internal("Admin authority produced data outside its declared contract"));
    }
    // INVARIANT: an unexpected authority failure still uses the API envelope;
    // Next's fallback response has no usable error contract for operator recovery.
    logger.error({
      err: error,
      method: request.method,
      path: new URL(request.url).pathname,
      requestId: request.headers.get("x-request-id"),
    }, "Unhandled Admin v2 route error");
    return fail(Errors.internal("Internal error"));
  }
}

// INTENT: `fail` keeps 5xx details out of the response, so without this line a contract violation
// reached neither the client nor the logs and could only be seen as an unexplained 500.
function failAppError(request: Request, error: AppError) {
  if (error.status >= 500) {
    logger.error({
      err: error,
      code: error.code,
      details: error.details,
      method: request.method,
      path: new URL(request.url).pathname,
      requestId: request.headers.get("x-request-id"),
    }, error.message);
  }
  return fail(error);
}

/**
 * SPEC: The Prisma failures a request can legitimately cause, as the client errors they mean.
 * INVARIANT: messages are fixed here. Prisma's own text quotes the query and must not reach a client.
 * Every other Prisma failure stays an unhandled 500, because it is ours rather than the caller's.
 */
function appErrorFromPrismaFailure(error: unknown): AppError | null {
  if (isSerializableWriteConflict(error)) {
    return Errors.conflict("The record changed concurrently; reload and try again");
  }
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  if (error.code === "P2025") return Errors.notFound("Record not found");
  if (error.code === "P2028") return Errors.unavailable("The database transaction could not complete; try again");
  if (error.code === "P2020") return Errors.badRequest("A value is out of range for its field");
  return null;
}

function contractViolation(violation: AdminV2ResponseViolation) {
  return Errors.internal(
    "Admin authority produced a response outside its declared contract",
    violation,
  );
}
