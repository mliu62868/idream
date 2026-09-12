# 完成聊天视频与双向通话

Type: task
Priority: P1
Status: needs-info
Requirements: CH-06/07/14、GN-01/16、US-CH-06/13、Journey H

用户在聊天中请求视频，或直接与角色通话，应得到可解释、可恢复且费用准确的媒体交互。播放一条 TTS 和在独立生成器做单段视频均不满足这两个任务。

**当前可复现边界**

- [chat-turns.ts:188](/Users/kk/code/idream/packages/shared/src/contracts/chat-turns.ts:188) 的 Product Action effect 只有图片创建与编辑，没有 Chat video；Generate Video 的发布不能自动开启 Chat video。
- [service.ts:593](/Users/kk/code/idream/packages/main/src/server/modules/ourdream/service.ts:593) 和 [voice-clip.ts:241](/Users/kk/code/idream/packages/main/src/server/modules/ourdream/voice-clip.ts:241) 实现 quote/单消息 Voice Clip，没有双向通话的建立、音频传入、挂断或用量生命周期。

**需要的信息**

现有 [经济契约](/Users/kk/code/idream/docs/product/ECONOMY_AND_PRICING.md) 只规定 Voice Clip 的分钟优先/每条兜底费率。完整通话还需明确使用哪个额度、计量单位与舍入、最低消费、断线/重连及余额耗尽时的计费边界。实际通话模型/语音链路的容量与公开发布资格也须取得证据。Chat Video 的独立契约与界面可先行研发，不必等待通话定价。

**预期行为与真正退出条件**

1. Chat Video 有显式 capability 和执行前 quote；用户确认后沿当前 Turn/Scene/pins 生成，附件可播放/下载，重复/重试/取消仅一次结算，历史在新能力关闭或计划到期后仍可访问。
2. Voice Call 从麦克风授权到连接、双向对话、中断、重连、结束都有明确状态；用户拒绝许可或余额耗尽能正常退出，没有后台继续计费。
3. 用实际 provider 完成 Chrome 通话与视频旅程；记录声音身份、时长、request/attempt/artifact/结算，验证同一角色连续性与真实听感/画面质量。
4. 单条 Voice Clip 的旧消息重播与已交付视频不回归；分别签发 Call 与 Clip、Chat Video 与 Generate Video，不能互相代验。

## Comments

- 2026-09-10：needs-info 仅针对通话发布输入缺失；不是要求重新购买服务或擅自制定新的商业费率。
