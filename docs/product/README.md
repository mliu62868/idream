# iDream 产品文档

更新日期：2026-09-05

文档入口：仓库级索引见 [`../README.md`](../README.md)。本目录的契约文档优先于历史审计、方案和研究记录。

**iDream 是全面对标 OurDream.ai 的 18+ AI 角色扮演与 AI 伴侣平台。** 产品范围覆盖发现、创建、聊天、图片/视频/语音、个人资产、社区、付费、联盟和帮助内容；长期关系是其中的重要体验。

| 要回答的问题 | 权威文档 | 维护边界 |
| --- | --- | --- |
| 为谁服务、提供什么价值、先交付什么？ | [PRD](PRD.md) | 定位、目标需求、阶段和度量 |
| 功能出现在哪里、覆盖哪些任务？ | [功能地图](ProductFeatureMap.md) | 信息架构与能力库存 |
| 用户怎样完成任务、什么算通过？ | [用户故事](UserStory.md) | 正常、异常、恢复和跨域验收 |
| 与对标目标还差什么？ | [对标矩阵](PRODUCT_PARITY_MATRIX.md) | 需求/故事映射、证据入口、差距与退出条件 |
| 已经做到什么？ | [当前覆盖](CURRENT_FUNCTIONAL_COVERAGE.md) | 带日期与版本的实现及运行证据 |
| 接下来实施什么？ | [剩余工作](REMAINING_WORK_EXECUTION_PLAN.md) | 未完成工作及依赖，不重复记录完成项 |
| 费用和权益如何承诺？ | [经济规格](ECONOMY_AND_PRICING.md) | 货币、预付访问、费率与退款 |
| 后台怎样支持这些任务？ | [后台规格](BackendFeatureSpec.md) | 目标契约；实现权威另见代码及架构 |
| Chat 的用户行为和 Turn 契约是什么？ | [Chat PRD](CHAT_SERVICE_PRD.md) | 产品行为、PreparedTurn 与交付边界；执行架构以 ADR-21 为准 |
| 角色图片生成怎样保持一致？ | [图片生成系统](CHARACTER_IMAGE_GENERATION_SYSTEM.md) | 当前目标流程、状态与跨服务不变量 |
| 竞品事实来自哪里？ | [9 月 1 日快照](../research/OURDREAM_PRODUCT_PARITY_SNAPSHOT_2026-09-01.md)、[9 月 5 日复核](../research/OURDREAM_PRODUCT_REVIEW_2026-09-05.md) | 区分公开页面、官方声称与实际运行 |

修改需求时同步对应故事、功能地图与矩阵；经济承诺只在经济规格维护数值。只更新文档不改写完成度。P0/P1 是交付优先级，不能当作“已实现/未实现”；本地成功也不能当作公开生产认证。
