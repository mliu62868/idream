# 角色一致性的图片生成产品规格

> **已被 `CHARACTER_IMAGE_GENERATION_SYSTEM.md` 收敛取代。** 本文保留 2026-06 至 2026-07 的实现背景与历史裁决；新的产品目标、领域对象、状态、指标和分期以新文档为准。

更新日期：2026-06-30

状态：产品设计方案；Phase 1 代码底座已落地（CVP schema、Create/Generate/Chat identity lock、Generate identity UI、Gallery feedback、Official Admin visibility）；reference image transport 已接到 queue / worker / pipeline request，且本地 sd.cpp gateway 已能把 `source_image` 映射为 `--init-img`；model profile 已有 `runnerConfig.capabilities` 能力门控，支持 text+seed 与 reference/init-image 路径按模型能力分流；当前 Pornmaster/Z-Image profile 只启用 text+seed 与 init-image，不启用 identity `--ref-image`；Admin 不再提供模型管理或手动创建模型 profile 的默认入口，候选 profile 由工程侧 seed/config 注入，Admin 只做 dry run、test image、人工一致性 review、publish/rollback；高阶 LoRA/IP-Adapter/identity reference 消费与候选模型真实 20 张一致性 smoke 仍待通过

适用范围：Create 角色预览、Generate 图片、Chat 内图片请求、Gallery、Admin Generation Ops、Content Ops、`packages/gen` 图片 worker。

## 1. 结论

图片生成不是一个“用户输入 prompt -> 返回图片”的工具。对 AI 伴侣产品来说，图片生成的核心承诺是：

> 用户相信自己看到的是同一个角色，在不同场景、姿势、服装、光线和聊天上下文里持续出现。

因此，iDream 的图片生成需要把“角色视觉身份”建模成一等产品对象。Generate 页、Chat 图片、Create 预览和运营出图都必须围绕同一份视觉身份快照生成，而不是各自临时拼 prompt。

当前实现已经具备基础链路：

- `GenerationJob` 支持 `characterId`、prompt、negative prompt、controls、preset、model、profile/template version。
- `MediaAsset` 支持关联 `characterId` 和 `sourceJobId`。
- Chat 可通过 `chat.image.requested` 异步创建图片任务。
- Admin 已有 model profile、prompt template、job detail 等底座；模型资产和 runner 组件归工程侧 seed/config 管理，不作为普通运营入口。

已补齐的缺口是：角色的稳定面部、发型、体型、风格、参考图、种子、质量评分和版本回放已有统一 CVP 契约；CVP anchor/reference 与 More-like-this source image 都能进入 image queue payload，由 worker hydrate 成 base64 或签名 URL，并以 `reference_images` 传给 pipeline。队列入口会读取 `GenerationModelProfile.runnerConfig.capabilities`：不支持 reference/init-image 的模型只走稳定 identity prompt + seed，不会收到对应参考图。当前本地 Pornmaster/Z-Image smoke 证明 More-like-this `source_image -> --init-img` 可用，但 identity `--ref-image` 不适用于该默认 profile。仍待补齐的是更强的 LoRA / embedding / IP-Adapter / face reference 模型侧控制与人工质量评估。

## 2. 第一性原理

### 2.1 用户真正购买的不是图片，而是关系的可视化

用户在聊天中对角色形成心智模型：长相、气质、亲密度、记忆、说话方式、场景。图片生成如果漂脸或漂风格，会直接破坏角色陪伴的连续性。

所以图片生成的首要目标不是“更自由”，而是“在自由场景中保持同一角色”。

### 2.2 一致性来自身份约束，不来自更长 prompt

单纯把 `description + appearance + user prompt` 拼长，只能提升局部命中率，不能保证一致性。稳定性需要分层：

1. **Identity Anchor**：角色不可随意漂移的视觉身份。
2. **Scene Layer**：本次想生成的姿势、服装、背景、动作、镜头。
3. **Style Layer**：realistic/anime、模型、画幅、质感。
4. **Continuity Layer**：来自 chat 当前剧情或用户上一次满意图片的延续。
5. **Quality Layer**：负面 prompt、输出筛选、用户反馈、版本回放。

### 2.3 角色创建就是训练生成系统认识这个角色

Create 不只是创建聊天 persona。它应该同时生成或采集一份“视觉角色卡”：

- 用户选择的外观字段。
- 角色首张头像/封面。
- 系统生成的稳定视觉描述。
- 参考图集合。
- 可复现 seed。
- 后续可绑定的 LoRA / IP-Adapter / face reference / embedding。

这份视觉角色卡在后续所有图片入口复用。

### 2.4 每一次出图都应可解释、可复现、可改进

生成任务必须记录当次使用的：

