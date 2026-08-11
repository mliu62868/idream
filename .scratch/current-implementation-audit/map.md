# 核清 iDream 当前实现的真实状态

Label: wayfinder:map

## Notes

目标是在 `master` 的当前 revision 上建立可复现的实现真相，不在调查过程中顺手修复，也不把历史截图、旧测试结果或文档声明当作当前证据。

每个后续 session 都应使用 Wayfinder，并按需要使用 Grilling、Domain Modeling、Diagnosing Bugs 与 Playwright／应用内浏览器。涉及真实页面的票必须取得浏览器证据；浏览器不可用时应明确阻塞，不能用 API 或独立 Playwright 替代“当前操作旅程已验证”的结论。

审计以以下权威顺序校准事实：

1. 产品意图：`docs/product/PRD.md`、`ProductFeatureMap.md`、`BackendFeatureSpec.md` 及专项产品文档。
2. 架构约束：`docs/architecture/`。
3. 实现状态声明：`docs/product/CURRENT_FUNCTIONAL_COVERAGE.md` 与 `REMAINING_WORK_EXECUTION_PLAN.md`。
4. 最终实现事实：`packages/main/prisma/schema.prisma`、`packages/main/prisma/manual/`、`db/sql/` 与 `packages/*/src`。

所有结论必须明确区分四层证据：

- 文档声明：某能力被写成“已落地”或“可用”，尚未由当前 revision 复验。
- 仓库实现：权威代码、契约、迁移和测试存在，且边界一致。
- 当前可运行：当前 revision 的测试、构建、只读探针或本地真实旅程以退出码／可观察结果通过。
- 已生产上线：有目标环境迁移、provider、cutover、canary 与观察窗口证据；不得从本地通过推断。

站立约束：保护并行 WIP；数据库模式变化只产出 SQL／迁移交给用户执行；运行态核验默认只读；审批、采用、Release、Publish 与 Serving 是不同权威；生成链以 Request → Attempt → TransportExecution → immutable TerminalRecord → Artifact／Delivery／Settlement 为准；Soul 以 immutable ContentVersion／Release pin 为权威，`SOUL.md` 不是独立运行时权威。

基线锚点：建图时仓库为 `master` revision `1fb5d544fc8cd5630a8bcd33e1e8cc25cbb982cc`，工作树干净。后续若 revision 改变，票的 Answer 必须记录实际 revision，不能混合不同 revision 的证据。

## Decisions so far

<!-- 已解决票的结论索引写在这里；细节只保留在对应票的 Answer。 -->

- [建立当前 revision 的可复现验证基线](issues/01-current-revision-verification-baseline.md) — `master@1fb5d544` 的 tests、强制冷执行 lint/typecheck/build、组合 check、PM2 配置与 diff 完整性全部通过；此结论只证明仓库 gate，不外推运行态或生产上线。
- [核对功能覆盖声明与当前代码权威](issues/02-reconcile-coverage-claims-with-code.md) — 核心五包权威链存在，但当前状态文档混入了已退休 pipeline/sd.cpp、旧 billing/路由语义、已删文件和过期版本／迁移计数；生产与当前操作旅程仍必须由后续票据实。
- [审计跨服务权威与故障恢复闭环](issues/03-audit-cross-service-authority-and-recovery.md) — Generation、Chat/Soul、Voice、Release/Serving 与 Admin UI 的仓库级单写权威和恢复守卫成立；已复现并修复 Main↔Chat 双向 Outbox 的并发状态回退，失败使用精确 pending/attempt CAS，receiver durable ACK 单调胜出，双向并发回归与完整 check 通过。

## Fog

- 只有事实矩阵完成后，才能看清应修复哪些代码、删掉哪些过期路径，以及修复工作的真实依赖顺序。
- 生产数据库、外部 provider、公开域名和正式 cutover 的可验证范围取决于调查时可用的只读环境与凭据；无法验证的部分必须保持为未知，而不是自动判失败或成功。
- 文档已确认需要“收敛现行摘要 + 隔离历史附录”，而不是继续叠 correction 注释；但最终回写范围仍要等运行、provider 与浏览器票的当前证据汇总。
- 审计暴露的产品取舍、性能目标与上线优先级，需在事实和缺口明确后再毕业为独立决策票。
