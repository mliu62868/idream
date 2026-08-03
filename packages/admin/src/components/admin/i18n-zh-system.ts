// SPEC: System 文案：审批、团队访问、审计日志、开发登录。
// INTENT: 对应 nav 的 System 组。
// INVARIANT: key 在所有 i18n-zh-*.ts 之间互斥——同一个 key 只能有一个域文件持有；
// 由 i18n-zh-exclusivity.test.ts 强制。新增文案放它所属的域文件，不要另开「杂项」文件。
export const adminZhSystem: Record<string, string> = {
  "Access authority refresh failed:": "访问权限权威刷新失败：",
  "Actor ID": "操作人 ID",
  "Approval authority refresh failed:": "审批权威刷新失败：",
  "Approval authority ·": "审批权威 ·",
  "Audit authority events": "审计权威事件",
  "Clear access filters": "清除访问筛选",
  "Clear approval filters": "清除审批筛选",
  "Clear audit filters": "清除审计筛选",
  "Command context": "命令上下文",
  "Exact action": "精确操作",
  "Filter approvals": "筛选审批",
  "Filter users": "筛选用户",
  "Grant, revoke, or clear one effective permission without changing the user role.":
    "在不改变用户角色的情况下，授予、撤销或清除一项有效权限。",
  "Loading access authority": "正在加载访问权限权威",
  "Loading approval authority": "正在加载审批权威",
  "Loading audit authority": "正在加载审计权威",
  "Next approval page": "下一页审批",
  "Next user page": "下一页用户",
  "Pending approvals": "待审批",
  "Permission effect": "权限操作",
  "Permission key": "权限键",
  "Permission override": "权限覆盖",
  "Permission override unavailable · user.role.write is not granted":
    "权限覆盖不可用 · 尚未授予 user.role.write",
  "Permission user ID": "权限用户 ID",
  "Read only · admin.approval.review is not granted": "只读 · 尚未授予 admin.approval.review",
  "Reason (≥3, for audit)": "原因（≥3 字符，用于审计）",
  "Reason for audit": "审计原因",
  "Record what is visible. Approval requires every quality check and an identity score of at least {minimum}.":
    "按实际画面记录审核结果；通过审核需要所有质量检查通过，且身份一致性评分不低于 {minimum}。",
  "Retry access": "重试访问权限加载",
  "Retry approvals": "重试审批加载",
  "Review high-risk requests from the complete approval authority; requester separation and required permissions remain server-enforced.":
    "基于完整审批权威数据审核高风险请求；申请人隔离和所需权限继续由服务端强制执行。",
  "Search audit authority": "搜索审计权威数据",
  "Search the complete user authority, apply narrowly scoped permission overrides, and suspend or restore access through audited commands.":
    "搜索完整用户权威数据，应用精确范围的权限覆盖，并通过审计命令暂停或恢复访问。",
  "Search users": "搜索用户",
  "Status change unavailable · user.status.write is not granted":
    "状态变更不可用 · 尚未授予 user.status.write",
  "The complete approval authority query returned no work.": "完整的审批权威查询未返回待处理工作。",
  "Trace consequential operator decisions to the actor, target, reason, request, and command evidence that produced them.":
    "追溯重要运营决定对应的操作人、目标、原因、请求和命令证据。",
  "action, target, reason, or request": "操作、目标、原因或请求",
  "operator ID": "运营人员 ID",
};