- character visual profile version。
- generation model profile version。
- prompt template version。
- reference assets。
- seed / subseed。
- preset stack。
- consistency strategy。
- quality result。

否则无法判断“为什么这次不像”、“为什么昨天像今天不像”、“换模型后哪些角色受影响”。

### 2.5 一致性分两条技术路径

角色一致性不应被简化为“训练一个 LoRA”。当前产品要同时支持两条路线，并按模型能力渐进增强：

1. **文生图一致性**：当底层是纯 text-to-image 模型时，一致性来自稳定 `identityPrompt`、负面身份约束、固定/可追踪 seed、固定模型 profile、固定 prompt template，以及对用户 prompt 的 scene-only 分层。这个路径不依赖参考图，适合 Create 初期、无 anchor 的角色、低成本批量生成。
2. **图生图/参考图一致性**：当底层支持 image-to-image、reference image、IP-Adapter、PhotoMaker、PuLID 或类似能力时，一致性来自 CVP anchor/reference assets。当前本地 sd.cpp gateway 已把 More-like-this source image 映射到 `--init-img`；identity refs 只会发给显式声明 `referenceImages=true` 且通过 smoke 的模型。默认 Pornmaster/Z-Image 不启用 identity `--ref-image`。这条路径适合已有基准图、Gallery 反馈、官方角色高质量生产。

模型是否走第 2 条路线由后台 model profile 声明，而不是由前端猜测。当前能力字段为 `textToImage`、`stableSeed`、`referenceImages`、`initImage`、`lora`；`lora` 先作为未来开关保留。

LoRA/adapter 是未来高频角色和官方角色的增强路线，不是 P0 的前置条件。

### 2.6 MVP 模型策略：少数内置模板，不把复杂度暴露给用户

角色图片生成的产品面不应该让用户理解 sd.cpp、ComfyUI、VAE、text encoder、sampler
或本地文件路径。用户只应感知三件事：

1. 生成的是哪个角色。
2. 一致性强度是 Balanced / Strict / Creative。
3. 这次是否基于参考图继续生成。

后台保留 `GenerationModelProfile` 作为稳定抽象，但默认运营入口应收敛成少数工程 seed 的内置模板：

| 模板 | 产品用途 | 一致性来源 | 当前状态 |
| --- | --- | --- | --- |
| `Text identity template` | 无参考图时生成角色图 | CVP identity prompt + negative identity + stable seed + profile/template version | 可用路径，具体模型需通过 20 张人工一致性 smoke 后发布 |
| `Reference identity template` | 已有 anchor/reference 图时生成同角色变体 | CVP identity prompt + anchor/reference image + init/ref strength + stable seed | 可用路径，具体模型需声明 `referenceImages/initImage` 并通过人工 smoke |
| `Advanced custom profile` | 工程/模型运维排查 | 完整 runnerConfig | 仅作为工程诊断能力，不作为默认入口 |

sd.cpp 是第一批内置 runner，不是模型管理的全部。后续 ComfyUI、外部 API、专用
IP-Adapter/LoRA 服务都接入同一个 profile/capabilities 层。前端和 Chat 不关心 runner，
只根据能力决定是否传参考图。

2026-06-30 本地候选模型结论：

- 已跑通的默认 sd.cpp 生图链路是 `pornmaster-zimage-turbo`：主站普通图片生成与
  admin test-job 都能产出 512x640 PNG，且 `cfgScale=1` 是该链路的有效默认值。
  这条路径继续作为 active/default；Redcraft 只作为待修复候选模型验证。
- `/Users/kk/Downloads/models/redcraftKREA2RedMix_krea2Edition.safetensors` 已登记为
  `Redcraft Krea2 ComfyUI checkpoint candidate`，不是 sd.cpp text template；本地 sd.cpp
  直跑 safetensors/gguf 均产出纯白图；
  官方 sd.cpp Krea2 组件组合 `Qwen3VL GGUF + Wan2.1 VAE` 在 Apple Silicon 上需要
  `backend=vae=cpu` 才能避开
  Metal VAE decode 的 `IM2COL_3D` abort，但退出码为 0 的样本仍被 sanity guard 判为纯白；
  qwen_image VAE 与 `guidance=0` 变体也同样纯白。2026-06-30 追加 25 样本矩阵，
  覆盖 scheduler、guidance、`mu=1.15`、VAE format、GGUF diffusion、`--model`、
  no diffusion-fa、no offload、CPU backend；所有成功退出样本仍是纯白，fp8 text encoder
  safetensors 在 sd.cpp metadata shape validation 失败。Civitai 文件标为 fp8 SafeTensor，
  文件名是 `Krea2RedMix-10Steps-fp8-scaled-ComfyUI.safetensors`，当前应视为
  ComfyUI FP8 checkpoint，而不是已验证可发布的 sd.cpp 内置模板。ComfyUI GGUF text encoder 会在
  `CLIPLoader` 把 `.gguf` 当 torch 文件加载时报错，fp8 text encoder 进入 MPS
  KSampler 后仍遇到 `Float8_e4m3fn` 不支持。已补一个拆分节点 ComfyUI CPU workflow
  `packages/gen/workflows/redcraft-krea2-comfyui-text.json`，并用
  `bun run launch:probe:redcraft-comfyui` 跑通 256x384、2 steps 非退化 PNG；随后通过
  `bun run launch:probe:redcraft-image:local` 走通 OpenAI-compatible gateway、gen
  `probe:image` 和 blob 写入。`bun run launch:probe:redcraft-consistency:local -- --output .tmp/redcraft-consistency-review --samples 20`
  已按默认 `seedMode=locked` 生成 20 张样本、review 页面和 contact sheet；人工评审
  17/20 为同一角色，`consistencyRate=0.85`，已写回 seed dry-run summary。该模型可作为
  已验证的内置 ComfyUI 候选，但仍不自动发布到用户路径，需等托管 gateway 后再导流。
