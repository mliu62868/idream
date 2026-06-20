import { randomUUID } from "node:crypto";
import { drainLocalAiPipeline } from "@/server/ai/local-pipeline";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { handle } from "@/server/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = handle(async (request) => {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;

  if (token !== env.INTERNAL_TOKEN && token !== env.CRON_SECRET) {
    throw Errors.unauthorized();
  }

  const workerId = `route-${randomUUID()}`;
  const drained = await drainLocalAiPipeline({ limit: 10, workerId });

  return {
    workerId,
    claimed: drained.claimed,
    processed: drained.processed,
  };
});
