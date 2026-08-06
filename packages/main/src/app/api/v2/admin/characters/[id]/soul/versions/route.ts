import { characterSoulVersionCreateResponseSchema } from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { requireMatchingProjectVersion } from "@/server/modules/admin-v2/characters/project-version";
import { createCharacterSoulVersion } from "@/server/modules/admin-v2/characters/soul-version";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return adminV2Route(request, async () => {
    const { id } = await context.params;
    const actor = await actorWithPermission(request, "character.project.write", { characterId: id });
    const body = await jsonBody(request, "characterSoulVersionCreateRequestSchema+idempotency-key+if-match");
    requireMatchingProjectVersion(request, body.entityVersion);
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    const result = await executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "character.soul.version.create",
      target: { type: "character", id },
      payload: body,
      mutate: (tx) => createCharacterSoulVersion({
        characterId: id,
        expectedProjectVersion: body.entityVersion,
        expectedContentVersionId: body.expectedContentVersionId,
        actor,
        persona: body.persona,
        reason: body.reason,
        requestId,
      }, tx),
      decorateResult: (stored, replayed) =>
        characterSoulVersionCreateResponseSchema.parse({
          ...(stored as Record<string, unknown>),
          replayed,
        }),
    });
    return Response.json({ ok: true, data: result }, { status: 201 });
  });
}
