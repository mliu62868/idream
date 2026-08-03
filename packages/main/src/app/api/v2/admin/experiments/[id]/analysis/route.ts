import { getExperimentAnalysis } from "@/server/modules/admin-v2/experiments/analysis";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return adminV2Route(request, async () => {
    const { id } = await context.params;
    return getExperimentAnalysis(request, id);
  });
}
