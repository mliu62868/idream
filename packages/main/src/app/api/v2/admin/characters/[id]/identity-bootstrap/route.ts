import {
  characterIdentityBootstrapRequestSchema,
  characterIdentityBootstrapResponseSchema,
} from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { bootstrapCharacterIdentity } from "@/server/modules/admin-v2/characters/identity-bootstrap";
import { requireMatchingProjectVersion } from "@/server/modules/admin-v2/characters/project-version";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "character.project.write", { characterId: id });
    const body = characterIdentityBootstrapRequestSchema.parse(await request.json());
    requireMatchingProjectVersion(request, body.entityVersion);
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    const result = await executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "character.identity.bootstrap",
      target: { type: "character", id },
      expectedVersion: body.entityVersion,
      payload: body,
      mutate: (tx) => bootstrapCharacterIdentity({
        characterId: id,
        actor,
        requestId,
        request: body,
        tx,
      }),
      decorateResult: (value, replayed) => ({
        ...record(value),
        replayed,
      }),
    });
    return characterIdentityBootstrapResponseSchema.parse(result);
  });
}
