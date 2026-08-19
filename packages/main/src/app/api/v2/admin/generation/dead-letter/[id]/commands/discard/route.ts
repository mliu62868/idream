import { discardGenerationDeadLetterJob } from "@/server/modules/admin-v2/generation/dead-letter";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(request, () => discardGenerationDeadLetterJob(request, id));
}
