# 角色一致性图片生成流程蓝图

> **已被 `CHARACTER_IMAGE_GENERATION_SYSTEM.md` 收敛取代。** 本文保留旧流程与文案历史；新的目标流程、状态契约和跨服务不变量以新文档为准。

更新日期：2026-07-01

状态：产品流程设计；作为 `CHARACTER_CONSISTENT_IMAGE_GENERATION_PRD.md` 的产品体验补充。PRD 负责定义对象、接口、实现状态和工程分期；本文负责定义用户流程、系统决策、页面信息架构和下一步产品路线。

## 0. 一句话结论

iDream 的图片生成不应该被设计成“prompt 工具”，而应该被设计成“把同一个虚拟角色持续可视化”的陪伴功能。

用户真正要的不是一张孤立好看的图片，而是：

> 她还是她；只是今天换了场景、衣服、姿势、情绪和故事时刻。

因此图片生成的产品核心不是自由度最大化，而是“角色身份稳定 + 场景表达自由 + 失败可修正 + 反馈能学习”。

## 1. 第一性原理

### 1.1 用户为什么需要图片

在虚拟角色陪伴产品里，图片承担四个任务：

1. **确认关系对象**：用户要看到聊天里的那个角色，而不是另一个随机形象。
2. **增强剧情真实感**：当前聊天、约会、日常、幻想场景被可视化。
3. **沉淀占有感**：用户喜欢的图会成为这个角色的头像、收藏、回忆和后续生成参考。
4. **推动付费**：更稳定、更高清、更多张、更强编辑和更快生成，才是合理的高级能力。

如果角色漂脸，图片会反向破坏关系感；如果系统只给一个 prompt 框，用户会被迫承担“提示词工程师”的工作。这两点都不符合陪伴产品。

### 1.2 图片生成的核心对象

产品里需要把角色拆成三层：

| 层 | 产品含义 | 是否应被普通用户频繁改动 |
| --- | --- | --- |
| `Persona` | 角色是谁、如何说话、记忆和关系 | 可以编辑 |
| `Visual Identity` | 脸、发型、体型、识别点、主视觉风格 | 低频编辑，默认锁定 |
| `Scene` | 这次在哪里、做什么、穿什么、镜头如何 | 高频生成入口 |

图片生成时，普通用户主要编辑 `Scene`，系统自动注入 `Visual Identity`。这就是角色一致性的产品边界。

### 1.3 一致性不是单点能力

一致性来自一套闭环，不来自某个“神奇模型”：

1. **建档**：Create 阶段建立角色视觉身份。
2. **锁定**：Generate / Chat 每次生成都读取同一个 active visual profile。
3. **分层**：用户 prompt 只作为 scene，不覆盖脸和身份。
4. **留痕**：每次 job 记录 visual profile version、model profile、template、seed、reference assets。
5. **反馈**：用户喜欢的图可以设为主图、加入 identity、继续 More like this。
6. **评估**：模型模板上线前必须通过 20 张一致性样本人工评审。

## 2. 产品原则

1. **角色优先**：只要选了角色，默认就是角色图，不是自由 prompt 图。
2. **一致性默认开启**：用户不需要知道 seed、IP-Adapter、LoRA、sd.cpp、ComfyUI。
3. **场景自由，身份受控**：用户可以改地点、动作、衣服、氛围，但不默认改脸。
4. **满意图反哺身份**：Gallery 不是终点，而是训练用户偏好的反馈入口。
5. **可回放**：每张图都能解释为什么像或不像。
6. **Freeplay 保持自由**：无角色模式不强行套视觉身份。

## 3. 关键概念：Visual Passport

面向用户的语言建议叫 **Identity Lock** 或 **Visual Passport**，面向工程仍使用 `CharacterVisualProfile`。

### 3.1 Visual Passport 包含什么

| 内容 | 用途 |
| --- | --- |
| Identity summary | 给 prompt assembler 的稳定身份描述 |
| Anchor images | 1-4 张最能代表角色的基准图 |
| Reference pool | 用户或运营认可的辅助参考图 |
| Signature traits | 强识别点，例如眼睛、发型、痣、配饰 |
| Default seed | text-only 路径下的稳定性支撑 |
| Style lane | realistic / anime / hybrid 等主风格 |
| Version | 确保每次变化可追踪、可回滚 |

### 3.2 用户可见的表达

