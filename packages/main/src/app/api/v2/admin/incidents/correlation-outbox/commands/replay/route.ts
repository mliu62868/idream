import {
  incidentCorrelationOutboxReplayResultSchema,
  type IncidentCorrelationOutboxReplayRequest,
} from "@idream/shared/admin";
import { replayFailedIncidentCorrelationOutboxEvents } from "@/server/modules/admin-v2/incidents/correlation-outbox";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { executeAdminMutation } from "@/server/modules/admin-v2/shared/admin-mutation";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request) {
  return adminV2Route(request, () =>
    executeAdminMutation<IncidentCorrelationOutboxReplayRequest>(
      "POST /api/v2/admin/incidents/correlation-outbox/commands/replay",
      request,
      {
        params: {},
        permission: "ops.incident.manage",
        target: ({ body }) => ({
          type: "incident_correlation_outbox_batch",
          id: canonicalSha256(body.events),
        }),
        mutate: (tx, context) =>
          replayFailedIncidentCorrelationOutboxEvents(
            {
              body: context.body,
              actor: context.actor,
              requestId: context.requestId,
            },
            tx,
          ),
        decorateResult: (stored, replayed) =>
          incidentCorrelationOutboxReplayResultSchema.parse({
            ...(stored as Record<string, unknown>),
            replayed,
          }),
      },
    ),
  );
}
