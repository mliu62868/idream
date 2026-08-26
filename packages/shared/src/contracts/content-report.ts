import { z } from "zod";

// SPEC: 用户提交举报时必须选一个理由，取值只能是这份集合。它是三处共用的同一张表：
//       main 的举报弹窗、main 的举报接口校验、admin 审核队列的分类列。
// INTENT: 只按「内容运营真会分流到不同处置」的维度切，不做穷举分类学。说不清的一律落到
//         other_prohibited_content —— 人工在队列里读用户补充说明比多十个类目有用。
// INVARIANT: 未成年理由的字面值必须含子串 "underage"。服务端按它判 priority 1 与自动下架，
//            改名会静默废掉那条链路 —— content-report.test.ts 钉死了这一点。
export const CONTENT_REPORT_REASONS = [
  "underage_content",
  "nonconsensual_real_person",
  "harassment_or_hate",
  "spam",
  "quality",
  "other_prohibited_content",
] as const;

export const contentReportReasonSchema = z.enum(CONTENT_REPORT_REASONS);
export type ContentReportReason = z.infer<typeof contentReportReasonSchema>;

/** 用户没选时的兜底，也是历史数据里最常见的取值。 */
export const DEFAULT_CONTENT_REPORT_REASON: ContentReportReason =
  "other_prohibited_content";

/**
 * 举报是否命中未成年分支（priority 1 + 自动下架）。
 * 对历史/非枚举取值同样有效 —— 库里存的旧 category 也要能判出来。
 */
export function isUnderageReportReason(category: string) {
  return category.includes("underage");
}