不要把 `CharacterVisualProfile` 这个词暴露给普通用户。页面上使用：

- `Identity locked`
- `Visual identity v3`
- `Based on 3 identity images`
- `More like this`
- `Add to identity`
- `Use as character image`

## 4. 总体闭环

```text
Create character
  -> generate/select visual anchor
  -> create active visual profile
  -> chat with character
  -> request image from chat or Generate
  -> system assembles identity + scene
  -> model generates images
  -> user selects liked outputs
  -> gallery feedback updates visual profile
  -> future images become more stable
```

这条闭环必须跨 Create、Generate、Chat、Gallery、Admin 共享同一套身份对象。

## 5. 用户流程 1：Create 建立视觉身份

### 5.1 目标

Create 的目标不是只创建聊天资料，而是创建一个“可聊天、可出图、可延续”的角色。

### 5.2 推荐步骤

```text
Identity
  -> Appearance
  -> Personality
  -> Visual Preview
  -> Publish
```

### 5.3 Visual Preview 页面

页面应包含：

- 4 张候选图。
- 当前外观 trait chips。
- `Set as identity` 主按钮。
- `More like this` 次按钮。
- `Edit traits` 返回外观字段。
- 失败后 `Retry preview` 和 `Skip for now`。

### 5.4 Create 提交流程

```text
用户填写外观字段
  -> 系统生成 identityPrompt / negativeIdentityPrompt
  -> 生成 4 张 preview candidates
  -> 用户选择 anchor
  -> 创建 Character
  -> 创建 CVP v1 active
  -> Character.imageAssetId 指向 anchor
```

### 5.5 缺 preview 时的降级

如果 preview 失败或用户跳过：

- 允许保存角色。
- CVP 以 `draft` 或 text-only active 形式存在。
- 角色第一次进入 Generate 时提示先生成 identity anchor。
- 官方或推荐角色不应在缺 active CVP 时进入推荐位。

## 6. 用户流程 2：Generate 角色优先生成

### 6.1 页面定位

Generate 不是“空 prompt 框 + 模型参数”，而是角色场景工作台。

### 6.2 信息架构

```text
Left panel
  Balance and cost
  Character / Freeplay switch
  Character selector
  Identity status
  Consistency: Balanced / Strict / Creative
  Scene prompt
  Presets: Background / Pose / Outfit
  Framing: orientation / count
  Advanced: negative prompt / seed / model
  Generate

Right workspace
  Active jobs
  Latest results
  Gallery: Recent / Liked / Character images
```

### 6.3 字段语义

角色模式下：

- `prompt` 在产品上叫 `Scene prompt` 或 `Extra details`。
- placeholder 应引导用户写“场景、动作、气氛、镜头”，不要重复描述角色脸。
- 系统自动注入 active CVP identity layer。

Freeplay 模式下：

- prompt 可以是完整主体描述。
- 不显示 identity status 和 consistency control。
- 不允许传 `visualProfileId`。

### 6.4 Consistency 模式

| 模式 | 用户含义 | 系统策略 |
| --- | --- | --- |
| Balanced | 默认，像本人且场景自然 | identity prompt + seed + 可用参考图，场景权重正常 |
| Strict | 更像基准图 | 更高参考权重，更少风格漂移，优先脸部一致 |
| Creative | 更自由的造型探索 | 保留脸、发型、识别点，放宽服装/风格/构图 |

默认用 Balanced。Chat 中可默认 Balanced 或 Strict，取决于图片是“自拍/本人照片”还是“剧情场景图”。

### 6.5 生成请求语义

角色图请求应该被解释为：

```json
{
  "mode": "image",
  "characterId": "char_x",
  "scenePrompt": "sitting beside a rainy neon window",
  "consistencyMode": "balanced",
  "controls": {
    "backgroundPresetId": "bg_neon_room",
    "posePresetId": "pose_sitting",
    "outfitPresetId": "outfit_evening",
    "orientation": "4:5",
    "count": 4
  }
}
```

服务端负责补齐：

- active `visualProfileId`。
- identity prompt。
- negative identity prompt。
- seed。
- reference image descriptors。
- model profile / prompt template version。

## 7. 用户流程 3：Chat 内图片

### 7.1 产品目标

Chat 图片是关系的一次可视化回复，不应该打断聊天。

### 7.2 触发方式

- 用户说“发张照片”“让我看看你现在的样子”。
- 用户点消息工具栏里的图片按钮。
- 角色提出可生成图片，用户确认。

