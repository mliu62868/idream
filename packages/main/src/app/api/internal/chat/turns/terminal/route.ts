import { chatTerminalCommitSchema } from "@idream/shared/contracts";
import { ZodError } from "zod";
import { env } from "@/server/lib/env";
import { AppError } from "@/server/lib/errors";
import { commitChatTerminal } from "@/server/modules/chat/turn-ledger";

export async function POST(request: Request): Promise<Response> {
  if (!env.INTERNAL_TOKEN || request.headers.get("x-internal-token") !== env.INTERNAL_TOKEN) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return Response.json(
      await commitChatTerminal(chatTerminalCommitSchema.parse(await request.json())),
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: "invalid_terminal_commit" }, { status: 400 });
    }
    if (error instanceof AppError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    return Response.json({ error: "terminal_commit_unavailable" }, { status: 503 });
  }
}
