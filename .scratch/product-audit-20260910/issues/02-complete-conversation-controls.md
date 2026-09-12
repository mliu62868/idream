# 完成多角色与主动互动控制

Type: task
Priority: P1
Status: ready-for-agent
Requirements: CH-08/12/13/15、PF-08、EX-10；US-CH-11/12/14

用户应能选择完整互动方式：让不同角色参与同一对话、指定回复者，并控制主动互动及可感知的体验档位。当前产品仅完成单角色会话和三种基础偏好。

**当前可复现边界**

- [service.ts:3864](/Users/kk/code/idream/packages/main/src/server/modules/ourdream/service.ts:3864) 对 `library/group-chats` 返回固定空数组；[ProfileWorkspace.tsx:224](/Users/kk/code/idream/packages/main/src/components/ourdream/ProfileWorkspace.tsx:224) 明示未提供群聊。[schema.prisma:621](/Users/kk/code/idream/packages/main/prisma/schema.prisma:621) 的 RecentChat 只有一个 `characterId`。
- [chat-turns.ts:53](/Users/kk/code/idream/packages/shared/src/contracts/chat-turns.ts:53) 和 [ConversationPreferences.tsx:76](/Users/kk/code/idream/packages/main/src/components/ourdream/chat/ConversationPreferences.tsx:76) 已支持长度、互动风格、Scene direction；没有 active messages 或版本化 conversation-profile 选择。已有三类偏好与记忆设置不重复实施。

**预期行为**

最多 12 个角色的 Group Chat 有参与者与说话者权限、明确的选人/`@` 操作、各自稳定身份和可恢复历史。主动消息由用户显式开启、调整和关闭；档位在执行前解释能力与成本，底层模型仍由服务器选择。沿用 Main Turn 与计费权威，不因套餐或档位改写角色 Soul/基础记忆质量。

**真正退出条件**

1. Chrome 创建并恢复 2 人与 12 人群聊，指定某角色后只有合格说话者回应；不合格/私有他人角色不能加入；历史、记忆、图片动作和用量准确归属。
2. 主动消息的开启/关闭/频率/静默边界明确且生效；断线、重启、重放不会多发或多扣；用户关闭后不再产生新主动互动。
3. 档位按历史五档基线给出 `matched/equivalent/intentional_divergence` 证据。仅将三个现有控件换标签不算完成；需真实模型证明用户可感知的行为差异、报价/权限及旧 Turn 版本冻结。已有长度、互动风格、Scene direction 同样需要真实遵从样本：场景人物、用户动作与关系事实保持一致，新 Turn 用当前设置，旧 Turn 重生成沿用原版，切换档位不改写 Soul 或基础记忆。
4. 各子能力分别记录同 revision 测试和真实交付。未完成部分继续隐藏入口，不用空数据签发完整群聊。

## Comments

- 2026-09-10：本事项只覆盖尚未提供的互动能力，保留已有单角色、Pinned Memories、Instructions、Persona 和三类会话偏好的实现。
