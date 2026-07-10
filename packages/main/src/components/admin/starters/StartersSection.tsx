"use client";
import type { AdminSubview } from "@/components/admin/nav-config";
import { StartersListPage } from "./StartersListPage";
import { StartersDetailPage } from "./StartersDetailPage";
import { StartersNewPage } from "./StartersNewPage";

// SPEC: content/templates 的子视图路由 —— list / new / detail 三件套（spec §6.1）。
export function StartersSection({ view }: { view: AdminSubview }) {
  if (view.kind === "new") return <StartersNewPage />;
  if (view.kind === "detail") return <StartersDetailPage id={view.id} />;
  return <StartersListPage />;
}
