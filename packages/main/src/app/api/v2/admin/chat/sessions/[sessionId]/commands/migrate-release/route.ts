import { migrateChatSessionRelease } from "@/server/modules/admin-v2/commands/authoritative";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type MigrateReleaseRouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function POST(request: Request, context: MigrateReleaseRouteContext) {
  const { sessionId } = await context.params;
  return migrateChatSessionRelease(request, sessionId);
}
