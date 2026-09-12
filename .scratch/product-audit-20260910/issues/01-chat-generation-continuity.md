# Chat → Generate 准确接续场景与作品

Type: task
Priority: P0
Status: ready-for-agent
Requirements: GN-15、GN-13、GN-16～18、CH-03/06/07

用户在聊天里确定一个场景或收到一张图后，进入 Generate 应继续这个明确任务。当前跳转只选中同一个角色，无法保证还是原场景、原图和原角色版本。

**当前可复现边界**

- [ChatHeaderControls.tsx:25](/Users/kk/code/idream/packages/main/src/components/ourdream/chat/ChatHeaderControls.tsx:25) 和 [ChatSessionClient.tsx:1948](/Users/kk/code/idream/packages/main/src/components/ourdream/ChatSessionClient.tsx:1948) 的链接只有 `characterId`。在有场景/已交付图片的聊天里打开 Generate，即可观察 URL 与未接续的表单。
- [generation-request-schema.ts:30](/Users/kk/code/idream/packages/main/src/server/modules/ourdream/generation-request-schema.ts:30) 没有产品 Turn/已接受 brief 的接续权威。内嵌 Chat 图片在 [service.ts:2164](/Users/kk/code/idream/packages/main/src/server/modules/ourdream/service.ts:2164) 已有明确 pins，不重新实现该已存在链路。

**预期行为**

从会话接续时使用当前角色、冻结 Release/Visual Profile/Scene 和明确的视觉要求；从图片接续时额外固定该图片及来源。用户能看懂带入了什么，并在报价后明确提交；登录/刷新不自动执行生成，修改输入按新意图报价。

**真正退出条件**

1. Chrome 分别完成“场景 → Generate”和“当前图 → Edit/Generate”，最终真实产物匹配源场景/源图，Main request/delivery/ledger 可追溯到准确 Turn/attempt/版本。
2. 接续后角色发布新版本、回到旧消息、刷新、登录、切换账号都不会静默替换 pins、泄露源图或执行错误任务；无权限/过期上下文给出可恢复结果。
3. 报价、重试、未知提交恢复、重复请求与源图 lineage 保持一次交付/结算；新增测试能暴露原来的“只带角色”缺口。

## Comments

- 2026-09-10：源码边界已确认；本事项没有把内嵌图片 Product Action 的已有实现当作缺失。
