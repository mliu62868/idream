// SPEC: System 文案：审批、团队访问、审计日志、开发登录。
// INTENT: 对应 nav 的 System 组。
// INVARIANT: key 在所有 i18n-zh-*.ts 之间互斥——同一个 key 只能有一个域文件持有；
// 由 i18n-zh-exclusivity.test.ts 强制。新增文案放它所属的域文件，不要另开「杂项」文件。
export const adminZhSystem: Record<string, string> = {
  // 权限覆盖面板：提交前把「这个人现在有什么、改完变成什么」讲清楚。
  "An existing {effect} override is already recorded for this capability; applying a new one replaces it.":
    "这个能力上已经有一条 {effect} 覆盖；再执行一次会替换掉它。",
  "Applying this gives the user the capability.": "执行后该用户获得这项能力。",
  "Applying this removes the override and hands the decision back to the role.":
    "执行后删除该覆盖，把决定权交回角色。",
  "Applying this takes the capability away.": "执行后收回这项能力。",
  "Checking what this user can do today…": "正在查询该用户当前的权限…",
  "Could not read this user's current permissions. The change below still applies as written.":
    "读取该用户当前权限失败。下面的变更仍会按原样执行。",
  "Enter a user ID to see what they can do today.": "输入用户 ID 即可查看其当前权限。",
  "No override is recorded for this capability yet; the role decides it today.":
    "这个能力上还没有覆盖，目前由角色决定。",
  "There is no override to remove, so nothing changes.": "没有可删除的覆盖，执行后不会有任何变化。",
  "This user can already do it. Applying this pins the capability on with an override that outlives any role change.":
    "该用户已经有这项能力。执行后会加一条覆盖把它钉死，之后改角色也收不回。",
  "This user cannot do it today, so applying this only pins it off.":
    "该用户目前没有这项能力，执行后只是把它钉为禁止。",
  "already has this capability": "已具备该能力",
  "does not have this capability": "不具备该能力",
  "{count} capabilities in total": "共 {count} 项能力",
  "Access authority refresh failed:": "访问权限权威刷新失败：",
  "Access restored for {user}": "已恢复 {user} 的访问",
  "Access suspended for {user}": "已封禁 {user} 的访问",
  "Actor ID": "操作人 ID",
  "Approval authority refresh failed:": "审批权威刷新失败：",
  "Approval authority ·": "审批权威 ·",
  "Audit authority events": "审计权威事件",
  "Check profile configuration {id}": "检查配置 {id}",
  "Clear access filters": "清除访问筛选",
  "Clear approval filters": "清除审批筛选",
  "Clear audit filters": "清除审计筛选",
  "Command context": "命令上下文",
  "Configuration check finished for {id}": "{id} 的配置检查已完成",
  "Customer generations go back to the previously active profile version from now on.": "从现在起客户生成回到上一个启用的配置版本。",
  "Disable feature flag {key}": "关闭功能开关 {key}",
  "Disable profile {id}": "停用配置 {id}",
  "Enable feature flag {key}": "开启功能开关 {key}",
  "Every new customer generation runs on this profile from now on, and the previous active version is archived. A rollback restores it; images already produced are not regenerated.": "从现在起客户的每一次新生成都走这个配置，上一个启用版本会被归档。回滚能把它请回来；已经出过的图不会重新生成。",
  "Exact action": "精确操作",
  "Feature flag {key} disabled": "功能开关 {key} 已关闭",
  "Feature flag {key} enabled": "功能开关 {key} 已开启",
  "Filter approvals": "筛选审批",
  "Filter users": "筛选用户",
  "Generate test image on {id}": "用 {id} 出一张测试图",
  "Generations stop routing to this profile immediately. Re-enabling it is a second edit on this same profile.": "生成会立即不再路由到这个配置。重新启用就是在同一个配置上再改一次。",
  "Grant, revoke, or clear one effective permission without changing the user role.":
    "在不改变用户角色的情况下，授予、撤销或清除一项有效权限。",
  "Loading team access…": "正在加载团队权限…",
  "Loading approvals…": "正在加载审批…",
  "Loading audit log…": "正在加载审计日志…",
  "Next approval page": "下一页审批",
  "Next user page": "下一页用户",
  "Pending approvals": "待审批",
  "Permission effect": "权限操作",
  "Permission key": "权限键",
  "Permission override": "权限覆盖",
  "Permission override applied to {user}": "已为 {user} 应用权限覆盖",
  "Permission override unavailable · user.role.write is not granted":
    "权限覆盖不可用 · 尚未授予 user.role.write",
  "Permission user ID": "权限用户 ID",
  "Profile {id} disabled": "配置 {id} 已停用",
  "Profile {id} published": "配置 {id} 已发布",
  "Profile {id} rolled back": "配置 {id} 已回滚",
  "Publish profile {id}": "发布配置 {id}",
  "Queue test image": "排队出测试图",
  "Read only · admin.approval.review is not granted": "只读 · 尚未授予 admin.approval.review",
  "Reason (≥3, for audit)": "原因（≥3 字符，用于审计）",
  "Reason for audit": "审计原因",
  "Record what is visible. Approval requires every quality check and an identity score of at least {minimum}.":
    "按实际画面记录审核结果；通过审核需要所有质量检查通过，且身份一致性评分不低于 {minimum}。",
  "Restore access for {user}": "恢复 {user} 的访问",
  "Retry access": "重试访问权限加载",
  "Retry approvals": "重试审批加载",
  "Review high-risk requests from the complete approval authority; requester separation and required permissions remain server-enforced.":
    "基于完整审批权威数据审核高风险请求；申请人隔离和所需权限继续由服务端强制执行。",
  "Rollback profile {id}": "回滚配置 {id}",
  "Search audit log": "搜索审计日志",
  "Search users, apply narrowly scoped permission overrides, and suspend or restore access through audited commands.":
    "搜索完整用户权威数据，应用精确范围的权限覆盖，并通过审计命令暂停或恢复访问。",
  "Search users": "搜索用户",
  "Status change unavailable · user.status.write is not granted":
    "状态变更不可用 · 尚未授予 user.status.write",
  "Suspend access for {user}": "封禁 {user} 的访问",
  "Test image queued as {id}": "测试出图已排队，任务 {id}",
  "The account can sign in and spend again straight away.": "该账号可以立即重新登录和消费。",
  "The account is signed out and blocked from spending straight away. Restoring it is one click from this same row.": "该账号会立即被登出并禁止消费。恢复只需在这一行再点一次。",
  "The complete approval authority query returned no work.": "完整的审批权威查询未返回待处理工作。",
  "The flag flips for live traffic on the next request. Flipping it back is one more click on this same row.": "开关会在下一次线上请求时生效。改回去只需在这一行再点一次。",
  "The override takes effect on the user's next request. Applying the opposite effect reverses it.": "覆盖会在该用户下一次请求时生效。再应用一次相反的效果就能改回去。",
  "The profile is validated against the runtime. Nothing customer-facing changes.": "只是拿运行时校验一遍这个配置，不改变任何面向客户的东西。",
  "This runs a real generation: {count} image on {runner}, queued behind customer work. It debits no Dreamcoins, and the queued job cannot be recalled once dispatched.": "这会跑一次真实生成：在 {runner} 上出 {count} 张图，和客户的任务排同一条队。不扣梦币；任务一旦派发就无法撤回。",
  "Trace consequential operator decisions to the actor, target, reason, request, and command evidence that produced them.":
    "追溯重要运营决定对应的操作人、目标、原因、请求和命令证据。",
  "action, target, reason, or request": "操作、目标、原因或请求",
  "an unnamed job": "未命名任务",
  "operator ID": "运营人员 ID",
  "{effect} the permission for: {capability}": "{effect}权限：{capability}",
};
