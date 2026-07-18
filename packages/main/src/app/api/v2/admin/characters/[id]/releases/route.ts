import { characterReleaseProposalRequestSchema } from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { proposeCharacterRelease } from "@/server/modules/admin-v2/characters/release-lifecycle";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { requireMatchingProjectVersion } from "@/server/modules/admin-v2/characters/project-version";
import { characterReleaseContract } from "@/server/modules/admin-v2/characters/character-release-contract";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "character.release.propose", { characterId: id });
    const body = characterReleaseProposalRequestSchema.parse(await request.json());
    requireMatchingProjectVersion(request, body.entityVersion);
    if (body.confirmation !== `${id}:propose-release`) throw Errors.badRequest("Confirmation did not match Release proposal target");
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    return executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "character.release.propose",
      target: { type: "character", id },
      expectedVersion: body.entityVersion,
      payload: body,
      mutate: (tx) => proposeCharacterRelease({ request, actor, requestId, characterId: id, expectedProjectVersion: body.entityVersion, qaRunId: body.qaRunId, reason: body.reason }, tx),
      decorateResult: (result) => characterReleaseContract(result),
    });
  });
}
