import {
  createAnnouncement,
  listAdminAnnouncements,
} from "@/server/modules/admin-v2/announcements/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(request, () => listAdminAnnouncements(request));
}

export function POST(request: Request) {
  return adminV2Route(request, () => createAnnouncement(request));
}
