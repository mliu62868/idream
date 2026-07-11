"use client";
import type { AdminSubview } from "@/components/admin/nav-config";
import { OfficialListPage } from "./OfficialListPage";
import { OfficialDetailPage } from "./OfficialDetailPage";
import { OfficialNewPage } from "./OfficialNewPage";

// SPEC: content/official 的子视图路由 —— list / new / detail 三件套（spec §6.1）。
export function OfficialSection({ view }: { view: AdminSubview }) {
  if (view.kind === "new") return <OfficialNewPage />;
  if (view.kind === "detail") return <OfficialDetailPage id={view.id} />;
  return <OfficialListPage />;
}
