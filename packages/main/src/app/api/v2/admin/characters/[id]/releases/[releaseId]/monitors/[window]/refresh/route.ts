import {
  characterReleaseMonitorRefreshRequestSchema,
  characterReleaseMonitorRefreshResultSchema,
} from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { refreshCharacterReleaseMonitor } from "@/server/modules/admin-v2/characters/workspace";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; releaseId: string; window: string }> },
) {
  const { id, releaseId, window } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "character.release.review", { characterId: id });
    if (window !== "24h" && window !== "72h") throw Errors.badRequest("Monitor window must be 24h or 72h");
    const body = characterReleaseMonitorRefreshRequestSchema.parse(await request.json());
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    return executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "character.release.monitor.refresh",
      target: { type: "character_release", id: releaseId },
      expectedVersion: body.entityVersion,
      payload: { ...body, window },
      mutate: async (tx) => characterReleaseMonitorRefreshResultSchema.parse(
        await refreshCharacterReleaseMonitor({ characterId: id, releaseId, expectedVersion: body.entityVersion, window, actor, requestId }, tx),
      ),
    });
  });
}