- `/Users/kk/Downloads/models/darkBeastKrea2_dbkleinv2BFS.safetensors` 的元数据指向
  Flux.2 Klein reference/face-swap 路线，不是可直接套 Krea2 sd.cpp 的图生图模板。
  2026-06-30 已按你给的 Civitai 链接核对：Dark Beast 集合本身有 Krea 2 版本
  `3078453`，但本地 `dbkleinv2BFS` 文件对应 `modelVersionId=2740209`，
  `baseModel=Flux.2 Klein 9B`，AutoV2 `B20B6F2744`。本地文件只是 diffusion/UNet
  资产。已解析 BFS Head Swap workflow：它需要 body/base image + face/identity image
  两张输入，分别映射到产品里的 `source_image/initImage` 和
  `identity_reference/referenceImages`；还需要 Flux.2 Klein base、Qwen text encoder、
  Flux2 VAE、head-swap LoRA 与 ComfyUI conditioning workflow。当前本机缺
  `/Users/kk/.localai/models/flux2-vae.safetensors`、Flux.2 Klein base、
  Qwen encoder、BFS LoRA 与可导入 workflow；先登记为 `DarkBeast reference candidate`
  draft，不作为 active 模板。

发布门槛：任何候选模板必须生成至少 20 张角色一致性样本，人工确认 80% 以上像同一角色，
且不能出现空白/纯噪声/明显坏图，才允许 `enabled=true`、`status=active`、`rolloutPercent>0`。

## 3. 产品目标

P0 目标：

1. 用户从角色详情、Chat、Generate 生成该角色图片时，默认保持同一角色长相和风格。
2. Create 角色时生成一个可复用的视觉身份快照。
3. 每个角色有可管理的参考图和“设为角色基准图”能力。
4. 每个 GenerationJob 记录视觉身份版本，结果可回放和诊断。
5. Gallery 中支持把满意图片反馈给角色身份，提高后续一致性。

P1 目标：

1. 支持多套角色造型：日常、约会、奇幻、职业、睡衣等 wardrobe/look。
2. 支持从一张满意图生成变体、扩图、换背景、换服装。
3. 支持高一致性模型路线：LoRA、IP-Adapter、ControlNet/OpenPose、face reference。
4. 支持 Admin 批量为官方角色生产封面、详情页主图和 Feed 图，并绑定视觉身份。

非目标：

- 不把 Freeplay 强行绑定角色一致性。Freeplay 是无角色自由生成。
- 不在 P0 做用户上传真人照片训练。
- 不在 P0 做完整视频角色一致性，视频沿用同一身份对象但作为后续阶段。

## 4. 核心对象：Character Visual Profile

新增概念：`CharacterVisualProfile`，简称 CVP。

CVP 是某个角色的视觉身份版本。一个 Character 可以有多个 CVP，但同一时间只有一个默认 active 版本。

### 4.1 CVP 字段

建议字段：

| 字段 | 含义 |
| --- | --- |
| `id` | visual profile id |
| `characterId` | 所属角色 |
| `version` | 递增版本 |
| `status` | `draft` / `active` / `archived` |
| `style` | `realistic` / `anime` / `hybrid` / `other` |
| `identityPrompt` | 稳定身份描述，只写不可漂移特征 |
| `negativeIdentityPrompt` | 避免漂移的身份负面词 |
| `faceTraits` | 脸型、眼睛、鼻子、嘴唇、肤色等结构化字段 |
| `hairTraits` | 发色、发型、长度、刘海、质感 |
| `bodyTraits` | 身高感、体型、姿态特征 |
| `signatureTraits` | 痣、纹身、眼镜、耳饰等强识别点 |
| `styleTraits` | 摄影/插画质感、年龄感、气质关键词 |
| `anchorAssetIds` | 角色基准图，1-4 张 |
| `referenceAssetIds` | 可选参考图池 |
| `defaultSeed` | 默认 seed，帮助早期保持稳定 |
| `adapterRefs` | LoRA / embedding / IP-Adapter / face ref 配置 |
| `qualityScore` | 人工或自动质量评分 |
| `consistencyScore` | 和基准图的一致性评分 |
| `createdFrom` | `create_preview` / `admin_seed` / `gallery_promote` / `manual` |
| `createdAt` / `updatedAt` | 时间 |

