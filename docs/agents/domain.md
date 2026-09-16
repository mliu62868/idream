# 领域文档约定

定义领域术语、设计模块边界或记录 / 修改架构决策时，按涉及范围读取已有文档：

- 仓库级术语：根目录 [CONTEXT.md](../../CONTEXT.md)（角色创作、发布运营与 Companion Chat 的统一语言）。
- 架构决策：[docs/architecture/](../architecture/README.md) 下按编号组织的 ADR，索引见该目录 README。本仓库不按 package 分设 CONTEXT.md 或 ADR 目录。

既有产品与架构文档的权威关系见根目录 [AGENTS.md](../../AGENTS.md)。新增术语或决策时写进上述两处，不创建平行目录。

在 issue、方案和测试中使用已有领域术语；概念缺失时先核对是否已有别名。提案与现有 ADR 冲突时明确指出，不静默覆盖决策。
