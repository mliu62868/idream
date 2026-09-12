# Comic 与统一生成上下文

已实现独立 Comic 清单：作者由本人 Gallery 选图，保存章节/页面顺序与字幕，选择 private/unlisted/public、显式 allowRemix，按版本提交、撤回。审核使用 Admin v2 manifest、严格 DTO、权限、confirmation、version 与原子幂等审计。

用户入口：`/comics`、`/comics/:id`、`/creator-studio/comics`、`/creator-studio/comics/new`。创作者主页、Feed/Community 和个人 Library 均接入。阅读器按章节连续展示，页面可进入真实 Chat 或携带 Comic 版本/页面的生成入口。

图片继续归原作者私有资产。公开阅读通过 Comic 权限提供 no-store 内容流，不暴露不可撤销的签名地址；任一页面不可用会停止整本公开读取。有效发布被 Gallery 隐私/删除保护；先撤回可解除依赖。Admin 预览复用现有 user-content BFF。

GenerationContext 共用 Chat/Comic selector、确定性 HMAC、报价与入队复核、事务锁和重试权限。Chat 保留旧 Turn/Release/参考集，兼容已持久化 v1 token/请求重放。Comic 只读取作者公开的页面字幕；公开且可证明来源的 Character 使用源图原 Release/参考集，其他页面进入 source-only image edit。私有 Character Soul、源作者 prompt 与聊天不进入 Comic remix。

已接受 Comic dispatch 使用签名 comicGrant，精确绑定用户/Comic版本/页面/源媒体/allowRemix。签名与持久化来源、controls 都一致才允许跨作者 source_image；不会扩大 Character identity reference 权限。发布撤回阻断新报价/新提交/付费重试，已有回执仍恢复原任务。

验证记录：

- 初始 Comic v1 原型集成 10/10；当前已替换为 v2。
- 当前 v2 Comic 集成 11/11，Chat context 集成 5/5。
- 既有生成/Comic 客户端与纯逻辑 178/178。
- 新增 source-only Generator mounted 与上下文单元一轮 78/78；最终签名 Comic grant 单元 14/14。
- Main typecheck 在 Video 接口迁移前仅报告对方旧 import/parser 两处；本任务无类型错误。
- Comic/上下文/分发/引用图片/Generator 相关 lint 与 git diff --check 通过。
- 最终标准测试 4 文件 30/30：Comic v2 11项、Chat/Comic context 10项、reference-images/attempt-dispatch 9项。包含跨作者 source-only 入队、dispatch wake/replay、合法付费重试和撤回后的新消费拒绝。证据 `.tmp/product-audit-20260910/comic-context-integration-final.log`。此前暴露的 dispatch 跨作者源图问题已修复并通过回归。

以上为受控本地验证，尚不代表 Comic 的真实 provider 出图与 Chrome 运营/用户全链路交付。统一真实验证由根任务在所有模块冻结、wrapper 重启后执行。schema migration 已由根任务作为单一写入者合入开发库；本任务未改生产数据。
