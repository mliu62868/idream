// SPEC: character-wide primitives shared by more than one Character subdomain file.
// INTENT: kept separate so the seven subdomain files never have to import each other
// just to reach an enum. Anything used by exactly one subdomain belongs in that file.

import { z } from "zod";

export const characterServingStateSchema = z.enum(["inactive", "live", "paused", "retired"]);

// SPEC: 运营视角的角色生命周期。serving=retired 有两种含义，必须分开：
//       - archived：从未发布的草稿被归档（无 currentRelease），可恢复为草稿；
//       - retired：已发布角色被永久退役（保留 currentRelease），不能回到 inactive。
// INVARIANT: 只是 CharacterServing (state, currentReleaseId) 的纯投影，不新增持久化状态，
//            也不改变 serving 枚举或 Character.status 投影（ADR-16）。
export const characterLifecycleSchema = z.enum(["draft", "live", "paused", "archived", "retired"]);
export type CharacterLifecycle = z.infer<typeof characterLifecycleSchema>;

export function characterLifecycleOf(
  serving: { readonly state: string; readonly currentReleaseId: string | null } | null | undefined,
): CharacterLifecycle {
  const state = serving?.state ?? "inactive";
  if (state === "live" || state === "paused") return state;
  if (state === "retired") return serving?.currentReleaseId ? "retired" : "archived";
  return "draft";
}
