import { env } from "@/server/lib/env";
import {
  createCharacterQaRun,
  prepareCharacterQaEvidence,
} from "@/server/modules/admin-v2/characters/qa";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { requireMatchingProjectVersion } from "@/server/modules/admin-v2/characters/project-version";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "character.release.review", { characterId: id });
    const body = await jsonBody(request, "characterQaRunCreateRequestSchema+idempotency-key+if-match");
    requireMatchingProjectVersion(request, body.entityVersion);
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    const data = await executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "character.qa.run.create",
      target: { type: "character", id },
      expectedVersion: body.entityVersion,
      payload: body,
      prepare: () => prepareCharacterQaEvidence(id, body.entityVersion),
      mutate: (tx, preparedEvidence) => createCharacterQaRun(request, id, body, {
        tx,
        actor,
        requestId,
        preparedEvidence,
      }),
    });
    return Response.json({ ok: true, data }, { status: 201 });
  });
}
