import { adminRouteMetadata, renderAdminRoute, type AdminSearchParams } from "../../_server/render-admin-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = adminRouteMetadata("New Character");

export default function NewCharacterPage({ searchParams }: { searchParams: AdminSearchParams }) {
  return renderAdminRoute(["characters", "new"], searchParams);
}