### 4.2 身份 Prompt 原则

`identityPrompt` 只描述角色稳定身份，不写一次性场景。

应包含：

- 成人角色、性别表达、整体风格。
- 面部结构：脸型、眼睛、眉毛、鼻子、嘴唇。
- 发型与发色。
- 肤色、体型、身高感。
- 1-3 个强识别点。
- 气质和镜头感。

不应包含：

- 当前背景、姿势、服装。
- 聊天剧情。
- 用户本次要求。
- 过多同义词堆叠。
- 容易改变身份的矛盾描述。

### 4.3 造型 Look

P1 新增 `CharacterLook`：

| 字段 | 含义 |
| --- | --- |
| `id` | look id |
| `characterId` | 所属角色 |
| `visualProfileId` | 基于哪个 CVP |
| `label` | 例如 Daily、Date Night、Fantasy、Gym |
| `outfitPrompt` | 稳定服装/造型描述 |
| `referenceAssetIds` | look 参考图 |
| `status` | active/archived |

Look 不改变脸和基础身份，只改变可切换造型。

## 5. 用户流程设计

### 5.1 Create：创建角色时建立视觉身份

目标：用户创建的不是一条文字 persona，而是一个可聊天、可生成、可延续的角色。

流程：

```text
Identity -> Appearance -> Personality -> Visual Preview -> Publish
```

在现有 5 步向导基础上，Visual Preview 步升级为：

1. 系统根据 gender/style/appearance/hair/body/advancedDetails 生成 4 张候选预览。
2. 用户选择最像预期的一张作为 `anchorAsset`。
3. 用户可以点击 Regenerate，保留同一身份字段但换 seed/构图。
4. 用户确认后创建 CVP v1。
5. 最终提交 Character 时，把 `Character.imageAssetId` 指向 anchor asset，并把 CVP v1 设为 active。

关键交互：

- “Set as identity”用于选择基准图。
- “More like this”基于某张候选生成变体。
- “Edit traits”回到外观字段，而不是让用户手写复杂 prompt。
- 失败时保留草稿，允许跳过预览但标记 `visualProfile.status=draft`，角色后续第一次生成前补齐。

P0 最简实现：

- 先不做真实训练，只保存结构化 CVP + anchor image + default seed。
- 生成 prompt 时强制注入 CVP identityPrompt。

### 5.2 Character Detail：角色视觉承诺前置

角色详情页应展示：

- 当前角色主图。
- 2-4 张官方/创作者精选图。
- “Generate this character”入口。
- “Remix scene”入口：带 characterId 进入 Generate。

如果角色缺 CVP：

- 官方角色：Admin 必须补齐后再推荐。
- 用户私有角色：允许进入 Generate，但先引导生成身份基准图。

### 5.3 Generate：角色优先的生成器

生成器默认围绕角色工作，而不是 prompt 工具。

推荐结构：

```text
Character / Freeplay
  -> Character selected
  -> Scene
  -> Outfit
  -> Pose
  -> Background
  -> Framing
  -> Style & Model
  -> Count
  -> Advanced Prompt
  -> Generate
```

P0 页面变化：

- 角色选择器显示头像、名称、style、是否有 identity profile。
- 选中角色后显示“Identity locked”状态。
- Advanced Prompt 改名为“Scene prompt”或“Extra details”，避免用户误以为要重写角色长相。
- Prompt 输入框提示用户描述场景、动作、气氛，而不是描述角色是谁。
- 加一个可选开关：`Consistency`
  - Balanced（默认）：稳定角色 + 允许场景自由。
  - Strict：更像基准图，姿势/构图自由度降低。
  - Creative：允许更大风格变化，但仍保留核心特征。

P0 生成请求：

```json
{
  "mode": "image",
  "characterId": "char_x",
  "visualProfileId": "cvp_active",
  "consistencyMode": "balanced",
  "scenePrompt": "sitting by a neon window at night",
  "controls": {
    "backgroundPresetId": "...",
    "posePresetId": "...",
    "outfitPresetId": "...",
    "orientation": "4:5",
    "model": "profile_image_default_v1"
  },
  "outputCount": 4
}
```

