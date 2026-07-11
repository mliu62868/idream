import { createSavedViewV2, listSavedViewsV2 } from "@/server/modules/admin-v2/collaboration/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) { return adminV2Route(() => listSavedViewsV2(request)); }
export function POST(request: Request) { return adminV2Route(() => createSavedViewV2(request)); }
