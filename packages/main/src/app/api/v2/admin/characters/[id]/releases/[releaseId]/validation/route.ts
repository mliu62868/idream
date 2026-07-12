import { z } from "zod";
import { Errors } from "@/server/lib/errors";
import { validateCharacterRelease } from "@/server/modules/admin-v2/characters/release-lifecycle";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

const bodySchema = z.object({
  entityVersion: z.number().int().positive(),
  confirmation: z.string().trim().min(1),
}).strict();

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string; releaseId: string }> }) {
  const { id, releaseId } = await context.params;
  return adminV2Route(async () => {
    await actorWithPermission(request, "character.release.publish", { characterId: id });
    const body = bodySchema.parse(await request.json());
    if (body.confirmation !== `${id}:${releaseId}:validate`) {
      throw Errors.badRequest("Confirmation did not match Release validation target");
    }
    return validateCharacterRelease({
      request,
      characterId: id,
      releaseId,
      expectedVersion: body.entityVersion,
    });
  });
}
