import { changeCharacterServingState } from "@/server/modules/admin-v2/commands/authoritative";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { const { id } = await context.params; return changeCharacterServingState(request, id, "retire"); }
