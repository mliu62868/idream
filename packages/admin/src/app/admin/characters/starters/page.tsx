import { adminRouteMetadata, renderAdminRoute, type AdminSearchParams } from "../../_server/render-admin-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function generateMetadata() {
  return adminRouteMetadata("Character Starters");
}

export default function CharacterStartersPage({ searchParams }: { searchParams: AdminSearchParams }) {
  return renderAdminRoute(["characters", "starters"], searchParams);
}
