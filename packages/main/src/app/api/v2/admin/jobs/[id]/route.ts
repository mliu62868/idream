import { getGenerationJobV2 } from "@/server/modules/admin-v2/jobs/query";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(() => getGenerationJobV2(request, id));
}
