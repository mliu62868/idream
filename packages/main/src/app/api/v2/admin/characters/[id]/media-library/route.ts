import {
  characterMediaLibraryListResponseSchema,
  characterMediaLibraryMutationResponseSchema,
} from "@idream/shared/admin";
import {
  createCharacterMediaLibraryEntry,
  listCharacterMediaLibrary,
} from "@/server/modules/character-media-library/admin-service";
import {
  actorWithPermission,
  jsonBody,
  queryParams,
  requireActorPermission,
} from "@/server/modules/admin-v2/shared/authority";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return adminV2Route(request, async () => {
    const { id } = await context.params;
    await actorWithPermission(request, "character.project.read", { characterId: id });
    const query = queryParams(request, "GET /api/v2/admin/characters/:id/media-library");
    return characterMediaLibraryListResponseSchema.parse(
      await listCharacterMediaLibrary({ characterId: id, query }),
    );
  });
}

export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return adminV2Route(request, async () => {
    const { id } = await context.params;
    const actor = await actorWithPermission(request, "character.project.write", { characterId: id });
    const body = await jsonBody(request, "POST /api/v2/admin/characters/:id/media-library");
    if (body.status === "published") {
      await requireActorPermission(request, actor, "character.release.publish", { characterId: id });
    }
    return characterMediaLibraryMutationResponseSchema.parse(
      await createCharacterMediaLibraryEntry({
        characterId: id, actor, body,
        idempotencyKey: requireIdempotencyKey(request),
        requestId: request.headers.get("x-request-id")?.trim() || crypto.randomUUID(),
      }),
    );
  });
}
