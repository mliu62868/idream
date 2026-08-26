// SPEC: 哪些举报目标类型真的能被「处置」。
// INTENT: 举报提交端对 targetType 是**故意宽松**的自由字符串（`modules/ourdream/reports.ts:20-28`
//         有注释说明这是有意的），而裁定端只实现了三类 ——
//         `applyModerationAction` 在 `admin-v2/moderation/moderation-effect.ts` 里只认
//         `character`(:145) / `media`(:149) / `feed_item`(:201)，其余一律
//         `throw Errors.badRequest("Unsupported moderation target type")`(:213)。
//         而 `decision.ts:240` 在 decision === "actioned" 时调它，抛错会让**整个事务回滚**：
//         ModerationReview 不落、report.status 不改、Case 决定不写、审计不写。
//         实测本地 6 条真实 open 举报里有 1 条是 `chat_message`（另有若干条同类是队友的审计探针，
//         已排除）—— 审核员点「处置」，敲完确认串、写完原因，拿到一个 400，队列一动不动。
//         而主站每一条聊天消息上都有举报按钮且提交返回 200，所以这个数字只会涨。
// INVARIANT: 这份清单必须和 moderation-effect.ts 的三个分支逐字一致。多写一个，就是把审核员
//            送回那个 400；少写一个，就是把本来能收口的活藏起来。

export const ACTIONABLE_REPORT_TARGET_TYPES = ["character", "media", "feed_item"] as const;

/** 这条举报能不能落 `actioned`。不能的话只剩「关闭」这一条路。 */
export function canActionReportTarget(targetType: string) {
  return (ACTIONABLE_REPORT_TARGET_TYPES as readonly string[]).includes(targetType);
}
