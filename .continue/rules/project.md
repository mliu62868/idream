<!-- AUTO-GENERATED from AGENTS.md — do not edit directly.
     Run `bash scripts/sync-agent-rules.sh` to regenerate. -->

---
description: Project conventions for the iDream OurDream-parity AI companion product
alwaysApply: true
---
# iDream 项目约定

除另有说明，路径相对于仓库根目录；生成的平台副本沿用此基准。

## 按任务定位

- 产品范围：全面对标 [OurDream.ai](https://ourdream.ai/) 的 18+ AI 角色扮演 / 伴侣平台。涉及功能取舍时读 [PRD](docs/product/PRD.md) 及相关产品契约；对标其公开功能和用户旅程，不复制内部实现，也不因当前实现缺口缩减明确需求。
- 评估完成度时从 [当前覆盖](docs/product/CURRENT_FUNCTIONAL_COVERAGE.md) 和 [剩余工作](docs/product/REMAINING_WORK_EXECUTION_PLAN.md) 入手；架构问题按 [架构索引](docs/architecture/README.md) 定位相关 ADR。文档记录需求与决策，代码及同一 source revision 的运行证据证明实际状态；冲突须说明，不凭代码现状废除业务要求。
- Main 的 PostgreSQL 是产品 Turn、交付与计费权威，经 BFF 向 Chat 交付不可变 Turn 快照；Chat 无数据库，本地 AgentRun 仅承载执行与恢复证据，DSH/igrep 内嵌于 Chat。跨包契约放在 `packages/shared`，Chat 内部执行协议留在 `packages/chat`；改动这些边界时读 [ADR-21](docs/architecture/21-companion-chat-deep-runtime.md)。
- Chat 使用自托管开源 OpenAI-compatible 模型；图片/视频使用 Gen workflow-native backend，现存 legacy external pipeline 兼容保留；支付走加密货币。
- 创建或维护 issue / PRD 时使用 `.scratch/` 本地 Markdown，遵循 [事项追踪](docs/agents/issue-tracker.md) 和 [分诊状态](docs/agents/triage-labels.md)，不要把 Skill 的“发布到 tracker”默认解释为外部发帖。涉及领域术语或 ADR 时才读 [领域文档约定](docs/agents/domain.md)。

## 已定边界

- 内容审核是既定产品配置：`MODERATION_PROVIDER=mock`，保留但不启用 `safety-gateway`；不把它列为缺口或重新论证审核政策。保留 mock 的 `underage/minor/csam` 拦截与角色 `age ≥ 18`。
- 本项目开发库和专用测试库的任务内 schema / 数据变更已获授权，可直接执行 migration、必要的 `db/sql/` 导入 / cutover SQL，以及测试库重建 / seed，无需再确认；执行前核对目标连接与隔离。此项目授权覆盖通用的“schema 变更由用户执行”限制，不延伸到生产库或任务外的数据清理。
- 已获授权的服务启停或模式切换使用 [README](README.md) 中的 PM2 wrapper；不要绕过其 drain / readiness / ownership 拒绝。复杂恢复按 [运维手册](docs/architecture/10-operations.md) 对应流程执行。

## 实施与验证

<!-- BEGIN:nextjs-agent-rules -->
- 修改 Main / Admin 的 Next.js 框架用法前，读取对应 package 下 `node_modules/next/dist/docs/` 的相关章节，例如 `packages/main/node_modules/next/dist/docs/`；根目录没有该路径。Next.js 16 使用 `proxy.ts`，留意安装版本的弃用说明。
<!-- END:nextjs-agent-rules -->

- 命令以根目录及目标 package 的 `package.json` 为准，使用 Bun workspace 脚本；强制 CI 检查见 [.github/workflows/ci.yml](.github/workflows/ci.yml)。本地验证按改动风险选择，证据充分后结束；纯指令 / 文档改动核对引用、命令、diff 和生成文件，不自动触发全仓构建、数据库测试或真实生成。
- Main 默认 `test` / `coverage` 会重建并 seed 专用测试库，属于上述授权；同库测试串行，运行前核对数据库和 Redis 隔离。仅当目标用例已被 [纯测试配置](packages/main/vitest.pure.config.ts) 覆盖且不依赖数据库时，可用 `bun run --filter @idream/main test:pure`；不能用它代替必需的集成验证。
- 仅当独立子任务能明显改善效率或质量时使用并行 agent，不固定人数、拆分粒度或轮次。Claude Code 的写入型队友各用独立 worktree，完成后整合到当前任务分支并处理冲突；只读子任务无需为隔离写入创建 worktree。

## 真实端到端验证

- 用户要求“全面端到端检查”“真实完整验证”或同等目标时，走完任务范围内真实用户与运营链路，覆盖 Chat、图片 / 视频 / 语音、重试恢复、交付、持久化及额度扣减。mock、页面可点击或构建通过不能替代这些证据。
- 此类验证的常规按量 API、模型与生成请求已获授权，无需再确认；使用最低充分次数与规格，记录实际 provider、model / workflow、request / attempt / artifact 标识、耗时、额度或费用及交付、持久化结果。证据绑定所测 source revision，区分受控本地验证与公开生产就绪。
- 使用受控测试账号和可识别内容，完成后清理可安全清理的数据；异常重试、失控排队或费用异常时停止继续消费并报告。除上述开发 / 测试库变更外，授权不包含充值、购买订阅、第三方转账、公开发布或不可逆删除，除非用户明确包含这些动作。

## 指令维护

- 项目共享规则以本文件为源；修改后运行 `bash scripts/sync-agent-rules.sh`。`CLAUDE.md` 只保留导入，生成的规则文件不手改。
- 修改克隆网站 Skill 时编辑 `.claude/skills/clone-website/SKILL.md`，运行 `node scripts/sync-skills.mjs`；该脚本未覆盖 `.agents` 副本，另执行 `cp .claude/skills/clone-website/SKILL.md .agents/skills/clone-website/SKILL.md` 并核对一致。
