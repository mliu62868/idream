import { listFailedIncidentCorrelationOutboxEvents } from "@/server/modules/admin-v2/incidents/correlation-outbox";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(request, () =>
    listFailedIncidentCorrelationOutboxEvents(request));
}
