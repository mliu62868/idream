import { z } from "zod";
import { Errors } from "@/server/lib/errors";
import { proposeCharacterRelease } from "@/server/modules/admin-v2/characters/release-lifecycle";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

const bodySchema = z.object({ entityVersion: z.number().int().positive(), qaEvidenceRef: z.string().trim().min(1).max(500), reason: z.string().trim().min(3).max(2_000), confirmation: z.string().trim().min(1) }).strict();
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const body = bodySchema.parse(await request.json());
    if (body.confirmation !== `${id}:propose-release`) throw Errors.badRequest("Confirmation did not match Release proposal target");
    return proposeCharacterRelease({ request, characterId: id, expectedProjectVersion: body.entityVersion, qaEvidenceRef: body.qaEvidenceRef, reason: body.reason });
  });
}
