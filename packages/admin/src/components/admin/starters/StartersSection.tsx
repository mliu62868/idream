"use client";
import type { AdminSubview } from "@/components/admin/nav-config";
import { StartersListPage } from "./StartersListPage";
import { StartersDetailPage } from "./StartersDetailPage";
import { StartersNewPage } from "./StartersNewPage";

// SPEC: content/templates 的子视图路由 —— list / new / detail 三件套（spec §6.1）。
// INVARIANT: 页面按 content.read 可读，写控件按 content.template.write 显示；
//            AI 辅助另要 content.official.write（服务端 character-assist 的权限）。
export function StartersSection({
  view,
  canWrite,
  canAssist,
}: {
  view: AdminSubview;
  canWrite: boolean;
  canAssist: boolean;
}) {
  if (view.kind === "new") return <StartersNewPage canAssist={canAssist} canWrite={canWrite} />;
  // INVARIANT: 模板切换创建新的详情实例，草稿、确认与迟到读取不能跨 ID 沿用。
  if (view.kind === "detail") return <StartersDetailPage key={view.id} canWrite={canWrite} id={view.id} />;
  return <StartersListPage canWrite={canWrite} />;
}
