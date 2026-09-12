# 群聊实施与验证契约

状态：实现冻结；本地数据库、UI 与运行时回归通过。Chrome 两成员真实模型交付及 12 成员页面验收由主任务接续，不以本报告替代实际 provider 证据。

证据基线：`9ce5e5da3362dc397eb73b7f72a621141740fd4b` 加本任务未提交工作区，2026-09-10。仓库同时包含其他审计修复，本报告仅覆盖群聊。

## 用户行为

- `/chat/groups` 可查看自己的群聊、搜索可用角色并选择 2–12 个不同成员，创建后进入 `/chat/groups/{id}`。
- 群聊成员在创建时固定。每次发送明确选择一个回复角色，`@角色名` 在唯一匹配时切换选择；同名角色用下拉框区分。其他角色不会被同一次消息批量调用。
- 消息显示发言者，重新打开恢复统一历史和成员身份。消息成功确认前不以重复请求猜测结果；结果不明确时保留原请求标识，恢复历史后再确认。
- 偏好、显式记忆与无记忆选项跟随当前选中的成员。播放历史语音使用该消息所属角色和成员会话。
- 群聊支持归档、整体删除。清除一名成员的关系记忆会结束整个群聊，阻止后续重播这份共享上下文；仍可查看已归档历史。其他成员的关系记忆设置不被一起清除。

## Main 权威与数据模型

迁移：`packages/main/prisma/migrations/20260910030000_group_conversation_authority/migration.sql`。

- `GroupConversation` 属于一个用户，持有状态、标题和下一个顺序号。
- 每个成员使用专属 `RecentChat`，固定角色内容、Release 与视觉版本；不会覆盖已有单角色会话，也不会将单角色开场白或私聊历史复制进群聊。
- `GroupChatTurn` 只把群聊内顺序号关联到既有 `ChatTurn`。消息正文、执行版本、交付、重试与计费仍以 Main 的 canonical Turn 为权威，没有第二份消息账本。
- 创建时一次校验全部成员再提交。创建请求必须为 2–12 个不同且当前用户有权访问的成年角色。
- 候选列表只发现用户自己的可用角色及已公开并上线的角色；其他创作者的 unlisted 角色不会出现在搜索结果。持有已知 ID 时，沿用单角色已有的 unlisted 访问契约。
- 各写入按 User → Group → Session 顺序串行。每组同时仅允许一个活动回复，幂等键跨成员检查，切换角色不能绕过一次命令的幂等约束。
- 场景按群聊顺序衔接。编辑、重生成与删消息只允许群聊最新 Turn，跨成员回退到正确的前序场景。
- 删除群聊复用原有消息删除、附件隐私撤销与关系记忆重建流程；不退还已经消耗的 Turn allowance，不影响独立私聊历史。

## 向 Chat 交付的身份与记忆边界

- Shared 增加可选 `group` 和历史 `speaker` 元数据，校验角色 ID、会话 ID、名字与固定成员一致，当前执行会话必须属于所选成员。
- 冻结快照只包含所选角色的 Soul、关系记忆及设置，加上群聊内真实发生的共享发言历史。其他成员只传身份和群聊发言，不传其私有 Soul 或关系记忆。
- Chat 保留历史 speaker 元数据，提示词明确当前仅以所选角色回复。前一条助手消息只有在属于当前角色时，才作为该角色先前的直接承诺处理。
- 普通模型输入、图片连续性输入和兼容工具格式均保留 speaker 信息。Chat 仍无数据库，执行与恢复沿用原有 Main Turn 协议。
- 针对某角色清除关系记忆时，Main 终止包含它的群聊及组内活动回复，更新成员会话状态，避免另一成员继续执行已被清除的共享上下文。

## HTTP 契约

全部群聊路径位于 `/api/v1/chat/groups`，使用既有会话认证与 BFF；不存在匿名群聊。

| 请求 | 用途 |
| --- | --- |
| `GET /` | 当前 owner 的群聊列表与 `ownerScope` |
| `GET /candidates?q=&cursor=` | 角色搜索，32 条分页，owner 绑定 |
| `POST /` | `{ title, characterIds }`，创建前核对 `x-idream-viewer-scope` |
| `GET /{groupId}?speaker={characterId}` | 统一历史、固定成员、所选会话与角色状态 |
| `POST /{groupId}/messages` | 显式 `characterId` 与既有消息参数、幂等键；复用 canonical Turn admission |
| `PATCH /{groupId}` | 更新标题或归档；有活动回复时拒绝归档 |
| `DELETE /{groupId}` | 原子删除整个群聊及关联消息 |

`GET` 消息额外返回 `sessionId`、`characterId`、`speakerName`、`requestKey`，供显示身份、原请求恢复和历史消息操作使用。

## 验证结果

所有数据库测试使用标准 Main 测试入口、隔离 `localhost:5433/idream_test` 与 Redis database 15，持有串行租约；最终 9 例结束后已释放给后续 Comic/context 测试。

| 验证 | 结果 | 本地证据 |
| --- | --- | --- |
| 新群聊 + 既有 chat-proxy、Scene、context-directives 集成 | 初轮 4 文件 50/50 | `.tmp/product-improvements-20260910/group-chat-integration.log` |
| 新群聊最终回归，含 public/unlisted 防发现 | 9/9 | `.tmp/product-improvements-20260910/group-chat-integration-final.log` |
| ChatSessionClient、MemoryPanel、Profile mounted | 55/55 | `.tmp/product-improvements-20260910/group-chat-ui-pure.log` |
| Chat context / prepared turn / prompt / runtime contracts / model request | 40/40 | `.tmp/product-improvements-20260910/group-chat-runtime-pure.log` |
| Shared chat-turns 契约 | 8/8 | `.tmp/product-improvements-20260910/group-chat-shared-pure.log` |
| Chat TypeScript | 通过 | `.tmp/product-improvements-20260910/group-chat-runtime-typecheck.log` |
| Main 相关文件定向 lint、全工作区 diff whitespace | 通过 | `.tmp/product-improvements-20260910/group-chat-lint.log` |

新增回归实际覆盖：2–12 人准入及越界、重复和无权限拒绝；独立成员 pin；历史恢复与 speaker；不同成员记忆隔离；并发只接受一个 Turn；幂等重放与一次 allowance；群聊最新 Turn 修订和 Scene 回退；整体删除与私聊保留；成员 no-memory 及清除时归档；其他 owner 读写拒绝；unlisted 搜索不泄露而已知 ID 沿用访问契约。UI 回归验证 `@` 切换后发送给正确成员，以及播放旧消息使用其原角色。

## 接续验收

- 主任务统一执行最终 Main typecheck，并按 README PM2 wrapper 重启 Main / Chat，使长期进程加载新 Prisma Client 与代码。此前主任务在旧 Main 进程观察到 `include groupTurn` 不识别属于 stale client，事务未提交；这不能当作群聊真实交付通过。
- 用受控账号在 Chrome 创建两成员群聊，各发送一次真实模型请求，记录 provider / model / Turn / request / attempt、实际回复身份、耗时、持久化和额度，再刷新恢复历史。
- 在 Chrome 选择 12 人并创建，验证第 13 人不能添加、指定成员切换和页面恢复；不需要为容量上限发起 12 次收费模型调用。
- 本报告未执行真实 provider、PM2 或生产部署。Chat 视频等其他任务新增的历史消息操作，由其任务继续核对消息所属成员字段。
