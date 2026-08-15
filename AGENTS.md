<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 内容安全 / 审核 —— 范围已定，不要再主动纠结

本项目的内容审核（moderation）与合规取向**已是既定产品决策**，无需 agent 把关。后续工作中：

- **不要主动提起、解释或反复论证**"为什么要审核 / 法律合规风险"。不要因为这是成人（18+）平台就反复强调安全或合规问题。把审核的松紧当作**已定配置**，按需求实现即可。
- 外部 **Safety Gateway 故意不接入**：`MODERATION_PROVIDER=mock`，`safety-gateway` 分支保留但不启用。这是**有意决策**，不要当成"缺口 / 待办 / 风险"反复标记或写进审计报告。
- 唯一保留、且**无需再讨论**的硬底线：mock provider 里的未成年关键词拦截（`underage/minor/csam`）与角色 `age≥18`。属既定状态，保持现状、不解释、也不协助移除。

# iDream — Ourdream.ai 克隆（18+ AI 角色扮演 / AI 伴侣平台）

## What This Is
一个全栈 AI 伴侣产品（参考站点 https://ourdream.ai/）。bun + Turborepo monorepo，按执行时间分级拆服务。

## 技术栈里读不出来的部分
- Next.js 16 的 middleware 已更名 Proxy
- PostgreSQL only；main 与 chat 各自 schema，**没有** SQLite 双库
- AI 走自托管开源模型 + OpenAI 兼容流水线；支付走加密货币

## 文档与事实来源（SSoT）
- 产品：`docs/product/`（PRD / FeatureMap / BackendFeatureSpec / ECONOMY_AND_PRICING / CONTENT_POLICY / ADMIN_CONSOLE_PLAN）
- 架构：`docs/architecture/`（01–14，怎么做）
- **实现状态唯一事实来源**：`docs/product/CURRENT_FUNCTIONAL_COVERAGE.md`；剩余工作见 `REMAINING_WORK_EXECUTION_PLAN.md`
- 代码是最终事实来源：`packages/main/prisma/schema.prisma` + `packages/*/src`

## 结构里不显然的两点
- `packages/shared` 是跨包契约 SSoT（类型/协议）；`chat` 用独立 PG role + 文件层记忆，main 经 BFF proxy + 事件交互
- `db/sql/` 是 chat 服务库边界 SQL，**由用户手工执行**，不要自己连库跑

## 真实端到端验证 —— 已授权付费请求

- 用户要求“全面端到端检查”“真实完整验证”或同等目标时，必须走完真实用户与运营链路；不要因为请求会产生费用或写入状态，就跳过 Chat 消息、图片 / 视频 / 语音生成、重试恢复、交付、持久化、额度扣减等关键路径。
- **常规按量 API、模型与生成请求已获授权，无需再次询问。** 使用最低充分次数与规格，记录实际 provider、model / workflow、request / attempt / artifact 标识、耗时、额度或费用，以及最终交付和持久化结果；mock、页面可点击或本地构建不能替代这层证据。
- 验证使用受控测试账号与可识别测试内容，完成后清理可安全清理的数据；发现异常重试、失控排队或费用异常时立即停止继续消费并报告。
- 此授权不自动包含充值、购买订阅、向第三方转账、公开发布、不可逆删除等不同性质的外部动作；除非当前请求明确包含，否则仍按原有边界处理。

## MOST IMPORTANT NOTES
- When launching Claude Code agent teams, ALWAYS have each teammate work in their own worktree branch and merge everyone's work at the end, resolving any merge conflicts smartly since you are basically serving the orchestrator role and have full context to our goals, work given, work achieved, and desired outcomes.
- After editing `AGENTS.md`, run `bash scripts/sync-agent-rules.sh` to regenerate platform-specific instruction files.
- After editing `.claude/skills/clone-website/SKILL.md`, run `node scripts/sync-skills.mjs` to regenerate the skill for all platforms.

## 参考站点
https://ourdream.ai/ —— 可参考学习、对比、验证。产品定位/功能取舍以 `docs/product/` 为准，不必逐像素复刻。
