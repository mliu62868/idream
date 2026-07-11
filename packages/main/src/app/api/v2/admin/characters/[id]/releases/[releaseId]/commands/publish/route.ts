import { publishCharacterRelease } from "@/server/modules/admin-v2/commands/authoritative";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PublishRouteContext = {
  params: Promise<{ id: string; releaseId: string }>;
};

export async function POST(request: Request, context: PublishRouteContext) {
  const { id, releaseId } = await context.params;
  return publishCharacterRelease(request, id, releaseId);
}
