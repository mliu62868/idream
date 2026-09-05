# Admin 角色后端权威与恢复审计

日期：2026-09-05。检查 HEAD：`bae20386f636bfb59389829d8574063f5339263d`；工作区存在其他任务改动，本报告是当次源码与命令证据，不是该 Git 提交的清洁构建认证。

## 结论

创建、素材评审、草稿选图、Release 与 Serving 的权威划分成立。创建原子地写 private/draft/inactive 角色及内容版本、审计与 outbox；原 key + request hash + advisory lock 避免重复创建。导入图片和生成图片具有不同且有效的来源资格分支，不能把导入图片误判为必须具有 generation lineage。

仍有两个 P2 运营闭环缺口：已准备 Release 没有放弃路径；图片库最新 100 张截断且归档过滤发生在截断后。

## 已复证：approved 候选无法放弃或替换

发布界面 `packages/admin/src/features/characters/ReleasePanel.tsx:331–365` 分两次请求 prepare 和 publish。prepare 已成功但 publish 失败或操作者退出后，数据库保留 approved 候选。

- `packages/main/src/server/modules/admin-v2/shared/state-transition-authority.ts:49–55`：approved 唯一出口是 published，不能 withdrawn 或 superseded。
- `packages/main/src/server/modules/admin-v2/characters/release-lifecycle.ts:140–147`：已有 approved 就拒绝准备另一 Release。
- `packages/main/src/server/modules/admin-v2/characters/asset-studio.ts:111–130`：有 approved 就拒绝换图。
- `packages/main/src/server/modules/admin-v2/characters/reference-set.ts:60–67`：有 approved 就拒绝修改参考集，但错误文案提供了实际不存在的 Withdraw 路径。
- `packages/main/src/server/modules/admin-v2/characters/release-executor.ts:322–335`：验证失败只把 readiness 改为 blocked；`938–952` 结束失败 command，未废弃 approved 候选。
- 对 `packages/main/src`、`packages/shared/src/admin` 的撤回、取消、supersede 路径进行了精确扫查，没有发现另一个 approved 取消入口。

专用测试库探针：`release-recovery-probe.ts` / `release-recovery-probe.log`。实际调用产品服务，在同一个最后主动回滚的 PostgreSQL 事务中创建最小 approved fixture，逐项得到：

| 操作 | 实际结果 |
| --- | --- |
| 换图片 | 409，active Release pins immutable image set |
| 准备替代候选 | 409，already has a Release ready to publish |
| approved → withdrawn | 409，transition not allowed |
| approved → superseded | 409，transition not allowed |
| 更换参考集 | 409，Withdraw or finish the active Character Release |
| 最终候选 | approved，version 1 |

探针 fixture 全部 rollback。它证明候选状态阻断及取消路径缺失，不证明真实媒体生成或整个 publish 故障链已经重演。脚本退出 0，Bun 在进程退出时额外输出 tsconfig directory mismatch 内部诊断；五个服务调用及事务回滚已在此前完成。

用户影响：正常候选可以继续 publish，因此不能概括为所有发布都会死锁。但当操作者发现候选有误，无法放弃它；固定路由失效且不能恢复时，也不能准备新候选恢复工作。建议添加有审计的“放弃待发布版本”，保留历史；验证 prepare 成功 → publish 失败 → 放弃 → 修图 → 新候选发布。

## 已核源码：图片库旧图片丢失于管理入口

`packages/main/src/server/modules/admin-v2/characters/image-sources.ts:112–118` 最新排序后 `take: 100`，再 JavaScript 过滤 archived。列表契约 `packages/shared/src/admin/contracts/characters-asset-studio.ts:122–127` 仅有 items，无 cursor。`CharacterImageLibrary.tsx:80` 与 `CharacterPlacementEditor.tsx:47` 均只使用该列表。

第 101 张起的图片无法在这些入口选用；归档最新素材会压缩可见列表且不会补足旧图片。建议先在数据库过滤归档，再提供游标分页，并覆盖 101+ 张与最新 100 张全归档两种具体风险。未向运行库批量写图复现。

## 附：视频导入质量边界

`video-sources.ts:41–56`、`:193–200` 只检查 File 大小、MIME/后缀，没有检查容器与视频流有效性。损坏文件可被接纳为导入成功。建议有效容器/可播放视频流验证。这是输入质量问题，未作为安全漏洞定性。

## 验证与隔离

运行库 `packages/main/.env`：localhost:5433 / idream_runtime_20260812。测试库：localhost:5433 / idream_test。Main global setup 有 test 名称、loopback 与独占 advisory lease 检查；本次显式 Redis DB 15，BullMQ 按测试 DB hash 生成前缀。没有修改运行库、产品代码或服务。

