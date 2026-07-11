import { env } from "@/server/lib/env";
import { ingestDurableServiceEvent } from "@/server/events/durable-ingest";
import { ZodError } from "zod";

export async function POST(request: Request): Promise<Response> {
  if (request.headers.get("x-internal-token") !== env.INTERNAL_TOKEN) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await ingestDurableServiceEvent(await request.json());
    return Response.json(result, { status: result.acknowledged ? 200 : 409 });
  } catch (error) {
    return error instanceof ZodError
      ? Response.json({ error: "invalid_event_envelope" }, { status: 400 })
      : Response.json({ error: "event_ingest_unavailable" }, { status: 503 });
  }
}
