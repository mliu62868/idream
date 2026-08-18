// SPEC: 纯查表层 —— 不带 "use client"，服务端也能调。
// INTENT: 这些函数只是字典查找，从来不需要 React。它们过去和 Provider/Hook 同住一个
//         "use client" 文件里，于是 generateMetadata 这类服务端代码一调就报
//         「Attempted to call translateAdmin() from the server」。本轮为此撞了四次墙
//         （404 页、authority 不可用页、外壳早期的 getStoredAdminLocale、标签页标题），
//         每次都是各自绕开；这次从根上分开。
// INVARIANT: i18n.tsx 继续 re-export 这里的全部导出，所以既有调用点一行都不用改。

import { adminZhCharacters } from "./i18n-zh-characters";
import { adminZhCommon } from "./i18n-zh-common";
import { adminZhCreative } from "./i18n-zh-creative";
import { adminZhCustomers } from "./i18n-zh-customers";
import { adminZhDashboard } from "./i18n-zh-dashboard";
import { adminZhGrowth } from "./i18n-zh-growth";
import { adminZhPlatformOps } from "./i18n-zh-platform-ops";
import { adminZhShell } from "./i18n-zh-shell";
import { adminZhSystem } from "./i18n-zh-system";
import type { AdminLocale } from "./shell-preferences";

export type { AdminLocale };

// SPEC: 中文文案按功能域分文件（域划分对应 nav-config.ts 的工作区分组），本文件只负责合并与查表。
// INTENT: 改一个域的文案只碰那一个域文件；不再有"新 key 该扔进哪个字母分片"的问题。
// INVARIANT: 各域文件的 key 互斥，所以下面的展开顺序不影响结果——由 i18n-zh-exclusivity.test.ts
// 强制。别再靠"排在后面就能覆盖前面"来修译文：那正是旧字母分片里四个键被静默覆盖的原因。
const zh: Record<string, string> = {
  ...adminZhCommon,
  ...adminZhShell,
  ...adminZhDashboard,
  ...adminZhCharacters,
  ...adminZhCreative,
  ...adminZhCustomers,
  ...adminZhGrowth,
  ...adminZhPlatformOps,
  ...adminZhSystem,
};

