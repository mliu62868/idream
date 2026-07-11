import { assignExperimentRequest } from "@/server/modules/admin-v2/experiments/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ key: string }> }) {
  const { key } = await context.params;
  return assignExperimentRequest(request, key);
}
