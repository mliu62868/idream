import {
  characterProjectCreateResponseSchema,
} from "@idream/shared/admin";
import { Errors } from "@/server/lib/errors";
import { canCreateCharacterProjects } from "@/server/admin/effective-permissions";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { createCharacterProject } from "@/server/modules/admin-v2/characters/creation";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request) {
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "character.project.write");
    if (!await canCreateCharacterProjects(actor.id, actor.role)) {
      throw Errors.forbidden("Creating Characters requires global Character Project write permission", {
        permission: "character.project.write",
        reason: "global_scope_required",
      });
    }
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) throw Errors.badRequest("Idempotency-Key is required");
    const body = await jsonBody(request, "characterProjectCreateRequestSchema+idempotency-key");
    const result = characterProjectCreateResponseSchema.parse(await createCharacterProject({
      actor,
      request: body,
      idempotencyKey,
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    }));
    return Response.json({ ok: true, data: result }, { status: result.replayed ? 200 : 201 });
  });
}
