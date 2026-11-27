// SPEC: 角色上线后，运营默认的心智是「改草稿 → 发布才生效」。凡是绕过 Release、立即影响线上
//       的动作，都在动作所在的位置和发布页用同一句话标出来。
// INVARIANT: 这几处共用同一个 i18n key —— 文案一旦各写一份，运营就会以为它们的生效方式不同。
export const CHARACTER_IMMEDIATE_EFFECT_COPY =
  "Takes effect immediately for new conversations. Not part of a Release.";

/** 全平台默认声音的编辑入口（平台配置页的 Voice defaults 页签）。 */
export const PLATFORM_VOICE_DEFAULTS_HREF = "/admin/ops/profiles?tab=voice";

/** 角色工作区的深链；tab 取值与 characterWorkspaceTabFromSearch 保持一致。 */
export function characterWorkspaceTabHref(
  characterId: string,
  tab: "voice" | "assets" | "video",
) {
  return `/admin/characters/${encodeURIComponent(characterId)}?tab=${tab}`;
}
