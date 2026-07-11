import { retryFailedCreativeRun } from "@/server/modules/admin-v2/commands/authoritative";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RetryFailedRouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: RetryFailedRouteContext) {
  const { id } = await context.params;
  return retryFailedCreativeRun(request, id);
}
