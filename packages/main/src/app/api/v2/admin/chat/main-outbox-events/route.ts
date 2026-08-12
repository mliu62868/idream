import { listFailedMainToChatOutboxEvents } from "@/server/modules/admin-v2/chat/main-outbox-events";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(request, () => listFailedMainToChatOutboxEvents(request));
}
