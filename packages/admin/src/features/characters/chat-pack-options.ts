// SPEC: 聊天素材预生成包的可选项 —— 由调用方从角色已有的权威推出，不让运营手填 profile key / 图片 ID。
// INTENT: 纯数据推导单独成模块，mock 掉 CharacterChatLibrary 的测试仍能拿到它。
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";

/** 预生成包可用的生成 profile —— 由调用方从角色已有的合格线路推出，不让运营手填。 */
export type ChatPackProfileOption = { readonly key: string; readonly label: string };
/** 视频包的源图 —— 角色已有、可用的图片素材。 */
export type ChatPackSourceOption = {
  readonly assetId: string;
  readonly label: string;
  readonly labelValues?: Readonly<Record<string, string | number>>;
  readonly url: string;
  readonly thumbnailUrl: string | null;
};

/**
 * SPEC: 图片包只能用对这个角色身份合格、且未过期的生成线路；每个 profile key 只列一次。
 * INTENT: 原来是一个手填的 profile key 输入框，填错要等提交后被服务端拒绝才知道。
 */
export function chatPackImageProfiles(data: Pick<CharacterWorkspaceDetail, "visual">): ChatPackProfileOption[] {
  const options = new Map<string, ChatPackProfileOption>();
  for (const route of data.visual.routeQualifications) {
    if (route.result !== "qualified" || route.stale || options.has(route.generationProfileKey)) continue;
    options.set(route.generationProfileKey, {
      key: route.generationProfileKey,
      label: `${route.generationProfileKey} · v${route.generationProfileVersion}`,
    });
  }
  return [...options.values()];
}
