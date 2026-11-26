import { chatTerminalCommitSchema } from "@idream/shared/contracts";
import { ZodError } from "zod";
import { env } from "@/server/lib/env";
import { AppError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { commitChatTerminal } from "@/server/modules/chat/turn-ledger";

export async function POST(request: Request): Promise<Response> {
  if (!env.INTERNAL_TOKEN || request.headers.get("x-internal-token") !== env.INTERNAL_TOKEN) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let identity: { turnId?: unknown; attempt?: unknown; status?: unknown } = {};
  try {
    const body = await request.json() as unknown;
    if (body && typeof body === "object") {
      const { turnId, attempt, status } = body as Record<string, unknown>;
      identity = { turnId, attempt, status };
    }
    return Response.json(await commitChatTerminal(chatTerminalCommitSchema.parse(body)));
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: "invalid_terminal_commit" }, { status: 400 });
    }
    if (error instanceof AppError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    // Chat retries a 503; the operator needs to know why it had to.
    logger.error({ err: error, ...identity }, "Chat terminal commit failed unexpectedly");
    return Response.json({ error: "terminal_commit_unavailable" }, { status: 503 });
  }
}
