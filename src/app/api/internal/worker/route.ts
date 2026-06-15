import { randomUUID } from "node:crypto";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { handle } from "@/server/lib/http";
import { jobQueue } from "@/server/jobs/queue";

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
  const claimed = await jobQueue.claim({ limit: 10, workerId });

  return {
    workerId,
    claimed: claimed.map((job) => ({
      id: job.id,
      queue: job.queue,
      status: job.status,
    })),
  };
});
