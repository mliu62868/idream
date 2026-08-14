import {
  incidentCorrelationOutboxAttemptMissingDiscardResultSchema,
  type IncidentCorrelationOutboxAttemptMissingDiscardRequest,
} from "@idream/shared/admin";
import { discardAttemptMissingIncidentCorrelationOutboxEvent } from "@/server/modules/admin-v2/incidents/correlation-outbox";
import { executeAdminMutation } from "@/server/modules/admin-v2/shared/admin-mutation";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request) {
  return adminV2Route(request, () =>
    executeAdminMutation<IncidentCorrelationOutboxAttemptMissingDiscardRequest>(
      "POST /api/v2/admin/incidents/correlation-outbox/commands/discard-attempt-missing",
      request,
      {
        params: {},
        permission: "ops.incident.manage",
        target: ({ body }) => ({
          type: "incident_correlation_outbox_event",
          id: body.id,
        }),
        mutate: (tx, context) =>
          discardAttemptMissingIncidentCorrelationOutboxEvent(
            {
              body: context.body,
              actor: context.actor,
              requestId: context.requestId,
            },
            tx,
          ),
        decorateResult: (stored, replayed) =>
          incidentCorrelationOutboxAttemptMissingDiscardResultSchema.parse({
            ...(stored as Record<string, unknown>),
            replayed,
          }),
      },
    ),
  );
}
