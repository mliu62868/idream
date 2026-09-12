# 完成公开生产环境与运营认证

Type: task
Priority: P0
Status: needs-info
Requirements: AG-05、UP-03/07、PRD §9～11、LAUNCH_READINESS_AUDIT

本机 Chrome 通过只能证明所测受控环境。向真实用户开放产品并收款，还需要实际生产环境、provider、数据恢复和运营闭环的当前证据。

**当前可复现边界**

[launch-readiness.ts:79](/Users/kk/code/idream/packages/main/src/server/launch-readiness.ts:79) 将 source revision、evidence/env digest 与检查结果绑定；`:1050`、`:1232`、`:2515`、`:3240` 分别要求支付、年龄验证、blob 与 Sentry 证据。前轮核心审计和 mock checkout 不能满足真实商业验收。本任务没有读取生产秘密，因此只判“未认证”，不推断某个秘密不存在。

**需要的信息**

目标主机/域名和 HTTPS，受保护 Admin 的正式访问方式；Main/Admin/Chat/Gen 生产配置与数据库/Redis/queue/storage authority；真实 BTCPay、适用 jurisdiction 年龄 provider/回调、对象存储、Sentry 的凭证和运维权限；观察窗口和上线范围。只有拿到明确目标才能执行精确发布门，不能把现有开发库当生产库。

**预期行为与真正退出条件**

1. 使用 README 的 PM2 wrapper，目标 revision 的实际进程、端口、full readiness、公开主站与受保护 Admin 通过；不绕过 drain/ownership 拒绝。
2. 按作用域完成实际模型、图片/默认视频/语音、支付 invoice/确认、按需年龄状态/签名回调、blob write/sign/read/delete 与 Sentry canary；记录 provider/model/workflow、request/attempt/artifact、时间、费用、持久化/交付/结算。
3. 完整 authenticated Chrome 用户与运营链覆盖正常/失败/取消/重复/断网恢复、已有资产到期访问、客服跟进、举报处理；桌面与 390px 验证输入法/底部安全区、长消息/播放器、键盘和弹窗焦点/关闭，以及刷新/换号后的任务权限。真实模型样本分别证明场景/角色一致、记忆召回与纠正/暂停/清除、图片编辑保留未请求改变的内容和声音身份，长期记忆/10k 历史及峰值容量另有实际证据；一次顺利消息或空态不能签发这些质量与规模目标。新产品缺口需各自完成，不能以环境通过取代。
4. 目标库 migration、Main/Chat/Blob/队列备份及隔离恢复、积压恢复和观察窗口通过；同 revision 证据与账本正确，测试/internal 数据不冒充真实留存或经营指标。
5. `bun run check:launch` 使用明确生产环境文件和当前探针全绿后，结合产品事项、容量和真实观察结果给出 Go/No-Go；不可用旧 revision 或过期恢复 bundle 补签。

**固定边界**

保持 `MODERATION_PROVIDER=mock`，保留 underage/minor/csam 拦截及角色 age ≥ 18；**不要求重新启用 safety-gateway**。不自动充值、购买订阅、向第三方转账、公开发布或不可逆清理。已授权的本项目开发/测试库操作与正常最低充分 provider 验证仍按 AGENTS 执行；生产动作遵守其独立授权边界。

## Comments

- 2026-09-10：本事项只追踪外部环境与公开运营认证，不把已实现的本地能力重新标为“没有实现”。
