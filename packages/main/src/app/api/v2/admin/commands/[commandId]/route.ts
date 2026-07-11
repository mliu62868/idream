import { getControlPlaneCommand } from "@/server/modules/admin-v2/commands/query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CommandRouteContext = {
  params: Promise<{ commandId: string }>;
};

export async function GET(request: Request, context: CommandRouteContext) {
  const { commandId } = await context.params;
  return getControlPlaneCommand(request, commandId);
}
