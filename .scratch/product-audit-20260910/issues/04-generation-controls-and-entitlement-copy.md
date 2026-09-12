# 补全生成参数并校准升级承诺

Type: task
Priority: P1（已确认文案不一致为 P2）
Status: ready-for-agent
Requirements: GN-03/04/06/07/19、UP-04/05、CR-11；ProductFeatureMap §1.1

用户应能理解并实际使用所承诺的创作控制，升级后得到清楚的权益；可选控制、固定 recipe 规格和尚未提供的能力必须一致表达。

**当前可复现边界**

- [generation-request-schema.ts:38](/Users/kk/code/idream/packages/main/src/server/modules/ourdream/generation-request-schema.ts:38) 接受 seed，但前台没有 seed 控制；`:45` 将批量限制为 8，历史公开基线为 256，尚无明确等价/差异判定。
- [GeneratorWorkspace.tsx:2879](/Users/kk/code/idream/packages/main/src/components/ourdream/GeneratorWorkspace.tsx:2879) 只让非角色图片模式选择 Model；`:2918` 的角色图片为 Auto；本轮基线 `:3253` 向免费用户宣称 Model selection 属于 Premium；当前补丁已改为仅说明实际 Premium negative-prompt 权益，完整控制缺口仍保留。
- `:3264` 只展示固定视频时长、尺寸及音频状态；没有多 scene、可选时长/质量/AI voice。已有默认单段 Video、Edit、Enhance 不作为待重建项。
- [seed.ts:666](/Users/kk/code/idream/packages/main/prisma/seed.ts:666) 提供 24 个 Preset；运行 DB 可以更多，必须实盘 published Catalog，不能把 seed 数当线上总数，也不能以静态控件当广度完成。

**预期行为**

提供模型确实支持、身份约束合格、服务端可报价的参数与目录；升级文案只描述该模式实际解锁内容。每个历史数量/容量维度单独说明是否匹配、任务等价或明确产品偏离，不能靠添加无效选项补数量。

**真正退出条件**

1. 本轮已修正角色图片的升级文案与控件矛盾，见 [GeneratorWorkspace.tsx:3253](/Users/kk/code/idream/packages/main/src/components/ourdream/GeneratorWorkspace.tsx:3253)；后续 Chrome 验证 Free/Premium/Deluxe 的显示、选择、服务端权限和实际报价一致，不重复修复已关闭的文案问题。
2. seed、合格模型、比例/数量与多 scene/时长/质量/声音的已发布控制进入不可变请求，真实 provider 输出能证明参数有效，失败/部分交付/重试的费用正确。
3. 批量与视频容量有实测 admission/队列/取消/交付边界；仅提高 schema 上限或显示规格不能通过。H3 不合格历史仍保留，未经质量复验不得恢复新选择。
4. 实盘记录实际可选择、可保存并参与执行的 Create/Voice/Presets 目录、发布版本及盘点日期，对 personality、occupation、relationship、Hobbies/Preferences、声音和各 Preset 类别逐维度给出 `matched/equivalent/intentional_divergence` 与具体理由。CR-11 的 40+/19/135/29 以及 Preset 数量只是有日期的公开基线；当前 48/135/29 静态选项不自动证明语义等价，运行声音须验证可选与试听身份，自定义值须证明能保存并进入 Soul/生成请求。等价判定按真实用户意图与覆盖任务，不能添加同义空选项凑数；有意偏离需明确产品决定及未覆盖范围，公开文案同步准确，未通过的控制维持关闭态。

## Comments

- 2026-09-10：不重复实施已有的三类 preset 编辑、Image Edit/Enhance、默认 RedGraft 单段视频和创建 48/135/29 项目录；处理剩余深度与真实承诺。

- 2026-09-10 本轮修复：角色 Moment 的升级提示改为 `Negative prompts are a Premium control.`，移除付费后仍不提供的模型选择承诺；本项其余参数/容量工作未完成。
