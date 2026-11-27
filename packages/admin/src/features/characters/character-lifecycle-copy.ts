import { characterLifecycleOf, type CharacterLifecycle } from "@idream/shared/admin";

// SPEC: 生命周期的运营标签。归档草稿与已退役必须读得出差别：前者能恢复，后者永久。
// INVARIANT: 卡片、详情头部与批量回执用同一张表，同一个角色在三处不会叫两个名字。
export const CHARACTER_LIFECYCLE_LABELS: Readonly<Record<CharacterLifecycle, string>> = {
  draft: "Not live",
  live: "Live",
  paused: "Paused",
  archived: "Archived draft",
  retired: "Retired permanently",
};

export function characterLifecycleLabel(
  serving: { readonly state: string; readonly currentReleaseId: string | null } | null | undefined,
) {
  return CHARACTER_LIFECYCLE_LABELS[characterLifecycleOf(serving)];
}
