import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { scheduleCharacterRelease } from "@/server/modules/admin-v2/commands/authoritative";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ScheduleRouteContext = {
  params: Promise<{ id: string; releaseId: string }>;
};

export async function POST(request: Request, context: ScheduleRouteContext) {
  const { id, releaseId } = await context.params;
  return adminV2Route(request, () => scheduleCharacterRelease(request, id, releaseId));
}
