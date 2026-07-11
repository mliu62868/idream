"use client";

// SPEC: 运营图片生产工作台 —— 创意简报 → 创意方向 → 生成/审核/投放。
// INTENT: 统一原“通用批量”和“为角色生成”两条割裂路径；角色身份由服务端锁定，
//         运营只编排场景与创意方向，高级模型配置折叠在 Advanced。
import { CreativeProductionStudio } from "@/components/admin/CreativeProductionStudio";

export function ImageProductionView() {
  return <CreativeProductionStudio />;
}
