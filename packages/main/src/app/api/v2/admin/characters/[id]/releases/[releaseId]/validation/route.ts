import { characterReleaseValidationRequestSchema } from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { validateCharacterRelease } from "@/server/modules/admin-v2/characters/release-lifecycle";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string; releaseId: string }> }) {
  const { id, releaseId } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "character.release.publish", { characterId: id });
    const body = characterReleaseValidationRequestSchema.parse(await request.json());
    if (body.confirmation !== `${id}:${releaseId}:validate`) {
      throw Errors.badRequest("Confirmation did not match Release validation target");
    }
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    return executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "character.release.validate",
      target: { type: "character_release", id: releaseId },
      expectedVersion: body.entityVersion,
      payload: body,
      mutate: (tx) => validateCharacterRelease({
        request,
        actor,
        requestId,
        characterId: id,
        releaseId,
        expectedVersion: body.entityVersion,
      }, tx),
    });
  });
}