命令：`REDIS_URL=redis://127.0.0.1:6379/15 bun run --filter @idream/main test src/server/modules/admin-v2/characters`

结果：45 个测试文件、267 个测试全部通过，40.05 秒。标准 setup 确认重建并 seed 专用 idream_test，日志 `main-characters-test.log`。日志中的 injected image-readiness receipt failure 是故障注入测试证据，整体退出 0。

此前纯测试：5 文件、34 测试全部通过（simplified-release/readiness/character-release-contract/production-journey/image-qualification）。

本报告不声称浏览器、真实生成、完整运营发布链或公开生产就绪已通过；这些应由主审计的当前 revision 真实流程证据补齐。

## 补充复证：101 张图片与归档假空

已运行 `library-limit-probe.ts`，日志 `library-limit-probe.log`。在专用 idream_test 的单个事务中创建 101 张角色图片，实际调用 `listCharacterImageSources`；因原函数使用全局 Prisma client，探针仅临时将其 read delegate 绑定到当前真实 PostgreSQL 事务，使未提交 fixture 可见，查询与资格算法均未替换为 mock。

- 数据库有 101 张可用图片：返回 100 张，最旧一张不在返回中。
- 将最新 100 张归档，数据库仍有最旧 1 张可用图片：返回 0 张。
- 最后主动 rollback 全部 fixture，并还原 read delegates。没有重跑整库测试或重置测试库。
- Bun 同样在进程退出时输出 tsconfig directory mismatch 内部诊断；查询结果已完成，脚本退出 0。

## 运营 Run 的 costDreamcoins 与账本

`run-create.ts:669` 通过 PricingRule 计算单项价格，`:1106` 写 batch.estimatedCostDreamcoins，`:1192` 写 job.costDreamcoins。Admin 生产入口直接创建 GenerationJob / Attempt / outbox，没有调用客户生成入口的 dreamcoin debit。客户入口 `ourdream/generation-job-create.ts:569–581` 明确调用 postDreamcoinEntry(generation_spend) 并记录 reserved event。

`content-production-state.ts:148–161` 独立从 ledger 累计实际 captured/refunded；当两者都是 0 时 settlement = not_required，说明系统明确支持运营生成没有用户账本扣款。覆盖文档 `CURRENT_FUNCTIONAL_COVERAGE.md:504` 也把 production batch estimatedCostDreamcoins/costDreamcoins 描述为 PricingRule 驱动成本估算。

所以父审计观测的运营 job `cmto3qnou000og6l7qsadk6h9` completed、costDreamcoins=5、ledger=0 与现有实现一致，不能单凭该差异报告漏扣费。应报告“运营成本估算 5 dreamcoins，实际用户账本扣款 0；该运营 Run settlement 不要求扣款”。这里是依据源码解释父审计记录，没有重新查询或修改运行库。PricingRule 估算也不能冒充实际供应商现金成本。

## 生命周期补查：暂停角色和未发布草稿没有正常退役闭环

只读核查确认可列 P2：`ReleasePanel.tsx:656–683` 仅 live 展示 retire，paused 只提供 resume；`release-executor.ts:604–635` 要求 currentReleaseId、已 published Release，并将 retire 的 expectedState 固定为 live。与 `state-transition-authority.ts:68–70` 允许 inactive/paused → retired 不一致。

其他入口没有补齐官方草稿归档：`content/merchandising.ts:345` 的 setCharacterStatus 调用 rejectOfficialCharacter，官方角色不能通过通用 status API 改成 archived/removed；角色详情 API 只有 GET。审核模块确有 removed 动作，但它记录 moderation decision/effect，不应把正常运营废弃草稿伪装成违规内容处置。archiveCharacterLook 只归档 look，不归档角色。

影响：暂停角色要先恢复上线才能退役，不符合停用角色不应再次上线的直觉；从未发布的 private/inactive 官方草稿无法正常放弃，长期积累测试/废弃条目。

本轮最小安全清理建议：保持审计角色 private/inactive，确认没有活跃生成请求；若图片仍作为 identity/reference/draft 依赖，保留它们及审计记录，不手工改 Serving、project.activeKey 或 deletedAt，不为清理而先发布。可在正常草稿编辑里标注 audit/inactive 便于识别，但这只是隔离与识别，不应声称已归档。要彻底移除，应先实现真正的 inactive/paused retire 命令，并在同一权威事务里处理 Serving、Character 投影、Project activeKey、审计/outbox 与依赖校验；当前分析任务不应临时绕过该缺失。
