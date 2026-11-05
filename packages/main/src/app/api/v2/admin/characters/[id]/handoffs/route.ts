import { countSelectableCharacterImages, recordCharacterHandoff } from "@/server/modules/admin-v2/characters/handoff";
import { executeAdminMutation } from "@/server/modules/admin-v2/shared/admin-mutation";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return adminV2Route(request, () =>
    executeAdminMutation("POST /api/v2/admin/characters/:id/handoffs", request, {
      params: { id },
      resource: { characterId: id },
      target: () => ({ type: "character", id }),
      prepare: () => countSelectableCharacterImages(id),
      mutate: (tx, { actor, body, requestId }, selectableImageCount) =>
        recordCharacterHandoff({
          tx,
          request,
          actor,
          requestId,
          characterId: id,
          note: body.note ?? null,
          selectableImageCount,
        }),
    }),
  );
}
