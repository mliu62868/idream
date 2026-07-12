import { createCharacterQaRun } from "@/server/modules/admin-v2/characters/qa";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return adminV2Route(async () => Response.json({
    ok: true,
    data: await createCharacterQaRun(request, id, await request.json()),
  }, { status: 201 }));
}