### 7.3 Chat 模型边界

Chat 模型只负责 scene intent：

- 当前动作。
- 当前地点。
- 当前情绪。
- 简短镜头。

Chat 模型不应该重写角色五官、发型和体型。主站生成服务读取 CVP 来拼身份。

### 7.4 Chat 图片生命周期

```text
User asks for image
  -> Chat extracts scene intent
  -> Main creates GenerationJob(sourceType=chat_image)
  -> Attachment shows queued/generating state
  -> Worker generates image
  -> Event returns media asset
  -> Chat message updates attachment
  -> User can Like / More like this / Add to identity
```

### 7.5 Chat 特有体验

- 图片生成中不要阻塞继续聊天。
- 生成完成后保留在消息内，同时进入 Gallery。
- `More like this` 可以从 Chat 图片直接发起 variation。
- 如果生成失败，消息内给 `Retry`，不要让用户去 Generate 页找任务。

## 8. 用户流程 4：Gallery 反馈闭环

### 8.1 Gallery 的角色

Gallery 是用户偏好的训练面板。它不只是资产列表。

### 8.2 每张图的动作

基础动作：

- Like。
- Download。
- Delete。
- Make private / unlisted。

角色一致性动作：

- `Use as character image`
- `Add to identity`
- `More like this`
- `Less like this`

### 8.3 动作语义

| 动作 | 结果 |
| --- | --- |
| Use as character image | 更新角色主图，并创建新的 active CVP version，将该图作为 anchor |
| Add to identity | 创建新的 active CVP version，将该图加入 reference pool |
| More like this | 以该图作为 source image，走同一角色 identity pipeline 生成 variation |
| Less like this | 记录负反馈，后续降低相似方向权重 |

### 8.4 版本策略

任何会影响未来生成的动作都应该创建新 CVP version，而不是原地覆盖。这样用户和运营可以回滚。

## 9. 用户流程 5：Admin / Content Ops

### 9.1 官方角色生产流水线

```text
Create official persona
  -> Fill appearance traits
  -> Generate identity batch
  -> Select 1-4 anchors
  -> Publish CVP v1
  -> Generate cover/detail/feed variants
  -> Review consistency
  -> Publish character
```

### 9.2 Admin 必须显示

- 是否有 active CVP。
- anchor 图。
- identity prompt 摘要。
- reference 数量。
- 最近 20 张一致性评审结果。
- model profile 状态。
- 生成模板是否已通过人工 smoke。

### 9.3 模型模板发布门槛

任何新模板进入用户路径前：

- 至少 20 张样本。
- 人工一致性通过率 >= 80%。
- 无空白图、纯噪声图、严重坏图。
- 记录样本、review 页面和 summary。
- 发布后支持 rollback。

## 10. 系统决策树

### 10.1 生成入口决策

```text
if freeplay:
  use full user prompt
  no visual profile
else:
  load character active CVP
  if CVP exists:
    assemble identity + scene
    choose consistency strategy by model capabilities
  else:
    degrade to appearance text if available
    ask user to create identity anchor
```

### 10.2 模型能力决策

```text
if model supports referenceImages:
  send CVP anchor/reference images as identity refs
if model supports initImage and request has source image:
  send source image for More-like-this variation
if model supports stableSeed:
  derive job seed from character + CVP version + job id
if model is text-only:
  keep identity prompt + negative identity + stable seed
```

前端不判断底层 runner。前端只表达用户意图；后端按 `GenerationModelProfile.runnerConfig.capabilities` 分流。

## 11. Prompt 分层规范

统一 assembler 应按这个顺序拼：

```text
Quality prefix
Identity layer
Style layer
Scene layer
Preset layer
Composition layer
Consistency instruction
Quality suffix
```

关键约束：

- identity layer 来自 CVP，不来自用户 scene prompt。
- scene prompt 不能覆盖 identity。
- negative prompt 必须包含 negative identity 和常见坏图项。
- assembled prompt hash 要可记录。

## 12. UI 文案方向

### 12.1 好的文案

- `Identity locked`
- `Describe the moment, not her face`
- `Use this as the character image`
- `Add this look to identity`
- `Generate more in this direction`
- `Strict keeps the face closest to the identity image`

### 12.2 避免的文案

- `Upload ref-image for IP-Adapter`
- `Use LoRA weight`
- `CFG / sampler / VAE`
- `Prompt engineering`
- `Face lock may fail`

