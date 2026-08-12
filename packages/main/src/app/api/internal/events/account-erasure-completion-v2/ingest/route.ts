import { ZodError } from "zod";
import { env } from "@/server/lib/env";
import { ingestAccountErasureCompletionV2 } from "@/server/account-erasure-completion-v2";

export async function POST(request: Request): Promise<Response> {
  if (request.headers.get("x-internal-token") !== env.INTERNAL_TOKEN) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await ingestAccountErasureCompletionV2(
      await request.json(),
    );
    return Response.json(result, { status: result.acknowledged ? 200 : 409 });
  } catch (error) {
    return error instanceof ZodError
      ? Response.json(
          { error: "invalid_account_erasure_completion_v2" },
          { status: 400 },
        )
      : Response.json(
          { error: "account_erasure_completion_unavailable" },
          { status: 503 },
        );
  }
}
