import { ZodError } from "zod";
import { env } from "@/server/lib/env";
import { AppError } from "@/server/lib/errors";
import { applyChatToolEffect } from "@/server/modules/chat/tool-effect";

export async function POST(request: Request): Promise<Response> {
  if (!env.INTERNAL_TOKEN || request.headers.get("x-internal-token") !== env.INTERNAL_TOKEN) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await applyChatToolEffect(await request.json());
    return Response.json(result, { status: result.accepted ? 200 : 409 });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: "invalid_tool_effect" }, { status: 400 });
    }
    if (error instanceof AppError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    return Response.json({ error: "tool_effect_unavailable" }, { status: 503 });
  }
}
