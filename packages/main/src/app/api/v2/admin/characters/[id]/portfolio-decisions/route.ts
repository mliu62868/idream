import { recordCharacterPortfolioDecision } from "@/server/modules/admin-v2/characters/portfolio";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return adminV2Route(async () => {
    const { id } = await context.params;
    return recordCharacterPortfolioDecision(request, id);
  });
}
