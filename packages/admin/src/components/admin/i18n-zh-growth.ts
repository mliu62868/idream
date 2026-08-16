// SPEC: Growth 文案：产品健康度、漏斗与留存、实验、精选运营、公告、CMS/SEO、定价与促销。
// INTENT: 对应 nav 的 Growth 组。
// INVARIANT: key 在所有 i18n-zh-*.ts 之间互斥——同一个 key 只能有一个域文件持有；
// 由 i18n-zh-exclusivity.test.ts 强制。新增文案放它所属的域文件，不要另开「杂项」文件。
export const adminZhGrowth: Record<string, string> = {
  ", lift=": "，提升幅度=",
  ", rate=": "，比例=",
  "/ max": "/ 最大值",
  "/guides/example": "/guides/example",
  "Active immediately": "立即启用",
  "All levels": "全部级别",
  "All states": "全部状态",
  "Announcement action confirmation": "公告操作确认文本",
  "Announcement action reason": "公告操作原因",
  "Announcement create confirmation": "公告创建确认文本",
  "Another operator changed Featured before your save.": "另一位运营人员已先行修改推荐配置。",
  "Base Cost (coins)": "基础费用（金币）",
  "CMS / SEO": "CMS / SEO",
  "CMS article body JSON": "CMS 文章正文 JSON",
  "CMS edit confirmation": "CMS 编辑确认文本",
  "CMS indexing status": "CMS 索引状态",
  "CMS page confirmation": "CMS 页面确认文本",
  "CMS pages": "CMS 页面",
  "CMS publish confirmation": "CMS 发布确认文本",
  "CMS publish reason": "CMS 发布原因",
  "Canonical path (blank uses the page path)": "规范路径（留空则使用页面路径）",
  "Canonical path (optional)": "规范路径（可选）",
  "Character Serving is not live.": "角色 Serving 当前未上线。",
  "Clear pricing filters": "清除定价筛选",
  "Clear promotion filters": "清除推广筛选",
  "Code (≥4)": "兑换码（≥4）",
  "Code status": "兑换码状态",
  "Configuration check confirmation": "配置检查确认文本",
  "Configuration check failed": "配置检查失败",
  "Configuration check reason": "配置检查原因",
  "Configuration check {status}: {passed}/{total} configuration cases passed. No provider call was made.":
    "配置检查 {status}：{passed}/{total} 个配置用例通过，未调用生成供应商。",
  "Configuration version": "配置版本",
  "Configured · not live": "已配置 · 未上线",
  "Confirm CMS status change": "确认 CMS 状态变更",
  "Confirm announcement activation": "确认启用公告",
  "Confirm announcement deactivation": "确认停用公告",
  "Confirm announcement delete": "确认删除公告",
  "Confirm configuration check": "确认配置检查",
  "Confirm delete": "确认删除",
  "Confirm publish change": "确认发布变更",
  "Confirm rule key": "确认规则键",
  "Confirm update": "确认更新",
  "Conversion": "转化率",
  "Conversion Type": "转换类型",
  "Conversion target ready": "转换目标已就绪",
  "Counts are lifetime totals. Trend and conversion views can be added when time-series analytics are available.":
    "这里显示全生命周期累计值；具备时序分析后可补充趋势与转化视图。",
  "Create Pricing Rule Draft": "创建定价规则草稿",
  "Create announcement": "创建公告",
  "Create campaign images": "创建运营图片",
  "Create draft": "创建草稿",
  "Create new page draft": "创建新页面草稿",
  "Create redeem code": "创建兑换码",
  "Creating…": "创建中…",
  "Current configured IDs": "当前已配置 ID",
  "Current version": "当前版本",
  "Currently featured": "当前推荐",
  "D1 / D7 retention · invalid for decisions": "D1 / D7 留存 · 不可用于决策",
  "Deactivate": "停用",
  "Delete announcement": "删除公告",
  "Directional only · no assignment or exposure records": "仅供方向参考 · 无分配或曝光记录",
  "Draft → publish archives the previous active version; rollback restores the previous authority.":
    "草稿发布后会归档此前生效版本；回滚会恢复上一权威版本。",
  "Dreamcoins must be a whole number from 1 to 1,000,000.": "Dreamcoins 必须是 1 至 1,000,000 之间的整数。",
  "Edit CMS draft": "编辑 CMS 草稿",
  "Edit draft": "编辑草稿",
  "Experiment definitions": "实验定义",
  "Experiment key": "实验键",
  "Feature flags remain rollout monitoring and never inherit managed experiment lift.":
    "功能开关只用于放量监测，不会继承受管实验的提升结论。",
  "Featured configuration and live status": "推荐配置与实际上线状态",
  "Featured configuration saved": "推荐配置已保存",
  "Featured confirmation": "推荐位确认文本",
  "Featured curation": "推荐位编排",
  "Filter promotions": "筛选推广活动",
  "Flag Monitoring": "功能开关监测",
  "Immutable definitions · stable assignment · observed exposure · fail-closed decisions":
    "不可变定义 · 稳定分配 · 已观测曝光 · 失败关闭决策",
  "Indexing": "索引",
  "Latest authority was refreshed. Your draft remains in the fields; review it and save again to apply it.":
    "已刷新到最新权威版本；你的草稿仍保留在输入框中。确认后再次保存即可应用。",
  "Legacy v1 measures any activity inside cumulative 1/7-day windows, not exact calendar-day return. Values and export are unavailable until Metric Registry v2 is certified.":
    "旧版 v1 衡量累计 1/7 天窗口内的任意活动，并非精确自然日回访；指标注册表 v2 认证前，相关数值与导出均不可用。",
  "Lift hidden from decision use until every arm has ≥": "各实验组达到至少以下条件前，提升幅度不可用于决策：≥",
  "Link URL (optional)": "链接 URL（可选）",
  "Live featured": "实际上线推荐",
  "Loading featured content…": "正在加载推荐内容…",
  "Loading prices…": "正在加载定价…",
  "Loading redeem codes…": "正在加载兑换码…",
  "Loading referrals…": "正在加载邀请…",
  "Make private": "设为私密",
  "Managed experiment workspace": "受管实验工作区",
  "Max uses (blank=∞)": "最大使用次数（空=∞）",
  "Max uses must be a whole number from 1 to 1,000,000.": "最大使用次数必须是 1 至 1,000,000 之间的整数。",
  "Meta description": "Meta 描述",
  "Model profile id": "模型配置 ID",
  "Multiplier": "倍率",
  "Next code page": "下一页兑换码",
  "Next referral page": "下一页推荐记录",
  "No CMS pages yet.": "暂无 CMS 页面。",
  "No announcements.": "暂无公告。",
  "No configured featured characters": "尚未配置推荐角色",
  "No managed experiments yet. Create an immutable draft to begin.": "尚无受管实验；请先创建不可变草稿。",
  "Operate redeem codes and inspect referral authority through independent, server-filtered snapshots.":
    "通过独立的服务端筛选快照运营兑换码并检查推荐权威数据。",
  "Page title": "页面标题",
  "Plaintext code is used only to derive its hash and is not returned by the authority.":
    "明文兑换码只用于派生哈希，权威接口不会返回明文。",
  "Pricing & Offers": "定价与优惠",
  "Pricing Rules": "定价规则",
  "Pricing estimate unavailable:": "定价估算不可用：",
  "Pricing rule versions": "定价规则版本",
  "Profile health + configuration check": "模型健康度 + 配置检查",
  "Publication readiness": "发布就绪度",
  "Quality & lift": "质量与提升",
  "Quality:": "质量：",
  "Read only · config.pricing.write is not granted": "只读 · 尚未授予 config.pricing.write",
  "Read only · content.takedown.write is not granted": "只读 · 尚未授予 content.takedown.write",
  "Read only · growth.promo.write is not granted": "只读 · 尚未授予 growth.promo.write",
  "Redeem code confirmation": "兑换码确认文本",
  "Redeem codes": "兑换码",
  "Referral status": "推荐状态",
  "Referrals": "邀请",
  "Resolve blocker": "处理阻塞",
  "Retention cohorts (D1 / D7)": "留存 cohort（D1 / D7）",
  "Rule Key": "规则键",
  "Runtime state": "实际上线状态",
  "Save draft": "保存草稿",
  "Save featured": "保存推荐",
  "Saving creates a draft. Publication remains a separate validated action.":
    "保存只会创建草稿；发布仍是独立且需要验证的操作。",
  "Search announcements": "搜索公告",
  "Search prices": "搜索定价",
  "Search the catalog, control visibility and lifecycle state, and curate the public featured feed.":
    "搜索角色目录、控制可见性和生命周期状态，并策划公开精选信息流。",
  "Skipped invalid character IDs": "已跳过无效角色 ID",
  "Stored Featured configuration needs repair": "已存推荐配置需要修复",
  "The canonical preview below is safe and de-duplicated. Save it to repair the stored configuration.":
    "下方是已安全规范化并去重的预览。保存后即可修复历史配置。",
  "The complete server authority query returned no records.": "完整的服务端权威查询未返回记录。",
  "The configuration check validates deterministic profile and runtime fields only; it does not call a provider or generate media.":
    "配置检查仅验证确定性的模型配置与运行时字段；不会调用生成供应商，也不会生成媒体。",
  "These characters were not found or cannot be configured, so they were not saved.":
    "这些角色不存在或不可配置，因此未保存。",
  "This order is the saved configuration. A character is live featured only while the public audience authority also passes, including its primary image, Character Release, qualification, and Serving state.":
    "这里显示的是已保存的推荐顺序。只有主图、角色发布版本、上线资格与 Serving 状态同时满足公开受众条件时，角色才会实际上线推荐。",
  "This route is application-owned": "此路由由应用管理",
  "Type CLEAR": "输入 CLEAR",
  "Type featured IDs": "输入推荐角色 ID",
  "Type page path": "输入页面路径",
  "Type profile ID": "输入 profile ID",
  "Type title to confirm": "输入标题确认",
  "Unlist": "取消公开列出",
  "Use a new lowercase CMS path. Duplicate and application-owned paths are rejected.":
    "请使用新的小写 CMS 路径；重复路径和应用自有路径会被拒绝。",
  "Version, publish, and roll back customer-facing generation prices while keeping every decision auditable.":
    "对用户可见的生成价格进行版本化、发布和回滚，并确保每个决定均可审计。",
  "activity funnel": "活跃漏斗",
  "char_a, char_b": "角色 ID A，角色 ID B",
  "character id duplicate": "角色 ID 重复",
  "character id overflow": "角色 ID 超过 24 个上限",
  "cohort": "Cohort",
  "mature production exposures and guardrails pass.": "次成熟生产曝光，且护栏检查通过。",
  "noindex": "禁止索引",
  "pricing unavailable": "定价不可用",
  "redeem codes": "兑换码",
  "referrals": "推荐记录",
  "rule key, label, or ID": "规则键、标签或 ID",
  "serving not live": "Serving 未上线",
  "status change": "状态变更",
  "{value} pp": "{value} 个百分点",
  "· content": "· 内容",
  "· guardrails:": "· 护栏：",
  "· maturity:": "· 成熟度：",
  "· regression": "· 回退",
  "· significance:": "· 显著性：",
  "· state v": "· 状态 v",
  "· version": "· 版本",
  // ---- 视图组运营化改造（实验启停确认与报告 / 洞察诚实化 / 公告与 CMS 写反馈）----
  "Draft {key} created. It is not assigning traffic until you start it.":
    "草稿 {key} 已创建。在你启动之前它不会分配任何流量。",
  "Start experiment":
    "启动实验",
  "Stop experiment":
    "停止实验",
  "Starting assigns live traffic to {key} v{version}. The reason you enter is written to the audit log.":
    "启动会把线上流量分配给 {key} v{version}。你填写的理由会写进审计日志。",
  "Stopping ends live assignment for {key} v{version} and cannot be undone by restarting the same version. The reason you enter is written to the audit log.":
    "停止会终止 {key} v{version} 的线上分流，且无法通过重启同一版本撤销。你填写的理由会写进审计日志。",
  "Type the experiment key to confirm":
    "输入实验 key 以确认",
  "{key} v{version} is running.":
    "{key} v{version} 已在运行。",
  "{key} v{version} is stopped.":
    "{key} v{version} 已停止。",
  "surface.what-changed.v1":
    "surface.what-changed.v1",
  "What should change, for whom, and which metric should move":
    "改什么、对谁改、期望哪个指标发生变化",
  "Flag monitoring is unavailable for this permission set; managed experiments are still shown.":
    "当前权限看不到 flag 监控；受管实验仍然展示。",
  "Quality {quality} · maturity {maturity} · guardrails {guardrails} · significance {significance}":
    "质量 {quality} · 成熟度 {maturity} · 护栏 {guardrails} · 显著性 {significance}",
  "{metric} is {state}; observed regression {observed} pp against a {max} pp limit.":
    "{metric} 当前 {state}；实测回退 {observed} pp，上限 {max} pp。",
  "{variant}: {subjects} mature subjects, rate {rate}%, lift {lift} pp vs control, p={p}.":
    "{variant}：成熟样本 {subjects} 个，比例 {rate}%，相对对照组提升 {lift} pp，p={p}。",
  "Lift is withheld from decisions until every arm has at least {minimum} mature production exposures and all guardrails pass.":
    "在每个实验组都达到至少 {minimum} 次成熟的生产曝光、且护栏全部通过之前，提升幅度不参与决策。",
  "No funnel or cohort series exists behind this page":
    "本页背后没有漏斗或分群序列",
  "This is a contract gap, not a rendering gap: the authority this page reads returns generation health only. Nothing is being hidden from you — there is no funnel or retention series to show, and none is invented here.":
    "这是数据契约的缺口，不是渲染的缺口：本页读取的权威只返回生成健康度。没有任何东西被藏起来——根本不存在可展示的漏斗或留存序列，本页也不会编一个出来。",
  "What this page can answer today is below: per-profile generation health, and a configuration check that never calls a provider.":
    "本页今天能回答的问题在下方：按档案看生成健康度，以及一次不调用供应器的配置检查。",
  "Deleted “{title}”. It no longer shows anywhere on the site.":
    "已删除“{title}”。它不再出现在站内任何位置。",
  "Deactivated “{title}”. It is hidden from the site now.":
    "已停用“{title}”。它现在对全站隐藏。",
  "Activated “{title}”. It is visible site-wide now.":
    "已启用“{title}”。它现在对全站可见。",
  "Created “{title}”. It is live site-wide now.":
    "已创建“{title}”，并已对全站生效。",
  "Created “{title}”. Activate it when you want it on the site.":
    "已创建“{title}”。需要上站时再启用它。",
  "An in-product banner — this is the site-wide broadcast channel. Active means visible to everyone.":
    "站内 banner——这是全站广播渠道。启用即对所有人可见。",
  "The CMS page list response was incomplete.":
    "CMS 页面列表的响应不完整。",
  "The CMS page response was incomplete.":
    "CMS 页面的响应不完整。",
  "The article body must be a JSON object.":
    "文章正文必须是一个 JSON 对象。",
  "{path} is published and indexable per its indexing status.":
    "{path} 已发布，是否收录取决于它的 indexing 状态。",
  "{path} is unpublished and back to draft. It is no longer served.":
    "{path} 已下线并回到草稿，不再对外提供。",
  "Draft saved for {path}. Publishing is still a separate action.":
    "{path} 的草稿已保存。发布仍是单独的一步。",
  "Created draft {path}. It is not served until you publish it.":
    "草稿 {path} 已创建。发布之前不会对外提供。",
};
