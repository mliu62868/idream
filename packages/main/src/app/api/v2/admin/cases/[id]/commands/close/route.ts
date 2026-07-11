import { closeCase } from "@/server/modules/admin-v2/commands/authoritative";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CloseRouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: CloseRouteContext) {
  const { id } = await context.params;
  return closeCase(request, id);
}
