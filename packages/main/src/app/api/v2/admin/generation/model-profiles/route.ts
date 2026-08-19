import {
  createGenerationModelProfile,
  listGenerationModelProfiles,
} from "@/server/modules/admin-v2/generation/model-profiles";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(request, () => listGenerationModelProfiles(request));
}

export function POST(request: Request) {
  return adminV2Route(request, () => createGenerationModelProfile(request));
}