服务端仍可兼容现有 `prompt` 字段，但产品语义上把它视为 scene prompt。

### 5.4 Chat：图片是当前关系的一次可视化回复

Chat 触发图时，用户不应该离开聊天上下文。

触发方式：

- 用户明确要求：“发张照片”“让我看看你现在的样子”。
- 角色主动建议生成图片，但需要用户确认。
- 用户点击消息工具栏中的 image action。

Chat 侧只负责生成 scene intent，不负责重写角色身份。

Chat image payload 应包含：

| 字段 | 含义 |
| --- | --- |
| `characterId` | 当前角色 |
| `messageId` / `attachmentId` | 幂等与回调 |
| `scenePrompt` | 当前剧情里的动作、场景、镜头 |
| `conversationContext` | 可选摘要，只用于 scene，不用于身份 |
| `orientation` | 默认 4:5 |
| `consistencyMode` | 默认 strict 或 balanced |

主站生成服务接收后：

1. 读取 active CVP。
2. 拼接 identity + scene + chat context。
3. 创建 `sourceType=chat_image` 的 GenerationJob。
4. 完成后通过 outbox 回写 chat attachment。

关键原则：Chat 模型不要自己描述角色五官，避免和 CVP 冲突。Chat 只描述此刻发生了什么。

### 5.5 Gallery：用户反馈进入角色身份闭环

每张生成图都应该提供这些动作：

- Like。
- Download。
- Delete。
- Make private / unlisted。
- Retry。
- Variations。
- Use as character image。
- Add to identity references。
- More like this。
- Less like this。

P0 重点是两个动作：

1. **Use as character image**：把图片设为 `Character.imageAssetId`，并把该图片提升为 active CVP 的主 anchor，触发新 CVP version。
2. **Add to identity references**：把图片加入 active CVP 的 reference pool，并触发 CVP minor version。

当用户多次选择“More like this”或“Add to identity references”，系统应逐步提高该视觉方向的权重。

### 5.6 Admin / Content Ops：官方角色必须先有视觉身份

官方角色生产流程：

```text
Create official character
  -> fill persona + appearance
  -> generate identity batch
  -> select anchor
  -> publish CVP v1
  -> generate cover/detail/feed variants
  -> approve assets
  -> place assets
```

Admin 必须能看到：

- 角色是否有 active CVP。
- CVP anchor 图。
- identity prompt。
- 使用的 model profile / prompt template。
- 最近生成图的一致性评分。
- 哪些生成任务漂移严重。

## 6. 生成 Prompt 分层

### 6.1 Prompt Assembly

服务端应使用统一 prompt assembler：

```text
System quality prefix
+ Character identity layer
+ Character style layer
+ Scene layer
+ Preset layer
+ Chat continuity layer
+ Camera/composition layer
+ Quality suffix
```

示例：

```text
High quality in-character portrait of {character.name}.
Identity: {cvp.identityPrompt}.
Style: {character.style}, {cvp.styleTraits}.
Scene: {scenePrompt}.
Presets: {background}, {pose}, {outfit}.
Composition: {orientation}, visible face, coherent body, clean framing.
```

Negative prompt：

```text
{profile.negativeBase},
{cvp.negativeIdentityPrompt},
identity drift, different face, different hairstyle, inconsistent eye color,
low quality, distorted anatomy, extra fingers, watermark, text, UI, chat bubbles
```

### 6.2 Consistency Modes

| Mode | 产品语义 | 技术策略 |
| --- | --- | --- |
| `strict` | 最像角色本人 | 强注入 identity、固定 seed 或 reference、低风格变化、优先 face/IP adapter |
| `balanced` | 默认，像本人且场景自然 | 注入 identity + reference，scene 权重正常 |
| `creative` | 允许造型和风格探索 | 保留核心脸/发/识别点，放宽 outfit/style |

### 6.3 参考图策略

P0：

- 保存 anchor asset。
- prompt 注入 identity traits。
- 使用稳定 seed。

P1：

- IP-Adapter / face reference。
- ControlNet/OpenPose 用于姿势。
- 多 reference 加权。

P2：

- 每个高价值官方角色训练 LoRA。
- 用户角色达到足够反馈后生成轻量 adapter。
- 自动评估生成图和 anchor 的相似度。

## 7. 数据模型建议

### 7.1 新增表

```prisma
model CharacterVisualProfile {
  id                     String   @id @default(cuid())
  characterId            String
  version                Int      @default(1)
  status                 String   @default("draft") // draft | active | archived
  style                  String
  identityPrompt         String
  negativeIdentityPrompt String?
  faceTraits             Json
  hairTraits             Json
  bodyTraits             Json
  signatureTraits        Json
  styleTraits            Json
  anchorAssetIds         Json
  referenceAssetIds      Json
  defaultSeed            String?
  adapterRefs            Json
  qualityScore           Float?
  consistencyScore       Float?
  createdFrom            String
  createdAt              DateTime @default(now())
  updatedAt              DateTime @updatedAt

  @@index([characterId, status])
  @@unique([characterId, version])
  @@map("character_visual_profiles")
}
```

