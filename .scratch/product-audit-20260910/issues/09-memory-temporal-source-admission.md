# 修复时间注释导致的跨会话记忆投影阻塞

Type: task
Priority: P0
Status: resolved
Requirements: CH-03、CH-04、ADR-21
Resolution: 已验收（受控本地真实链路，2026-09-10）。
Implementation: 工作区修复、自动投影恢复及新会话自然召回均已验证，不要重复实施。

真实 Chrome 旅程中，Lola 已在旧会话正确回应植物名 Cedar、蓝色厨房窗台；普通归档后新会话 Memory on 却称用户从未告知。两个 Turn 均已在 Main 持久化，普通归档不排除记忆。新 Turn 的 wake 和 memory-search 各一次、零命中。

原因是 Main 投影 outbox `a4a453cc-107c-48a5-94cd-8824f5b20749` 自 2026-09-10 01:07:55 UTC 起反复 prepare 400，检查时已有 11 次尝试。Chat 错误为 `dialogue_source_mismatch`：官方 igrep 0.1.137 把 `today` 的搜索视图写为 `today（2026-09-10）`，仍以 `source_content` 完整保留原文；现有校验误把搜索视图当作原文。canonical 因而一直为空。

**已实施与验证**

- [igrep.ts](/Users/kk/code/idream/packages/chat/src/agent-runtime/igrep.ts) 校验原文及严格的时间注释插入形状；保留 Main 完整原文比对、维护前后字节比较、撤回拒绝和最多一次 fresh ingest。执行策略 8→9。
- 3 个官方样例先在原错误处失败；修复后 56 项相关测试、Chat typecheck、diff 检查通过。含中文/emoji、伪造 source_content、非法注释及维护改写。
- 两个真实会话共 4 条冻结 Main 消息在隔离官方 ingest 中通过；主动停在模型维护之前，模型请求为 0。不是完整运行验收。
- 证据：[诊断](/Users/kk/code/idream/.tmp/product-audit-20260910/memory-projection-diagnosis.md)、[回放结果](/Users/kk/code/idream/.tmp/product-audit-20260910/memory-ingest-replay.json)。基准 HEAD `9ce5e5da3362dc397eb73b7f72a621141740fd4b` 加本轮工作区改动。

**实际验收**

1. 开发 watch 自动加载修复后，原 outbox 在第 13 次尝试于 **01:48:01.684 UTC** 交付，lastError=null。canonical 切换到 `projection-1-9af665d5-0225-4262-9998-3ecedd98f6b2`，两个会话的 4 条角色、完整原文和来源时间逐条与 Main 一致；未修改业务数据或重签旧证据。
2. 新会话 `d2bde3f5-4b42-4fca-bafe-9b7da1fb6acf` 的 Turn `cde19570-b966-4ff5-9d06-66608fc745e6` 对原样问题准确回答：`Cedar. He sits on the blue kitchen windowsill.`。正式 Ornith 请求 `chatcmpl-ca0ddbbc` 从接纳到 Main sent 为 **3.539 秒**，wake/memory-search 各 1 次命中、0 失败。
3. 运行实例 `36d11741-a3f1-43c0-ad86-fc7f4f3f8c84`、profile digest `cf1c7c0996f96ecf9bf225c62c458aaddcd12cc14222892c02c86a43016ef879` 与策略 9 的受控本地样本已记录。验收不外推为生产认证、长期记忆质量或未重跑的全部控制旅程。

[只读恢复与真实召回证据](/Users/kk/code/idream/.tmp/product-audit-20260910/memory-live-recovery.json)包含具体检查时间、文件 SHA-256、投影与模型请求标识；[Chrome 截图](/Users/kk/code/idream/.scratch/product-audit-20260910/screenshots/11-memory-recalled.jpg)留存实际回答。

## Comments

- 2026-09-10：代码修复与隔离回归完成，服务重启及自然召回由主任务统一执行。本项区别于对话模型的语义能力问题，也不将普通归档变更为清除记忆。
- 2026-09-10 01:53 UTC：开发 watch 已自动重启；只读确认原投影完成，主任务通过真实 Chrome 新会话确认 Cedar 与蓝色厨房窗台准确召回。状态更新为 resolved / 已验收。
