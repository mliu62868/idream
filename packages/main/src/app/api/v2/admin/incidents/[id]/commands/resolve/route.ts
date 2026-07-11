import { resolveIncident } from "@/server/modules/admin-v2/commands/authoritative";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ResolveRouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: ResolveRouteContext) {
  const { id } = await context.params;
  return resolveIncident(request, id);
}
