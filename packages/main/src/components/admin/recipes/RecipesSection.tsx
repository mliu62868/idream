"use client";
import type { AdminSubview } from "@/components/admin/nav-config";
import { RecipesListPage } from "./RecipesListPage";
import { RecipesDetailPage } from "./RecipesDetailPage";
import { RecipesNewPage } from "./RecipesNewPage";

// SPEC: generation/recipes 的子视图路由 —— list / new / detail 三件套（spec §6.1）。
export function RecipesSection({ view }: { view: AdminSubview }) {
  if (view.kind === "new") return <RecipesNewPage />;
  if (view.kind === "detail") return <RecipesDetailPage id={view.id} />;
  return <RecipesListPage />;
}
