import {
  createCmsPage,
  listCmsPages,
  patchCmsPage,
} from "@/server/modules/admin-v2/cms/pages";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(request, () => listCmsPages(request));
}

export function POST(request: Request) {
  return adminV2Route(request, () => createCmsPage(request));
}

export function PATCH(request: Request) {
  return adminV2Route(request, () => patchCmsPage(request));
}