const zhValues: Record<string, string> = {
  // SPEC: 角色组合决策与线上表现的枚举值（Promote…/mature…/certified…/exact…）。
  // 走 zhValues 通道而不是 zh —— 它们是枚举，StatusBadge 与 <option> 共用同一份译文。
  Promote: "推广",
  Maintain: "维持",
  Improve: "改进",
  Retire: "下线",
  // maturity 是两个维度：immature 说的是观察窗口还没走完（时间），insufficient_data 才是
  // 窗口走完了但样本没达标（样本量）。译文混用"样本不足"会让运营把"再等等"当成"投放不够"。
  mature: "证据充分",
  immature: "观察期未到",
  "insufficient data": "样本不足",
  certified: "已核准",
  directional: "仅供参考",
  invalid: "口径异常",
  no_data: "暂无观测",
  "no data": "暂无观测",
  exact: "精确",
  partial: "部分",
  // 发布护栏状态与建议动作
  "not required": "无需处理",
  "action required": "需要处理",
  action_required: "需要处理",
  continue_monitoring: "继续观察",
  active: "启用",
  accepted: "已接受",
  actioned: "已处理",
  all: "全部",
  anime: "动漫",
  approved: "已通过",
  archived: "已归档",
  audit: "审计",
  available: "已就绪",
  blocked: "已拦截",
  built_in: "内置",
  character: "角色",
  comfyui: "ComfyUI",
  community: "社区",
  completed: "已完成",
  connected: "已连接",
  cancelled: "已取消",
  captured: "已扣款",
  closed: "已关闭",
  collection: "合集",
  configured: "已配置",
  disconnected: "未连接",
  customer: "客户",
  detected: "已发现",
  development: "开发环境",
  // AdminShellSignals.environment 的取值之一；顶栏的非生产环境提示直接把它 t() 出来。
  local: "本地环境",
  delivered: "已交付",
  draft: "草稿",
  due: "到期",
  due_today: "今日到期",
  due_soon: "即将超时",
  expired: "已过期",
  external: "外部",
  fail: "失败",
  failed: "失败",
  female: "女性",
  flagged: "已标记",
  freeplay: "自由玩法",
  generating: "生成中",
  generation: "生成",
  grant: "授予",
  revoke: "撤销",
  clear: "清除",
  hybrid: "混合",
  high: "高",
  image: "图片",
  info: "信息",
  in_progress: "进行中",
  in_review: "审核中",
  input: "输入",
  internal: "内部",
  male: "男性",
  manual_passed: "人工通过",
  medium: "中",
  mitigating: "缓解中",
  mlx: "MLX",
  missing: "缺失",
  monitoring: "监控中",
  mine: "我的",
  new: "新建",
  negative: "负向",
  not_required: "无需验证",
  // 事故处置计划的动作，以及恢复校验的未跑状态。StatusBadge 和筛选下拉都把枚举里的下划线换成
  // 空格再查表（`t(value.replaceAll("_", " "))`），所以这里存的是空格拼写，不是 retry_eligible。
  "retry eligible": "可重试",
  refund: "退款",
  "pause route": "暂停路由",
  "not checked": "未验证",
  open: "打开",
  on_track: "正常",
  other: "其他",
  output: "输出",
  overdue: "已超时",
  pending: "待处理",
  paused: "已暂停",
  pass: "通过",
  passed: "已通过",
  partially_refunded: "部分退款",
  pipeline: "流水线",
  promo: "推广",
  published: "已发布",
  produced: "已产出",
  queued: "排队中",
  recorded: "已记录",
  realistic: "写实",
  received: "已收到",
  refunded: "已退款",
  rejected: "已拒绝",
  removed: "已移除",
  required: "需要验证",
  resolved: "已解决",
  reviewing: "审核中",
  sent: "已发送",
  suspended: "已封禁",
  suppressed: "已抑制",
  succeeded: "已成功",
  trans: "跨性别",
  unlimited: "无限",
  unsupported: "不支持",
  unknown: "未知",
  verified: "已验证",
  valid: "有效",
  video: "视频",
  voice: "语音",
  warning: "警告",
  waiting_on_user: "等待用户",
  late_after_failed: "失败后迟到",
  late_after_blocked: "拦截后迟到",
  late_after_cancelled: "取消后迟到",
  late_after_refunded: "退款后迟到",
  late_after_unknown: "未知结果后迟到",
  adopt_succeeded: "采用成功结果",
  confirm_failed: "确认失败结果",
  remain_unknown: "保持结果未知",
  // generation-group redesign (task 13 zh backfill) — GenerationPreset.type / .visibility enums,
  // surfaced via value() by the presets trio (task 15).
  background: "背景",
  pose: "姿势",
  outfit: "服装",
  mode: "模式",
  private: "私密",
  public: "公开",
  unlisted: "不公开列出",
  // fix wave 1 (#1): GenerationJob.status + .ledgerState enum cells now render via value() on the
  // jobs/dead-letter ReadonlyOpsView tables. queued/completed/failed/blocked/refunded/image/video
  // already exist above; these are the remaining reachable values.
  running: "运行中",
  moderating_input: "输入审核中",
  moderating_output: "输出审核中",
  reserved: "已预留",
  staging: "预发布环境",
  test: "测试环境",
  triaged: "已分诊",
  upcoming: "即将到期",
  validating: "验证中",
  verifying: "验证中",
  waiting: "等待中",
  production: "生产环境",
  low: "低",
  critical: "严重",
  // Image library grid + detail (task 16) — MediaAsset.platformStatus "generated" (approved/
  // rejected/published/archived/draft already exist above), ContentProductionBatch.targetType
  // enum beyond "character" (already exists), and productionPurposeSchema (asset "purpose" +
  // list filter, ProductionStudioView's own local purposeOptions shares these same values).
  generated: "已生成",
  none: "无",
  route_page: "页面",
  template: "模板",
  campaign: "活动",
  character_cover: "角色封面",
  character_hero: "角色大图",
  character_chat: "角色聊天",
  feed: "信息流",
  homepage: "首页",
  seo: "SEO",
  template_cover: "模板封面",
  model_eval: "模型评测",
  // Placements trio (task 17) — placementSlotSchema slot values beyond the ones already covered
  // above (character_avatar/character_hero share the character_* purpose values; template_cover/
  // campaign are shared with productionPurposeSchema/targetType), plus placementStatusSchema's
  // "scheduled" (draft/published/paused/archived already exist above).
  character_avatar: "角色头像",
  feed_card: "信息流卡片",
  homepage_strip: "首页横条",
  seo_article: "SEO 文章",
  scheduled: "已排期",
  // —— 工单 / 案件 / SLA 枚举（cases · support · moderation）——
  // 全部取自 packages/shared/src/admin/contracts/*.ts 的真实枚举值，逐个核对过。
  // 调用点写的是 t(value.replaceAll("_"," "))，由 underscoreEnumZh 回落到这里的下划线键。
  content_report: "内容举报",
  support_request: "支持请求",
  billing_dispute: "账务争议",
  no_violation: "未违规",
  recently_resolved: "近期已解决",
  escalated: "已升级",
  // 账本原因（CoinLedger.reason）与订阅生命周期状态。走 zhValues 而不是 zh：它们是枚举，
  // 账本「原因」列、订阅「状态」列和两个筛选下拉共用同一份译文（value() / adminValueLabel）。
  // 少了它们，中文后台的账本页会把原始枚举码 admin_adjust / generation_spend 直接印给运营看。
  // 口径对齐 docs/product/ECONOMY_AND_PRICING.md §1.3 扣费时点与 §5 退款/调整表。
  signup_bonus: "注册赠币",
  subscription_grant: "订阅发放",
  subscription_refund: "订阅退款冲销",
  // 支付方退款没走成时把已冲销的梦币还回去；与 "Grant restored" → 「授予已还原」同一套说法。
  subscription_refund_restore: "订阅退款还原",
  generation_spend: "生成消耗",
  refund: "退款",
  redeem: "兑换码兑换",
  referral: "邀请奖励",
  admin_adjust: "管理员调整",
  checkout_created: "结账已创建",
  checkout_completed: "结账已完成",
  past_due: "逾期未付",
  // 注意：上面已有拼作 cancelled 的「已取消」；契约里订阅状态是单 l 的 canceled，两个都要有。
  canceled: "已取消",
  refund_pending: "退款处理中",
  // creativeRunPurposeSchema 的最后两个取值。图片库的 purpose 下拉直接 value(item) 印整张
  // 枚举，缺这两条时中文界面里就混着两行 character_video / identity_calibration。
  // seo 不补——它在下拉里印成 "SEO"，那本来就是中文运营在用的写法。
  character_video: "角色视频",
  identity_calibration: "形象校准",
  // CreativeRun 重试命令的结果三态：命令回执丢了就印 "outcome unknown"。它走 StatusBadge，
  // 而 StatusBadge 是 t(value.replaceAll("_"," "))，所以键带空格。
  "outcome unknown": "结果未知",
  // 审核评分的第三态（passed/failed 已在上面）。ReviewForm 的"更早的决定"一行把它原样印出来。
  unscored: "未评分",
  // ActorRole 全集。dev 登录墙两处印它：无权限提示里的当前角色，和快捷账号按钮的角色名。
  // （"user" 是前台用户，不是"用户名"；"admin"/"support" 等在别处也只以枚举形式出现。）
  user: "前台用户",
  moderator: "审核员",
  support: "客服",
  ops: "运维",
  analyst: "分析师",
  admin: "管理员",
  // People workspaces (support / moderation / cases / customers) 的枚举值。走 zhValues 通道，
  // 让 <option>、StatusPill 与详情页共用同一份译文；主表 zh 不重复收这些词。
  // 工单类型 / 状态 / 排序（operationsCase* schema）
  content_report: "内容举报",
  support_request: "支持工单",
  billing_dispute: "账务争议",
  appeal: "申诉",
  reopened: "已重开",
  urgent: "紧急",
  normal: "普通",
  updated_desc: "最近更新在前",
  updated_asc: "最早更新在前",
  // 工单队列视图（operationsCaseQuerySchema.view）
  unassigned: "未分配",
  appeals: "申诉",
  recently_resolved: "最近已解决",
  // 裁决与客户侧动作（CONTENT_REPORT / APPEAL / SUPPORT / BILLING 四组常量）
  no_violation: "无违规",
  duplicate: "重复举报",
  escalated: "已升级",
  upheld: "维持原判",
  overturned: "已撤销",
  modified: "已改判",
  diagnostic_reviewed: "已复核诊断",
  reply_requested: "已请求补充信息",
  incident_escalated: "已升级为事件",
  account_guidance_provided: "已提供账号指引",
  ledger_reconciled: "已对账",
  refund_requested: "已发起退款",
  subscription_corrected: "已修正订阅",
  // 下游验证状态（adminVerificationStateSchema，pending/verifying/passed/failed 已在上方）
  overridden: "已人工放行",
  // 证据的访问级别与证据强度
  full: "完整",
  redacted: "已脱敏",
  observational: "观察级",
  attribution: "归因级",
  causal: "因果级",
  // 审计条目的操作者角色（adminAuditEntrySchema.actorRole）
  operator: "运营",
  admin: "管理员",
  support: "客服",
  system: "系统",
  command_executor: "命令执行器",
  command_verifier: "命令校验器",
  verification_worker: "验证工作进程",
  // 目标对象类型（adminEntityRefSchema.type / 明文调阅的 targetType）
  user: "用户",
  message: "消息",
  media: "媒体",
  generation_job: "生成任务",
  // 举报分类与工单分类（两边都是自由字符串字段，取值来自各自的提交入口；
  // 未收录的取值 value() 原样返回，不会把数据吃掉）
  other_prohibited_content: "其他违禁内容",
  underage_content: "未成年内容",
  policy_violation: "违反政策",
  prohibited: "违禁内容",
  spam: "垃圾信息",
  quality: "质量问题",
  account: "账号问题",
  billing: "账务问题",
  technical: "技术问题",
  // 媒体复核的触发原因（moderation mediaReviewKind；blocked 已在上方）
  independent_duplicate: "独立复核重复图",
  // 权威快照新鲜度（adminFreshnessSchema）
  fresh: "最新",
  stale: "已陈旧",
  degraded: "降级",
  // 订阅计费周期（Plan.billingPeriod）
  monthly: "按月",
  yearly: "按年",
  // 币账本流水原因（CoinLedger.reason，取值见 schema.prisma 的注释）
  signup_bonus: "注册赠币",
  subscription_grant: "订阅发币",
  subscription_refund: "订阅退币",
  subscription_refund_restore: "订阅退币回补",
  generation_spend: "生成消耗",
  refund: "退款",
  redeem: "兑换码",
  referral: "邀请奖励",
  admin_adjust: "人工调整",
};

