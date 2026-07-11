import { characterReleaseMonitorRefreshRequestSchema } from "@idream/shared/admin";
import { Errors } from "@/server/lib/errors";
import { actorWithPermission } from "@/server/modules/admin/service";
import { refreshCharacterReleaseMonitor } from "@/server/modules/admin-v2/characters/workspace";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; releaseId: string; window: string }> },
) {
  const { id, releaseId, window } = await context.params;
  return adminV2Route(async () => {
    await actorWithPermission(request, "character.release.review", { characterId: id });
    if (window !== "24h" && window !== "72h") throw Errors.badRequest("Monitor window must be 24h or 72h");
    const body = characterReleaseMonitorRefreshRequestSchema.parse(await request.json());
    return refreshCharacterReleaseMonitor({
      characterId: id,
      releaseId,
      expectedVersion: body.entityVersion,
      window,
    });
  });
}