普通用户不应该面对模型术语。模型术语留在 Admin 和工程诊断里。

## 13. 状态与错误体验

### 13.1 Job 状态

| 状态 | 用户看到 |
| --- | --- |
| queued | 等待生成 |
| generating | 正在生成 |
| complete | 结果图 + actions |
| failed | 可重试；说明扣费是否返还 |
| blocked | 不可重试；给出换描述或帮助入口 |
| refunded | 明确已返还 |

### 13.2 Identity 状态

| 状态 | 用户看到 |
| --- | --- |
| none | `Set up identity image` |
| draft | `Identity draft` |
| active text-only | `Identity locked` |
| active with anchors | `Identity locked · 2 images` |
| updated | `Identity updated to v4` |

## 14. 指标

### 14.1 产品指标

- 角色模式生成占比。
- Generate 后 Like rate。
- More-like-this 使用率。
- Add-to-identity 使用率。
- Use-as-character-image 使用率。
- 失败后重试率。
- Chat 图片请求完成率。
- 生成后回到 Chat 的比例。

### 14.2 一致性指标

- 20 张人工一致性通过率。
- Strict / Balanced / Creative 三模式的通过率差异。
- 用户删除率。
- 用户“Less like this”比例。
- 同一角色跨模型模板漂移率。

### 14.3 商业指标

- 高级控制曝光 -> 升级转化。
- 余额不足 -> 充值/升级转化。
- 图片生成用户的 D1/D7 留存。
- Chat 中生成图片后的会话时长变化。

## 15. MVP 到增强路线

### P0：已基本具备的角色一致性底座

- CVP 数据对象。
- Create 生成 active CVP。
- Generate identity lock。
- Chat image 使用同一 CVP。
- Gallery promote / add identity / more-like-this。
- reference image transport。
- model capability gate。
- consistency smoke runner。

### P0.5：下一步最该补的产品深度

1. **Create Preview 候选选择体验**：4 张候选、Set as identity、More like this、Edit traits。
2. **Chat 图片原生体验**：消息内生成状态、完成附件、Retry、More like this。
3. **Gallery identity timeline**：用户能看到角色身份 v1/v2/v3 的变化和当前 anchor。
4. **Identity setup empty state**：缺 CVP 的用户角色，引导先生成基准图。
5. **20 张人工一致性 smoke**：选 1 个 demo 角色，用真实 pipeline 形成可展示证据。

### P1：参考图条件生成产品化

1. 接入真正 reference-capable profile。
2. Consistency mode 映射为 reference / adapter 权重。
3. Pose preset 接姿势控制。
4. Look / wardrobe：日常、约会、职业、幻想等造型。
5. Admin 人工一致性 review 工作台。

### P2：高价值角色 adapter

1. 官方角色 LoRA / embedding / face adapter。
2. 用户高活跃角色自动推荐训练。
3. adapter version publish / rollback。
4. 自动相似度评估辅助人工 review。

## 16. 当前优先级建议

按“最大用户感知收益 / 最小工程风险”排序：

1. **把 Generate 的 prompt 心智彻底改成 Scene prompt**：用户少写脸，系统多锁身份。
2. **Create Preview 补候选选择与设为 identity**：让用户从创建时就知道“这个角色长这样”。
3. **Chat 图片不跳页闭环**：聊天里请求、等待、收到、继续变体。
4. **Gallery identity timeline**：把 Add to identity 从隐藏动作变成可理解的成长记录。
5. **跑真实 20 图 consistency review**：为模型路线提供产品证据。

## 17. 验收清单

### 用户体验验收

- 新建角色时能选择一张基准图。
- Generate 选择角色后明确显示 `Identity locked`。
- 用户 prompt 被引导为场景描述。
- Strict / Balanced / Creative 可被用户理解。
- Chat 内图片生成不打断会话。
- Gallery 中满意图能反哺角色。

### 数据验收

- 每个角色图 job 有 visual profile id/version。
- 每张图 metadata 有 seed、profile/template、reference assets。
- 每次 identity 更新创建新版本。
- Freeplay 不写入 visual profile。

### 模型验收

- text-only 路径能保持基本一致。
- reference/init-image 路径按 capability gate 生效。
- 至少一个真实 demo 角色 20 张人工一致性通过率 >= 80%。
- 新模型模板不绕过人工评审直接上线。
