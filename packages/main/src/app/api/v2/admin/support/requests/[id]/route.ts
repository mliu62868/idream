import { getSupportRequestConversation, patchSupportRequest } from "@/server/modules/admin-v2/support/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(request, () => getSupportRequestConversation(request, id));
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(request, () => patchSupportRequest(request, id));
}
