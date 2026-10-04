# iDream 产品与功能文档

更新日期：2026-10-04

iDream 面向成年人提供虚构角色扮演、陪伴与角色媒体创作，完整范围包括发现、创建、聊天、图片/视频/语音、资产、社区与创作者、付费、联盟和支持。产品按用户结果组织，完整需求以 [PRD](PRD.md) 为准。

## 阅读顺序

1. [PRD](PRD.md)：用户目标、产品对象、完整需求和共同契约。
2. [功能地图](ProductFeatureMap.md)与[用户故事](UserStory.md)：入口、操作、权限、结果及异常恢复。
3. 按任务阅读经济、内容、Chat、图片、后台等专题契约。
4. [对标矩阵](PRODUCT_PARITY_MATRIX.md) → [当前覆盖](CURRENT_FUNCTIONAL_COVERAGE.md) → [剩余工作](REMAINING_WORK_EXECUTION_PLAN.md)：目标差异、实际证据、下一步。

## 文档职责

| 文档 | 唯一维护内容 |
| --- | --- |
| [PRD](PRD.md) | 用户价值、完整需求编号、优先级、共同不变量与产品指标 |
| [功能地图](ProductFeatureMap.md) | 能力库存、页面入口、带日期的竞品广度基线 |
| [用户故事](UserStory.md) | 正常、失败、未知与恢复的用户任务及跨域验收 |
| [对标矩阵](PRODUCT_PARITY_MATRIX.md) | 需求/故事/契约映射、对标判断与退出条件 |
| [经济规格](ECONOMY_AND_PRICING.md) | 价格、额度、预付访问、报价、结算、退款与既有权利 |
| [内容策略](CONTENT_POLICY.md) | 成年人底线、可见性、禁止项、举报、申诉与处置 |
| [Chat PRD](CHAT_SERVICE_PRD.md) | 人物与上下文、Turn、媒体动作、语音输入/片段/通话及恢复 |
| [图片生成系统](CHARACTER_IMAGE_GENERATION_SYSTEM.md) | 视觉身份、创作输入、参考来源、交付与质量目标 |
| [后台功能规格](BackendFeatureSpec.md) | 服务端模块、权限、状态、运营结果与指标契约 |
| [Admin 导航](ADMIN_NAVIGATION.md) | 运营目标到工作区及对象的入口 |
| [角色素材运营指南](CHARACTER_ASSET_STUDIO_OPERATIONS_GUIDE.md) | 角色创作、图库交接、槽位编排与显式发布 |
| [主站体检清单](MAIN_SITE_HEALTH_CHECKLIST.md) | 用户任务、权限、异常、持久化、费用与跨域旅程验收 |
| [Admin 体检清单](ADMIN_PRODUCT_HEALTH_CHECKLIST.md) | 运营命令、对象状态、权限、审计与真实结果验收 |
| [核心体验验证](CORE_EXPERIENCE_VALIDATION.md) | 模型/媒体质量、同质量性能与经营证据的验证方法 |
| [声音发布清单](VOICE_RELEASE_CHECKLIST.md) | 声音身份、片段、语音输入与通话的独立发布条件 |
| [上线验收](LAUNCH_READINESS_AUDIT.md) | 同源运行、真实旅程、恢复与目标环境发布条件 |
| [生产配置清单](PRODUCTION_SECRET_CHECKLIST.md) | 四服务配置、secret、存储/恢复与探针报告 |
| [当前覆盖](CURRENT_FUNCTIONAL_COVERAGE.md) | 按领域维护最后有效的实施和运行证据、未获资格 |
| [剩余工作](REMAINING_WORK_EXECUTION_PLAN.md) | 唯一待办、依赖与退出条件 |

工程边界和协议见 [架构索引](../architecture/README.md)，统一术语见 [CONTEXT.md](../../CONTEXT.md)。竞品事实引用 [9月1日公开快照](../research/OURDREAM_PRODUCT_PARITY_SNAPSHOT_2026-09-01.md)及[9月5日补充复核](../research/OURDREAM_PRODUCT_REVIEW_2026-09-05.md)，受观察日期与方法限制。

## 维护规则

- 同一事实在所属契约维护，其他文档引用；价格、权限、执行协议和指标不另建平行定义。
- 需求定义应当怎样，代码和同一 source revision 的运行证据证明实际怎样。冲突显式记录；不按现状取消有效需求，也不把旧成功赋予新源码。
- 需求优先级、对标判断、实施/验证状态和公开发布资格分别判断。
- 被取代或已完成且无独立维护价值的方案删除；仍有效的要求合入所属契约，未闭合工作合入剩余计划。原过程从 git 历史追溯，不保留归档副本。
- 新审计和待分诊事项按[任务书](../agents/audit-brief.md)与[事项追踪](../agents/issue-tracker.md)写入本地 `.scratch/`；产品文档只保留必要证据索引。
- 文档更新核对引用、编号、优先级、命令与 diff；验收状态只能随真实新证据更新。
