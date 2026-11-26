import { ZodError } from "zod";
import { env } from "@/server/lib/env";
import { AppError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { applyChatToolEffect } from "@/server/modules/chat/tool-effect";

export async function POST(request: Request): Promise<Response> {
  if (!env.INTERNAL_TOKEN || request.headers.get("x-internal-token") !== env.INTERNAL_TOKEN) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let identity: { turnId?: unknown; attempt?: unknown; name?: unknown } = {};
  try {
    const body = await request.json() as unknown;
    if (body && typeof body === "object") {
      const { turnId, attempt, name } = body as Record<string, unknown>;
      identity = { turnId, attempt, name };
    }
    const result = await applyChatToolEffect(body, request.signal);
    return Response.json(result, { status: result.accepted ? 200 : 409 });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: "invalid_tool_effect" }, { status: 400 });
    }
    if (error instanceof AppError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    // Chat retries a 503; the operator needs to know why it had to.
    logger.error({ err: error, ...identity }, "Chat tool effect failed unexpectedly");
    return Response.json({ error: "tool_effect_unavailable" }, { status: 503 });
  }
}