```prisma
model CharacterLook {
  id              String   @id @default(cuid())
  characterId     String
  visualProfileId String
  label           String
  outfitPrompt    String
  referenceAssetIds Json
  status          String   @default("active") // active | archived
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([characterId, status])
  @@map("character_looks")
}
```

### 7.2 扩展 GenerationJob

建议新增：

| 字段 | 含义 |
| --- | --- |
| `visualProfileId` | 使用的 CVP id |
| `visualProfileVersion` | 使用的 CVP version |
| `consistencyMode` | strict/balanced/creative |
| `seed` | job seed |
| `referenceAssetIds` | 当次实际使用的参考图 |
| `assembledPromptHash` | 拼接后 prompt hash |

这些字段可以先放进 `controls` / `sourceMeta` 过渡，再迁移成列。

### 7.3 扩展 MediaAsset metadata

建议写入：

```json
{
  "visualProfileId": "cvp_x",
  "visualProfileVersion": 1,
  "consistencyMode": "balanced",
  "seed": "12345",
  "profileId": "profile_image_default_v1",
  "promptTemplateId": "image_character_default_v1",
  "referenceAssetIds": ["asset_anchor"],
  "quality": {
    "consistencyScore": null,
    "selectedAsAnchor": false,
    "addedToReferences": false
  }
}
```

## 8. API 设计

### 8.1 Visual Profile

```text
GET /api/v1/characters/:id/visual-profile
POST /api/v1/characters/:id/visual-profile
PATCH /api/v1/characters/:id/visual-profile/:profileId
POST /api/v1/characters/:id/visual-profile/:profileId/activate
POST /api/v1/characters/:id/visual-profile/:profileId/references
DELETE /api/v1/characters/:id/visual-profile/:profileId/references/:assetId
```

### 8.2 Generation

现有 `POST /api/v1/generation/jobs` 扩展：

```json
{
  "mode": "image",
  "characterId": "char_x",
  "freeplay": false,
  "prompt": "scene details, backwards compatible",
  "visualProfileId": "cvp_x",
  "consistencyMode": "balanced",
  "seed": "optional",
  "controls": {
    "orientation": "4:5",
    "model": "profile_image_default_v1",
    "backgroundPresetId": "preset_bg",
    "posePresetId": "preset_pose",
    "outfitPresetId": "preset_outfit"
  },
  "outputCount": 4
}
```

服务端规则：

- 有 `characterId` 时默认加载 active CVP。
- 请求传 `visualProfileId` 时校验归属和可读权限。
- 没有 CVP 时创建降级 job，但返回 `identityProfileMissing=true`，前端提示先建立身份基准。
- `prompt` 在角色模式下解释为 scene prompt。
- Freeplay 不允许传 `visualProfileId`。

### 8.3 Gallery Feedback

```text
POST /api/v1/media/:id/use-as-character-image
POST /api/v1/media/:id/add-to-identity
POST /api/v1/media/:id/variation
POST /api/v1/media/:id/feedback
```

feedback body：

```json
{
  "signal": "more_like_this",
  "reason": "face_matches"
}
```

## 9. Worker 与模型策略

### 9.1 P0：Prompt + Seed + Anchor

P0 不要求训练。目标是用现有 sd.cpp pipeline 做到“明显比纯 prompt 稳定”。

实现：

- CVP active 后，生成时读取 `identityPrompt`。
- 使用角色级 `defaultSeed` 作为 seed 基础，单 job 用 `hash(characterId + visualProfileVersion + jobId + index)` 派生。
- 将 anchor/ref asset id 写入 metadata，哪怕底层 runner 暂时不用。
- prompt template 强制分层，避免用户 prompt 覆盖身份。
- 输出支持“设为基准图”和“加入参考图”。

队列侧按 model profile 能力选择策略：

- `textToImage=true` + `stableSeed=true`：总是注入 CVP `identityPrompt`、`negativeIdentityPrompt` 和稳定 seed。
- `referenceImages=true`：允许 CVP anchor/reference 进入 `reference_images`，由模型服务做身份参考。
- `initImage=true`：允许 Gallery `More like this` 的 source image 进入 `reference_images`，由模型服务做 image-to-image variation。
- `lora=true`：未来允许消费 CVP `adapterRefs`；当前默认关闭，不作为 P0 依赖。

不支持 reference/init-image 的模型必须自动降级为 text+seed 路径，不能把不可消费的参考图塞进 provider 请求。

### 9.2 P1：Reference-Conditioned Generation

