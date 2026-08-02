import { env } from "@/server/lib/env";
import { ingestGenerationTerminalRecord } from "@/server/ai/generation-terminal-record-ingest";
import { AppError } from "@/server/lib/errors";
import { ZodError } from "zod";

export async function POST(request: Request): Promise<Response> {
  if (request.headers.get("x-internal-token") !== env.INTERNAL_TOKEN) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await ingestGenerationTerminalRecord(await request.json());
    return Response.json(result, { status: result.acknowledged ? 200 : 409 });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: "invalid_generation_terminal_record" }, { status: 400 });
    }
    if (error instanceof AppError) {
      return Response.json(
        { error: error.code, message: error.message },
        { status: error.status },
      );
    }
    return Response.json(
      { error: "generation_terminal_record_ingest_unavailable" },
      { status: 503 },
    );
  }
}
