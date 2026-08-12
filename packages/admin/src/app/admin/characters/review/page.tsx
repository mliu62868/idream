import { adminRouteMetadata, renderAdminRoute, type AdminSearchParams } from "../../_server/render-admin-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = adminRouteMetadata("Character Review");

export default function CharacterReviewPage({ searchParams }: { searchParams: AdminSearchParams }) {
  return renderAdminRoute(["characters", "review"], searchParams);
}
