import {
  createGenerationRecipe,
  listGenerationRecipes,
} from "@/server/modules/admin-v2/generation/catalog";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(request, () => listGenerationRecipes(request));
}

export function POST(request: Request) {
  return adminV2Route(request, () => createGenerationRecipe(request));
}
