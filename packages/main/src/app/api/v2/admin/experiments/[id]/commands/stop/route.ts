import { stopExperiment } from "@/server/modules/admin-v2/experiments/management";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  return adminV2Route(() => stopExperiment(request, id));
}
