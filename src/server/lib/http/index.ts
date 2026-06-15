import { ZodError } from "zod";
import { AppError } from "../errors";
import { logger } from "../logger";

type Handler<T> = (request: Request) => Promise<T> | T;

export function ok<T>(data: T, init?: ResponseInit) {
  return Response.json({ ok: true, data }, init);
}

export function empty(status = 204) {
  return new Response(null, { status });
}

export function fail(error: AppError) {
  return Response.json(
    {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.status < 500 ? error.details : undefined,
      },
    },
    { status: error.status },
  );
}

export function handle<T>(handler: Handler<T | Response>) {
  return async (request: Request) => {
    try {
      const result = await handler(request);
      return result instanceof Response ? result : ok(result);
    } catch (error) {
      if (error instanceof AppError) return fail(error);

      if (error instanceof ZodError) {
        return fail(
          new AppError("bad_request", "Validation failed", error.flatten()),
        );
      }

      logger.error({ error }, "Unhandled route error");
      return fail(new AppError("internal", "Internal error"));
    }
  };
}
