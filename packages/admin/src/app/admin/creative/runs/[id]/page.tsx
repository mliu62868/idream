import { adminRouteMetadata, renderAdminRoute, type AdminSearchParams } from "../../../_server/render-admin-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function generateMetadata() {
  return adminRouteMetadata("Creative Run Detail");
}

export default async function CreativeRunDetailPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: AdminSearchParams;
}) {
  const { id } = await params;
  return renderAdminRoute(["creative", "runs", id], searchParams);
}
