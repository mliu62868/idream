import { ZodError } from "zod";
import { env } from "@/server/lib/env";
import { AppError } from "@/server/lib/errors";
import { recordGenerationTransportExecution } from "@/server/ai/generation-transport-execution";

export async function POST(request: Request): Promise<Response> {
  if (request.headers.get("x-internal-token") !== env.INTERNAL_TOKEN) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return Response.json(await recordGenerationTransportExecution(await request.json()));
  } catch (error) {
    if (error instanceof ZodError) return Response.json({ error: "invalid_generation_transport" }, { status: 400 });
    if (error instanceof AppError) {
      const details = error.details as { reason?: unknown } | undefined;
      // The reason crosses to Gen because retry policy depends on it, and only the
      // string does: identifiers in the rest of details stay out of worker logs.
      const reason = typeof details?.reason === "string" ? details.reason : undefined;
      return Response.json({ error: error.code, message: error.message, ...(reason ? { reason } : {}) }, { status: error.status });
    }
    return Response.json({ error: "generation_transport_unavailable" }, { status: 503 });
  }
}
