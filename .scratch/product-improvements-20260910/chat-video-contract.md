# Chat Video 的 Main 产品契约

Chat Video 是单独的产品动作。Main 继续持有不可变 Turn、Scene、角色身份、生成请求、交付和费用；Chat Agent 不直接发起视频扣费。

1. `chat_video` 是独立产品开关；还需公共视频执行开关和 `video_generation` 权益。关闭开关或权益到期只禁止新建与付费重试，历史交付继续可读。
2. 当前已发布执行路线是 image-to-video。用户通过明确的视频请求或已交付图片上的 Animate 进入确认。必须选择当前账号、对应 Turn 和当前 attempt 的成功图片附件；角色的新头像、别人的素材、已撤销来源均不能替代。
3. 报价表单显示来源图、动作、真实路线的时长、音频规格和费用。选择来源或修改动作使原报价失效。用户再明确确认才创建请求。
4. Main 重新解析签名 Generation Context，冻结原 Soul / Scene / Release / visual profile / reference set 和源图 Job。新视频作为独立 `generated_video` 附件追加到原回复；不得修改已提交 Turn 的正文、attempt、executionSnapshot 或 Scene。
5. 附件、Generation Request、扣费、初始 Attempt 和投递 outbox 在同一接纳事务提交。相同账号和请求键恢复同一结果；隐私编辑后仍可查询已受理回执，但不能用旧键提交另一份动作。
6. 成功、明确失败与退款由现有 Main 终结事务投影到附件，按精确 generationJobId 更新。付费重试重新报价和确认，创建新 Job 并原子替换附件的指针；旧任务的迟到结果不得覆盖重试。
7. 用户取消仅在 Main 能证明从未开始投递时受理：Job 和 Attempt 均 queued，且其精确 outbox 从未被领取。取消、Attempt 终态、outbox 撤销、附件状态和退款一次提交。已领取、投递结果未知或正在执行的请求明确拒绝取消，继续等待真实结果；不声称停止了底层 provider。
8. Turn 编辑、清除、群会话或单人会话删除撤销新的来源解析与重试；已有生成的私有文本投影随 Turn 清理。视频读取、下载和历史保持账号归属隔离。

验证分两层：数据库测试证明接纳、幂等、隐私、拒绝与交付投影；真实 Chrome + 实际 Gen workflow 证明播放、画面连续性、时长、交付持久化和费用。数据库中的合成媒体不作为真实视频成功证据。

冻结后的回归与真实验证入口见 [.tmp 验证记录](/Users/kk/code/idream/.tmp/product-improvements-20260910/chat-video-verification.md)。I2V 的执行引用只有精确源图；原 Soul / Scene / Release / visual profile / reference set 保存为签名上下文与 sourceMeta 沿袭，不把未实际使用的身份参考图写成本次执行输入。