已完成 reference transport：`ImageGeneratePayload.referenceImages`、main local pipeline、`packages/gen` worker、main/gen pipeline provider 都会传递 reference descriptors / base64 / signed URL。本地 sd.cpp gateway 会按 profile capability 把这些参考图转成 sd-cli 可执行参数：

- identity anchor/reference -> `--ref-image`（仅限显式 `referenceImages=true` 且通过 smoke 的模型；当前 Pornmaster/Z-Image 未启用）。
- More-like-this source image -> `--init-img` + `--strength`。
- 多 identity refs -> 多个 `--ref-image` + `--increase-ref-index`。

下一步是把这些参考图进一步接到更强的身份控制能力：

- CVP anchor assets 作为 face/IP adapter input。
- Pose preset 接 ControlNet/OpenPose。
- Outfit/look reference 接 style/reference adapter。
- consistency mode 控制 adapter 权重。

### 9.3 P2：Character Adapter

对官方角色和高活跃用户角色：

- 训练 LoRA / textual inversion / embedding。
- CVP `adapterRefs` 指向 adapter asset。
- Admin 可发布 adapter version。
- GenerationJob 记录 adapter version。

## 10. UI 信息架构

### 10.1 Generate 页

建议面板：

```text
Left control panel
  Balance / cost
  Character selector
    avatar, name, identity status
  Consistency segmented control
    Balanced / Strict / Creative
  Scene
    prompt textarea
  Presets
    Background / Pose / Outfit
  Style & model
    model, orientation, count
  Advanced
    negative prompt, seed
  Generate button

Right workspace
  Jobs
  Latest result grid
  Gallery tabs
```

注意：

- 不把身份字段塞给普通用户编辑；普通用户编辑角色外观，系统生成身份字段。
- Prompt 框的文案应强调“描述场景”，减少用户反复写角色外貌。
- 一致性状态要可见：`Identity locked · CVP v3`。

### 10.2 Create Preview

新增组件：

- Candidate grid。
- Set as identity。
- More like this。
- Trait chips。
- Identity status。

### 10.3 Gallery

在每张图 actions 菜单增加：

- Use as character image。
- Add to identity。
- More like this。
- Create variation。

## 11. 指标与验收

### 11.1 用户指标

| 指标 | 目标 |
| --- | --- |
| 角色图生成后 Like rate | 提升 |
| “More like this”使用率 | 有稳定使用 |
| 删除率 / 重试率 | 下降 |
| Chat 图片请求完成率 | 提升 |
| 生成后回到 Chat 的比例 | 提升 |
| 角色详情 -> Generate 转化 | 提升 |

### 11.2 一致性指标

P0 人工评估：

- 每个 demo 角色生成 20 张图。
- 至少 80% 被人工判定“像同一角色”。
- Strict 模式高于 Balanced。
- Creative 模式允许服装/场景漂移，但核心脸和发型不能漂。
- 至少分别跑一次 text-to-image text+seed 路径和 image-to-image reference 路径；没有 reference 的角色不得阻塞文生图一致性验证。

P1 自动评估：

- image embedding similarity。
- face similarity。
- hair/color trait classifier。
- 输出异常检测。

### 11.3 工程验收

- Create 私有角色后生成 CVP v1。
- Generate 角色图时 job 记录 visual profile version。
- Chat 图片请求不直接覆盖 identity，只传 scene intent。
- Gallery 可把图片设为 character image。
- Gallery 可把图片加入 identity references。
- Admin 可查看角色是否缺 active CVP。
- `bun run launch:probe:character-consistency -- --provider mock` 可快速验证 text-only/reference-backed review 流程会生成样本占位、`manifest.json` 和人工 review 页面；真实一致性复核改用 `--provider pipeline` 并连接目标图片 runner。
- `bun run launch:probe:generation-model-candidates -- --candidate pornmaster_zimage_default,redcraft_krea2_text` 可审计当前两套内置配置：Pornmaster 必须保持 active/ready；Redcraft 是 ComfyUI/Krea2 checkpoint candidate，已通过锁 seed 20 样本人工一致性门槛，但默认仍保持 `draft + enabled=false + rolloutPercent=0`，等托管 gateway 后再导流。`redcraft_krea2_text` 是历史兼容 key，当前期望 runner 是 `comfyui`，不是 sd.cpp text template。加 `--candidate pornmaster_zimage_default --require-ready` 可验收默认模板，加 `--candidate redcraft_krea2_text --require-ready` 可单独验收 Redcraft 是否达到发布门槛。`bun run launch:probe:redcraft-comfyui` 只验证 Redcraft 当前 ComfyUI CPU workflow 能否出非退化图；`bun run launch:probe:redcraft-image:local` 验证它能通过统一 gen pipeline 写入 blob；`bun run launch:probe:redcraft-consistency:local` 生成 20 张样本和 review 页面，默认使用 `seedMode=locked` 以模拟主站 `CharacterVisualProfile.defaultSeed`。
- `GenerationModelProfile.runnerConfig.capabilities` 控制参考图分流：text-only 模型保留 identity prompt + seed 但不会收到 CVP reference images；支持 reference/init-image 的模型才收到对应图片描述符。**已覆盖。**
- 生成失败、退款、gallery 行为沿用现有逻辑。