export type TranslationValues = Record<string, string | number>;

export type AdminI18nContextValue = {
  locale: AdminLocale;
  t: (key: string, values?: TranslationValues) => string;
  value: (key: string) => string;
};

function interpolate(template: string, values?: TranslationValues) {
  if (!values) return template;
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

export function translateAdmin(
  locale: AdminLocale,
  key: string,
  values?: TranslationValues,
) {
  const template =
    locale === "zh"
      ? (zh[key] ?? zhValues[key] ?? underscoreEnumZh(key) ?? translateDynamicAdminZh(key) ?? key)
      : key;
  return interpolate(template, values);
}

// SPEC: 空格形态的多词枚举回落到下划线键再查一次 zhValues。
// INTENT: 22 个调用点写的是 t(value.replaceAll("_", " ")) —— 把 in_progress 变成
//         "in progress" 再查表。但枚举译文按下划线形态存在 zhValues 里，而查表是精确匹配，
//         空格形态永远命中不了。实测后果：中文界面的 Cases 页上直接渲染出
//         content report / in progress / recently resolved / support request 四个英文徽章。
// INTENT: 修在查表层而不是 22 个调用点 —— 调用点那个写法本身没错（它要的就是"人读的形态"），
//         错的是字典只认一种形态。这样新调用点也自动受益。
// INVARIANT: 只在精确匹配全部落空后才试，绝不覆盖已有的精确译文。
function underscoreEnumZh(key: string) {
  if (!key.includes(" ")) return undefined;
  return zhValues[key.replaceAll(" ", "_")];
}

function translateDynamicAdminZh(key: string) {
  const characterCommand = /^character (.+) command is ([a-z_]+)$/i.exec(key);
  if (characterCommand) {
    const [, characterId, status] = characterCommand;
    return `角色 ${characterId} 的命令状态为 ${zhValues[status] ?? status}`;
  }

  const openSince = /^([a-z_]+) severity · open since (.+)$/i.exec(key);
  if (openSince) {
    const [, severity, since] = openSince;
    return `${zhValues[severity] ?? severity}严重程度 · 开始于 ${since}`;
  }

  return undefined;
}

// SPEC: does the Chinese locale have a real translation for `key`
// (dictionary text or a translated enum value, rather than falling back to English)?
// Used by tests to lock that a given nav/label key is actually translated, not just rendered.
export function hasAdminZh(key: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(zh, key) ||
    Object.prototype.hasOwnProperty.call(zhValues, key)
  );
}

export function adminValueLabel(locale: AdminLocale, key: string) {
  return locale === "zh" ? (zhValues[key] ?? key) : key;
}

export function adminDateLocale(locale: AdminLocale) {
  return locale === "zh" ? "zh-CN" : undefined;
}

