import { ZodError } from "zod";
import { AppError, Errors } from "@/server/lib/errors";
import { fail } from "@/server/lib/http";

export async function adminV2Route<T>(execute: () => Promise<T | Response>) {
  try {
    const result = await execute();
    return result instanceof Response ? result : Response.json({ ok: true, data: result });
  } catch (error) {
    if (error instanceof AppError) return fail(error);
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return fail(Errors.badRequest("Validation failed", error instanceof ZodError ? error.flatten() : undefined));
    }
    throw error;
  }
}

