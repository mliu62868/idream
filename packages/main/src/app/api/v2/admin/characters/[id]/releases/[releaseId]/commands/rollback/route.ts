import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { rollbackCharacterRelease } from "@/server/modules/admin-v2/commands/authoritative";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RollbackRouteContext = {
  params: Promise<{ id: string; releaseId: string }>;
};

export async function POST(request: Request, context: RollbackRouteContext) {
  const { id, releaseId } = await context.params;
  return adminV2Route(request, () => rollbackCharacterRelease(request, id, releaseId));
}