## 12. 实施分期

### Phase 1：不训练的一致性底座

目标：最小改动建立视觉身份闭环。

任务：

1. 新增 `CharacterVisualProfile` 表。
2. Create submit 时根据现有 appearance/hair/body/advancedDetails 生成 CVP v1。
3. 角色 preview 成功后把结果设为 anchor asset。
4. `createGenerationJobForUser` 读取 active CVP 并用 prompt assembler 拼接。
5. `GenerationJob.controls` 写入 visual profile id/version、consistency mode、seed、reference asset ids。
6. Generate UI 增加 identity status 和 consistency mode。**已落地。**
7. Gallery 增加 use-as-character-image / add-to-identity / more-like-this。**已落地；Use as character image 会更新 CVP anchor。**
8. Official Admin 列表展示 active CVP / missing 状态，官方角色创建与身份编辑会维护 CVP version。**已落地。**
9. 回归测试覆盖 Create -> Generate -> Chat image -> Gallery -> Add reference / More-like-this / Official CVP。**已落地。**
10. `ImageGeneratePayload.referenceImages` 将 CVP anchor/reference 和 More-like-this source image 带进 worker/provider 请求。**已落地。**
11. `sdcpp-image` gateway 消费 `reference_images` 并按 capability 映射到 `--init-img` 或 `--ref-image`；当前 Pornmaster/Z-Image 只启用 `--init-img`，identity `--ref-image` 需要 reference-capable profile。**已落地。**
12. 增加角色一致性 smoke runner，支持 text-to-image text+seed 和 image-to-image reference 两种评估路径。**已落地。**

### Phase 2：参考图条件生成

目标：底层 pipeline 开始实际使用 anchor/reference。

任务：

1. 扩展 `ImageGeneratePayload` 支持 `referenceImages`。**已落地。**
2. `packages/gen` provider 支持把 reference hydrate 后传给 pipeline。**已落地。**
3. 本地 sd.cpp gateway 把 `reference_images` 映射到 sd-cli reference / init image conditioning。**已落地。**
4. Admin model profile 增加 reference support flags。**已落地为 `runnerConfig.capabilities`，并在用户生成、admin requeue/test job 队列入口生效。**
5. Pipeline 模型服务把 `reference_images` 进一步映射到 face/IP adapter、style reference 或专用 image-to-image conditioning。
6. Consistency mode 映射 adapter/reference 权重到模型服务参数。
7. 增加图像一致性人工评估工作台。

### Phase 3：官方角色高一致性生产

目标：官方角色达到稳定商业质量。

任务：

1. Content Ops 增加 identity batch。
2. 官方角色发布前必须 active CVP。
3. 支持 LoRA/adapter refs。
4. 支持 CVP publish/rollback。
5. 自动对比 profile/template 变更对角色一致性的影响。

## 13. 当前代码落点

直接相关文件：

- `packages/main/prisma/schema.prisma`
- `packages/main/src/server/modules/ourdream/service.ts`
- `packages/main/src/components/ourdream/CreateWorkspace.tsx`
- `packages/main/src/components/ourdream/GeneratorWorkspace.tsx`
- `packages/main/src/server/ai/schemas.ts`
- `packages/main/src/server/ai/local-pipeline.ts`
- `packages/main/src/processes/event-consumer.ts`
- `packages/chat/src/agent-tools.ts`
- `packages/gen/src/providers.ts`
- `packages/gen/src/pipeline.ts`
- `packages/gen/src/sdcpp-openai-image-server.ts`

最关键的第一处代码改造是把 `buildImageGenerationPrompt` 拆成版本化 assembler：

```text
buildImageGenerationPrompt
  -> resolveCharacterVisualProfile
  -> assembleCharacterImagePrompt
  -> record visual profile metadata
```

## 14. 产品原则

1. 角色身份优先，用户 prompt 只能改变场景，不应默认改脸。
2. 一致性默认开启，不让用户学习底层模型术语。
3. 用户满意图要能反哺角色，而不是只躺在 Gallery。
4. 每次生成都可回放：角色身份版本、模型版本、模板版本、seed、参考图必须留痕。
5. Admin 运营官方角色时，先建立视觉身份，再批量生产素材。
6. Freeplay 保持自由；Character generation 保持角色连续性。
