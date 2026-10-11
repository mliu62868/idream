import { adminRouteLabel, adminRouteMetadata, renderAdminRoute, type AdminSearchParams } from "../../../_server/render-admin-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function generateMetadata({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: AdminSearchParams }) {
  const { id } = await params;
  return adminRouteMetadata(adminRouteLabel(["ops", "incidents", id], await searchParams));
}

export default async function IncidentDetailPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: AdminSearchParams;
}) {
  const { id } = await params;
  return renderAdminRoute(["ops", "incidents", id], searchParams);
}
