# 领域文档约定

定义领域术语、设计模块边界或记录 / 修改架构决策时，按涉及范围读取已有文档：

- 仓库级关系：`CONTEXT-MAP.md` 与 `docs/adr/` 中相关 ADR。
- package 内术语与决策：对应 `packages/<context>/CONTEXT.md` 与 `packages/<context>/docs/adr/` 中相关 ADR；context 为 main、chat、gen、admin、shared。

这些文件尚未建立时直接继续，不把缺失作为阻塞，也不创建空占位。仅在本次工作已明确术语或决策、需要记录时创建；既有产品与架构文档的权威关系见根目录 [AGENTS.md](../../AGENTS.md)。

在 issue、方案和测试中使用已有领域术语；概念缺失时先核对是否已有别名。提案与现有 ADR 冲突时明确指出，不静默覆盖决策。
