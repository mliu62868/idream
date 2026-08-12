import { env } from "@/server/lib/env";
import { ingestDurableServiceEvent } from "@/server/events/durable-ingest";
import { ZodError } from "zod";
import { CHAT_TO_MAIN_EVENTS } from "@idream/shared/contracts";

export async function POST(request: Request): Promise<Response> {
  if (request.headers.get("x-internal-token") !== env.INTERNAL_TOKEN) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const event = await request.json();
    if (
      event &&
      typeof event === "object" &&
      "eventType" in event &&
      event.eventType === CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2
    ) {
      return Response.json(
        { error: "account_erasure_completion_v2_route_required" },
        { status: 409 },
      );
    }
    const result = await ingestDurableServiceEvent(event);
    return Response.json(result, { status: result.acknowledged ? 200 : 409 });
  } catch (error) {
    return error instanceof ZodError
      ? Response.json({ error: "invalid_event_envelope" }, { status: 400 })
      : Response.json({ error: "event_ingest_unavailable" }, { status: 503 });
  }
}
