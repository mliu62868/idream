# 角色图片生成系统：从“生图工具”到“关系的视觉记忆”

更新日期：2026-07-17
状态：V2 产品目标、领域对象与跨服务不变量的单一事实来源；可执行 schema/event/runbook 由关联工程契约承载
适用范围：Create、Character Detail、Chat、Generate、Gallery、Admin、`packages/main`、`packages/chat`、`packages/gen`

> **Admin Character Asset Studio（2026-07-16）**：官方角色图片生产已收敛为 Primary portrait / Character hero / Chat moments 三段决策式工作台。空白角色不会先制造无锚点的纯文字 identity，而是在 Assets 中生成 4 张无参考首肖像，经结构化审核后原子建立 reviewed identity、Reference Set rev1 与 Primary portrait 草稿；已有受审身份的角色继续使用 sealed references 与 qualified route。产品与业界实践结论见 [`CHARACTER_ASSET_STUDIO_REVIEW.md`](./CHARACTER_ASSET_STUDIO_REVIEW.md)，日常操作见 [`CHARACTER_ASSET_STUDIO_OPERATIONS_GUIDE.md`](./CHARACTER_ASSET_STUDIO_OPERATIONS_GUIDE.md)，草稿、审核与发布权威见 [`ADR-12`](../architecture/16-character-asset-studio-authority.md)。

本文收敛并取代下列文档中互相重叠的产品决策；旧文档继续保留历史实现记录：

- `CHARACTER_CONSISTENT_IMAGE_GENERATION_PRD.md`
- `CHARACTER_IMAGE_GENERATION_FLOW_BLUEPRINT.md`
- `docs/superpowers/specs/2026-07-07-image-generation-redesign-design.md` 的用户产品面

> **Admin Release 实现补充（2026-07-11）**：`active CharacterVisualProfile`、sealed `ReferenceSetRevision` 与 `qualified GenerationRouteQualification` 是三个独立事实；只有三者与角色级 QA、精确 generation provenance 一起被 immutable Character Release snapshot 固定，才可显示 release ready。route 的 sampleCount 必须 ≥40、identityMatch ≥90%，policy/evaluator/expiry 漂移会使 readiness stale，但不会静默改写历史证据或自动下线当前 Serving。详见 [`ADR-11`](../architecture/15-admin-operating-system-authority-adr.md)。

> **ComfyUI runtime 实现补充（2026-07-17）**：`qwen-image-edit-img2img`、`qwen-image-edit-multi-identity`、`qwen-image-edit-multi-reference`、`redcraft-krea2-txt2img` 四个 workflow 已完成 ComfyUI UI sync 与 readback。single reference、dual identity、identity + source 的真实 artifact 均为 832×1216：`/private/tmp/idream-qwen-img2img-smoke.png`（SHA-256 `3e0bdfa40aa9f70fa7c6fbaeb38f360254c89febf31988221ae2ef2b54fc5ea5`）、`/private/tmp/idream-qwen-multi-identity-smoke/sample-01.png`（SHA-256 `965c9f20dd71cd294429bc7c87e940328d441fd48380599aee533343162cb512`）、`/private/tmp/idream-qwen-identity-source-smoke.png`（SHA-256 `b2361c115cf2b8351303cc468d82661f0a40074bee4b026927bcf4e9a889d6e5`）。这只关闭本地 descriptor → ComfyUI → artifact 证明，不自动满足 route qualification、identity-bleed eval、profile publish 或生产容量 Gate。

## 1. 产品结论

AI 陪伴产品的图片生成不是“输入 prompt，返回图片”。它的核心承诺是：

> 用户每次看到的都是同一个角色，只是她正在经历不同的时刻。

因此产品单位不是一张图片，而是一个可被聊天、记忆和后续创作引用的“关系时刻”。系统需要同时保证：

1. **身份连续**：脸、发型、体型、年龄感和标志特征不漂移。
2. **造型连续**：某套服装、妆容或世界观造型可以被命名、复用和延续。
3. **剧情连续**：图片理解当前聊天地点、动作、情绪和上一张图片。
4. **表达自由**：场景、镜头、光线、姿势和风格仍有足够变化。
5. **失败可恢复**：不像、画坏、生成失败和用户不喜欢是四类不同失败，必须分别处理。

角色身份是系统责任，不是用户要调的参数。用户只需要表达“想看什么时刻”。

## 2. 第一性原理

### 2.1 用户为什么要图片

图片在陪伴关系里承担五个任务：

| 任务 | 用户感受 | 产品结果 |
|---|---|---|
| 身份确认 | “她还是她” | 关系可信度 |
| 场景具象化 | “我看见了我们刚才聊的那一刻” | 对话沉浸与继续聊天 |
| 共同记忆 | “这是我们之间发生过的事” | 收藏、回看和长期留存 |
| 个性表达 | “这是我塑造出来的角色” | 所有感与创作者投入 |
| 付费价值 | “更稳定、更快、更可控” | 生成消费和订阅转化 |

漂亮但不像角色的图，在普通生图产品里只是低质量结果，在陪伴产品里是关系断裂。

### 2.2 一致性不是一个分数

一致性至少有五个独立维度：

| 维度 | 不应变化 | 可以变化 |
|---|---|---|
| Face ID | 脸部结构、眼睛、鼻口比例 | 表情、朝向、光线 |
| Body ID | 体型、肤色、年龄感 | 姿势、镜头距离 |
| Signature | 痣、纹身、眼镜等标志 | 是否被遮挡 |
| Visual style | 写实/动漫与基础画风 | 具体摄影或绘画处理 |
| Continuity | 当前已确认的服装、地点、道具 | 用户明确要求改变的部分 |

不能用一个 face embedding 分数代替全部一致性，也不能用固定 seed 代替身份控制。

### 2.3 身份、造型、时刻必须分层

```text
Character Identity（她是谁，长期不变）
        │
        ├── Character Look（她当前的稳定造型，可切换）
        │         │
        │         └── Moment Context（此刻发生什么，一次性）
        │                    │
        │                    └── Render Strategy（模型、workflow、seed、权重）
        │
        └── Feedback Memory（哪些结果更像她、更符合用户偏好）
```

身份变更必须显式确认并生成版本；换衣服或换场景不应该铸造新身份。

### 2.4 一致性与自由度不是让用户承担的选择题

当前 `Strict / Balanced / Creative` 是工程能力的投影。默认用户不需要理解它们：

- Chat：系统自动选策略，身份优先。
- Create：候选阶段允许探索，确认后锁定身份。
- Generate：默认“自然变化”；高级设置才提供“最像身份图 / 更有变化”。
- Freeplay：不绑定角色身份，可继续保留模型和高级参数。

系统按生成意图、参考图质量和模型能力自动选择策略；不能支持的控制不在 UI 中承诺。

## 3. 目标用户体验

### 3.1 一句话体验

用户选角色，描述一个时刻，系统自动保持身份并把结果带回聊天与相册。

### 3.2 用户只需要理解四个概念

1. **角色**：要生成谁。
2. **时刻**：她在做什么、在哪里、什么情绪。
3. **造型**：沿用当前造型，或选择一套已保存造型。
4. **方向**：对结果说“再来一张”“保持人物换场景”“这张不像她”。

Model、CFG、VAE、LoRA、IP-Adapter、negative prompt、visual profile version 都属于高级或运营信息。

## 4. 端到端用户流程

### 4.1 Create：先建立身份，再开始关系

```text
外观与人格
  → 生成 4 个身份候选
  → 用户明确选择 1 个“这就是她”
  → 系统生成 Identity v1
  → 自动制作基础 reference pack
  → 进入聊天
```

产品要求：

- 四张候选只能改变细节与构图，不能变成四个完全不同的人。
- 第一张可被预选，但发布前必须有明确的选择状态。
- “重新生成”保留外观字段，换 candidate seed，不修改已填写人格。
- “编辑外观”回到结构化 traits，不让用户写身份 prompt。
- 没有身份图时可以保存草稿，但不能把随机首图静默当作稳定身份。
- 确认后异步生成 reference pack：正面、四分之三、半身/全身，用户无需等待才能聊天。

状态机：

```text
draft → candidates_generating → candidates_ready → identity_confirmed → reference_pack_building → ready
   └──────── failed/retry ─────────┘                    └── degraded_ready
```

### 4.2 Character Detail：先展示“同一个人”，再卖生成能力

详情页使用 3–5 张已通过一致性门槛的精选图，覆盖头像、半身、生活场景。入口不是“打开生成器”，而是：

- `和她聊天`
- `想看她的另一个时刻`
- `使用这个场景创作`

官方角色没有 active identity 或精选图不足时，不进入推荐流。

### 4.3 Chat：图片是一条关系回复

触发方式：

- 用户自然语言请求自拍、照片或展示当前场景。
- 用户点击输入框旁的相机按钮。
- 角色在合适语境提出“要不要给你看”，用户确认后生成。

流程：

```text
用户请求
  → Chat 提取 MomentSpec，不描述角色五官
  → 角色先发送自然语言回复
  → 图片 attachment 进入 queued/running
  → 用户继续聊天
  → 质量门检查身份、坏图和场景
  → 最佳结果回到原消息并进入角色相册
```

Chat 默认一次返回一张最佳图。四张候选会让回复像工具，而不像角色发送的照片。

完成后的直接动作：

- `再来一张`：同一时刻，换镜头或表情。
- `保持人物，换场景`：进入编辑指令。
- `这张很像她`：正向身份反馈。
- `这张不像她`：负向身份反馈并提供一次低摩擦重试。
- `设为头像`：仅角色创建者可用。

### 4.4 Generate：Moment Studio，而不是模型控制台

默认信息层级：

```text
1. Character：角色头像 + “身份已锁定”
2. Moment：自然语言描述场景、动作、情绪
3. Look：沿用当前 / 已保存造型 / 新造型
4. Composition：画幅、镜头、数量
5. Generate：价格与预计等待
6. Advanced：模型、negative prompt、seed、身份变化策略
```

角色模式下，系统选择通过身份一致性验收的 profile。只有 Freeplay 和高级模式暴露模型选择。

默认 Moment 输入示例：

> 她刚从雨里跑进咖啡店，头发有点湿，坐在窗边看向镜头，像是刚看到我。

这比 Background/Pose/Outfit 四个并列技术表单更接近用户意图。Preset 仍可存在，但作为推荐 chips 和解析后的可编辑字段。

### 4.5 Gallery：角色的视觉记忆，而不是文件管理器

Gallery 默认按角色分组，并区分：

- `Moments`：按时间和聊天上下文浏览。
- `Looks`：用户保存的稳定造型。
- `Identity`：少量被系统或用户确认的身份参考图。
- `Liked`：普通收藏，不自动改变身份。

动作语义：

| 动作 | 是否改变 Identity | 结果 |
|---|---:|---|
| Like | 否 | 记录审美偏好 |
| Looks like her | 可选 | 进入候选 reference，质量通过后生效 |
| Doesn't look like her | 否 | 记录负反馈，排除该图作为参考 |
| Set display avatar | 否 | 只更换聊天和列表展示图，不改变身份参考 |
| Replace identity anchor | 是 | 二次确认后创建新 Identity version，并可同步设为展示头像 |
| Save as Look | 否 | 创建或更新 CharacterLook |
| More like this | 否 | 以源图延续构图/造型，不改身份 |

“Like”和“Add to identity”不能等价。用户可能喜欢一张艺术图，但不希望角色以后都长成那样。

## 5. 产品对象模型

### 5.1 CharacterVisualProfile：不可变身份快照

沿用现有对象，但职责收紧：

- traits 是真源；`identityPrompt` 是带 assembler version/hash 的派生缓存。
- profile version 一旦 active 后不可原地改写。
- 每个 GenerationJob 固定记录 visual profile id/version。
- 只有身份 traits、anchor 集合或核心风格改变时才创建新版本。
- reference pool 的普通增删不应制造大量 identity version；发布成身份参考集时再生成快照。

### 5.2 CharacterVisualReference：把 JSON ID 数组升级为有语义的引用

建议新增一等关系对象：

| 字段 | 含义 |
|---|---|
| `visualProfileId` | 所属身份版本 |
| `mediaAssetId` | 图片 |
| `role` | primary_face / three_quarter / body / signature / style |
| `weight` | 参考权重 |
| `crop` | 人脸或主体区域 |
| `qualityScore` | 清晰度、遮挡和坏图评分 |
| `identityScore` | 与 anchor 的身份相似度 |
| `source` | create / user_feedback / admin / generated_pack |
| `status` | candidate / active / rejected / archived |

这解决当前 `anchorAssetIds` / `referenceAssetIds` 只有顺序、没有质量和角色语义的问题。

### 5.3 CharacterLook：可复用造型

| 字段 | 含义 |
|---|---|
| `characterId` | 所属角色 |
| `visualProfileId` | 基于哪个身份 |
| `label` | Daily、Date Night、Fantasy 等 |
| `appearanceDelta` | 服装、妆容、发饰等相对身份变化 |
| `referenceAssetIds` | 造型参考图 |
| `status` | draft / active / archived |

Look 不允许覆盖脸部身份 traits。

### 5.4 MomentSpec：替代自由文本拼接的结构化意图

```ts
type MomentSpec = {
  scene?: string;
  action?: string;
  expression?: string;
  relationshipContext?: string;
  outfitIntent?: "continue" | "change" | "unspecified";
  outfit?: string;
  locationContinuity?: "continue" | "change" | "unspecified";
  camera?: string;
  lighting?: string;
  styleDelta?: string;
};
```

Chat 和 Generate 都产出 MomentSpec。服务端 assembler 再拼成 Identity / Look / Moment / Composition / Quality 五层 prompt。

### 5.5 GenerationFeedback：把“好不好”拆成可学习信号

| feedback | 含义 | 系统动作 |
|---|---|---|
| like | 喜欢整体结果 | 审美权重 |
| identity_match | 很像角色 | 候选 reference |
| identity_mismatch | 不像角色 | 排除并触发重试建议 |
| scene_mismatch | 没按要求 | 调整 Moment 解析/模型 |
| artifact | 手、脸、文字等坏图 | 质量失败 |
| too_similar | 变化不足 | 提高场景或 seed 多样性 |

## 6. 生成决策引擎

### 6.1 输入优先级

```text
confirmed Identity invariants
  > unconfirmed user change request
  > active Look continuity
  > current chat Moment
  > presets and defaults
  > model aesthetic defaults
```

用户说“换成红头发”与身份冲突时，系统应确认这是一次造型变化还是永久身份变化。未确认的请求服从现有 Identity；一次性变化进入 Look/Moment；确认永久修改后创建新 Identity version，新版本成为新的最高优先级 invariant。

### 6.2 路由策略

| 条件 | 策略 |
|---|---|
| 无参考图 | traits + identity prompt + diverse seed；引导建立 anchor |
| 有 1 张高质量 anchor | zero-shot ID/reference workflow |
| 有 3–6 张多角度高质量参考 | multi-reference identity workflow |
| 官方/高频角色 | 可选训练 adapter/LoRA，仍保留 reference fallback |
| 编辑上一张 | edit/img2img workflow，source image + identity reference 分角色传入 |
| 多角色合照 | 使用支持 regional/multi-ID 的独立 workflow，不复用单人流程 |

技术基线表明，单图 zero-shot、多人身份和训练式个性化各有适用范围，不能只押一种方案。InstantID 证明单图身份保持可用；PhotoMaker 强调多参考图；PuLID 强调身份保持与可编辑性的平衡。产品层必须保持 workflow/model 无关。

### 6.3 Seed 策略

- Strict/头像回放：允许固定或可复现 seed。
- 默认 Moment：seed 应随任务变化，身份由 reference/adapter 保持。
- More like this：继承 source 与构图控制，但使用新 subseed。
- Creative：提高 seed、镜头和风格变化，不降低核心身份约束到不可接受水平。

固定 seed 是调试与回放工具，不是长期身份系统。

### 6.4 参考图选择

每次最多传入模型有效范围内的参考图，按任务选取：

1. primary face anchor。
2. 与本次镜头最匹配的 body/angle reference。
3. 当前 Look reference。
4. source image（编辑任务）。

不能永远取数组前四张。参考选择必须考虑 role、角度、清晰度、遮挡和用户负反馈。

## 7. 质量门与失败恢复

### 7.1 四类失败

| 失败 | 例子 | 用户处理 |
|---|---|---|
| Infrastructure | timeout、provider error、空结果 | 自动重试，最终全额退款 |
| Artifact | 坏手、双脸、空白、乱码 | 自动淘汰/补生成，不把坏图交付 |
| Identity | 像另一个人、年龄或发型漂移 | 自动降级到更强身份策略或提供免费重试 |
| Intent | 场景、服装、动作不符合请求 | 保留图但提供“纠正并重试” |

### 7.2 生成后质量门

```text
provider output
  → 文件/尺寸/空白 sanity
  → artifact detector
  → face count / subject count
  → identity score（只做一个维度）
  → scene adherence
  → rank candidates
  → deliver best / regenerate missing quota / degrade with reason
```

质量门不得只输出一个黑盒总分。运营需要看到每个维度，用户只看到可执行结果。

### 7.3 计费原则

- Infrastructure 和 Artifact 失败不收费。
- Identity 低于发布门槛时，默认提供一次免费系统重试；重复失败记录为模型/profile 事故。
- Intent 不满意不自动退款，但“纠正并重试”复用解析结果，降低操作成本。
- Chat 只交付一张时，可在后台生成 2 张并择优，但定价必须按用户看到的产品单位定义，而不是按内部候选张数收费。

## 8. 信息架构修复

### 8.1 当前主要断层

| 现状 | 问题 | 修复 |
|---|---|---|
| Generate 同屏展示模型、negative prompt、presets、三档一致性、身份时间线 | 用户被迫扮演模型工程师 | 默认 Moment Studio，高级控制折叠 |
| `Identity locked · vN` | 版本号对用户无价值 | 用户只看“身份已锁定”，版本进详情/排障 |
| Gallery 只有图标式 Add to identity | 动作危险且语义不清 | 先收集“像/不像”，身份变更显式确认 |
| Like 与身份反馈分离不清 | 喜欢风格可能污染身份 | 建立 GenerationFeedback 类型 |
| Model selector 对角色模式开放 | 用户可选到不支持身份的模型 | 系统按角色路由，模型下沉到 Advanced |
| Chat/Generate/Gallery 用不同操作语言 | 学习成本高 | 统一“时刻、造型、像她/不像她、再来一张” |

### 8.2 推荐默认页面

```text
┌───────────────────────────────────────────┐
│ [头像] Melissa            身份已锁定      │
│                                           │
│ 想看她在什么时刻？                        │
│ ┌───────────────────────────────────────┐ │
│ │ 雨夜回到公寓，坐在窗边看向镜头……      │ │
│ └───────────────────────────────────────┘ │
│                                           │
│ [沿用当前造型] [换套衣服] [更多灵感]      │
│ 4:5 · 1 张 · 约 70 秒                     │
│                                           │
│           [ 生成这个时刻 · 5 币 ]         │
│                                           │
│ ▸ 高级设置                                │
└───────────────────────────────────────────┘
```

## 9. 指标与实验

### 9.1 北极星与护栏

北极星不是“生成次数”，而是：

> 每 100 个活跃关系中，产生并被继续引用的有效视觉时刻数。

核心指标：

| 指标 | 定义 |
|---|---|
| First Good Image Rate | 第一次生成无需重试且被查看/喜欢/继续操作 |
| Identity Match Rate | 用户未标记不像 + 评估通过 |
| Moment Continuation Rate | 图片完成后 10 分钟内继续聊天或基于图片继续创作 |
| Visual Memory Rate | 图片被收藏、设头像、存 Look 或后续引用 |
| Paid Generation Retention | 首次付费生成后 7/30 日再次生成 |
| Semantic Failure Rate | identity/intent/artifact 各自失败率 |

系统指标：P50/P95 等待、队列时间、每交付图真实算力成本、自动补生成率、退款率、profile/version 事故率。

### 9.2 首轮实验

1. Prompt 工具页 vs Moment Studio：比较 First Good Image Rate 和完成时间。
2. Chat 一张择优 vs 直接一张：比较 Identity Match 和真实成本。
3. 三档一致性外露 vs 自动模式：比较重试率和高级设置打开率。
4. “Add to identity” vs “像她/不像她”：比较反馈量和身份污染事故。

## 10. 分期路线

### P0：单角色 Chat Moment 闭环 + 最小语义修正（当前迭代）

- Chat 完成“请求一个时刻 → 继续聊天 → 一张图回到原消息 → 再来一张/不像她”的受控 beta 闭环。
- 先落最小 typed feedback event，不在 P0 自动修改身份 reference。
- Generate 只做默认信息层级修正：Moment 前置，技术控制下沉到 Advanced。
- 统一跨页面身份文案，不在主界面展示版本号和 reference 数量。
- 记录指标事件；dashboard 实现进入运营并行工作流，不阻塞 Chat wedge。

### P1：身份参考系统与跨页面反馈

- 新增 CharacterVisualReference 与 GenerationFeedback。
- 自动 reference pack 与 role/quality/crop。
- 基于任务选择参考图，不再取数组前四张。
- 身份版本回滚与参考候选审批。

### P2：造型和剧情连续性

- 新增 CharacterLook 与 MomentSpec。
- Chat 从上下文提取服装、地点、情绪连续性。
- Gallery 保存 Look；Chat/Generate 复用。
- edit_last_image 支持“只改 X，保持其余不变”的差异指令。

### P3A：质量评估

- artifact / identity / intent 分维度质量门。

### P3B：排序、补生成和自适应路由

- 多候选择优和自动补生成。
- profile × 角色类型 × 场景的路由表现模型。

### P3C：训练式身份

- 官方/高频角色 adapter/LoRA 管线。

### P3D：多角色图片

- 多角色 regional/multi-ID 独立工作流。

## 11. 验收标准

### 用户体验

- 新用户不理解任何模型术语也能完成角色创建和首张图。
- 角色生成默认只要求描述时刻，身份控制无需手动配置。
- Chat 生图不阻塞聊天，失败在原消息内恢复。
- 每张结果都能表达“再来一张、保持人物换场景、像她、不像她”。
- Like 不会自动污染身份。

### 一致性

- 发布到角色模式的 workflow 必须按角色类型跑固定 eval matrix。
- 单人近景、半身、全身、侧脸、强光、弱光、换装、复杂背景分别评估。
- 人工 Identity Match 基线不低于 90%；80% 只允许内部候选，不进入默认角色路径。
- 同一 profile 出现连续身份失败时可立即 pause/rollback。

### 工程与运营

- 每个结果可追溯到 Identity、Look、Moment、profile/workflow、seed、reference selection 和 feedback。
- 所有异步状态有明确终态、重试和退款处理。
- 新 workflow 不需要改 Chat 或 Generate UI。
- 运营可以按失败维度定位问题，而不是只看到 provider error。

## 12. 现有能力复用

以下底座应保留并继续深化：

- `CharacterVisualProfile` 版本快照与 traits assembler。
- `GenerationJob.visualProfileId/version`、recipe/profile/workflow provenance。
- `referenceImages` transport、角色/reference/source 三类 role 和 mode 权重。
- workflow-native ComfyUI/sdcpp backend。
- Create 四候选并选择 anchor。
- Chat function-calling、文本+图片同回合、编辑上一张。
- Gallery `Use as character image` / `Add to identity` / variation 基础动作。
- Admin pregen、人工 review、profile 发布/回滚和生成 metrics。

本方案不是重写生成底座。它修复的是产品对象边界、默认体验、质量定义和反馈闭环。

## 13. 外部基线

- OurDream 把“每次都是一致外观，而不是陌生人”作为核心承诺，并把图像和视频放进对话。
- Nomi 把 selfie 直接绑定当前对话，并让图片进入角色相册和头像选择。
- Kindroid 2026 的产品层明确区分 Avatar Photo、Avatar Description 和 Selfie Prompt，且把参考图质量、角度多样性和一致性/自由度权衡放在身份系统内。
- InstantID、PhotoMaker、PuLID 分别证明单参考、多参考、身份与可编辑性平衡需要不同策略。

参考：

- https://land.ourdream.ai/
- https://nomi.ai/nomi-knowledge/getting-started-nomi-selfies/
- https://kindroid.ai/docs/article/selfies-video-selfies-avatars/
- https://kindroid.ai/docs/article/atelier-selfies-guide/
- https://arxiv.org/abs/2401.07519
- https://arxiv.org/abs/2312.04461
- https://arxiv.org/abs/2404.16022

## 14. 交互状态契约

本节约束目标状态；各阶段只实现路线图明确纳入的行，但不能发明新的终态语义。

| Surface | 状态 | 用户看到 | 可执行动作 | 是否终态 |
|---|---|---|---|---:|
| Create | empty | 外观尚未足够生成候选 | 补字段、保存草稿 | 否 |
| Create | generating | 候选逐张出现，显示已完成数量 | 离开后恢复、取消未开始任务 | 否 |
| Create | partial | 1–3 张成功，其余失败 | 选择成功项、补生成失败项 | 否 |
| Create | ready | 候选可比较，尚未确认 | 选择、重生成、编辑 traits | 否 |
| Create | confirmed | “这就是她” | 发布、返回修改 | 否 |
| Create | degraded_ready | 身份已确认，reference pack 未完成 | 先聊天、后台重试 pack | 是 |
| Chat | queued | 原消息内占位，显示排队 | 继续聊天、取消 | 否 |
| Chat | running | 生成中，不阻塞输入框 | 继续聊天、取消（best effort） | 否 |
| Chat | quality_checking | “正在挑选最像她的一张” | 继续聊天 | 否 |
| Chat | retrying | 自动重试次数和原因的简化文案 | 停止重试 | 否 |
| Chat | completed | 一张图片 + 后续动作 | 再来一张、纠正、反馈 | 是 |
| Chat | degraded | 交付可用图并说明部分要求未满足 | 纠正并重试 | 是 |
| Chat | failed | 原消息内错误与退款/未扣费状态 | 重试 | 是 |
| Chat | cancelled | 已取消，说明是否已产生费用 | 重新请求 | 是 |
| Studio | empty | 尚未选角色或 Freeplay | 选择角色/模式 | 否 |
| Studio | queued | 任务卡显示队列位置/等待 | 切页、请求取消 | 否 |
| Studio | running | 任务卡和预计等待 | 切页、取消 | 否 |
| Studio | quality_checking | 显示“检查结果”而非假完成 | 切页 | 否 |
| Studio | retrying | 显示补生成次数和简化原因 | 停止补生成 | 否 |
| Studio | partial | 多张结果部分成功 | 查看成功项、补齐失败数量 | 是 |
| Studio | degraded | 结果可用但部分意图未满足 | 纠正并重试 | 是 |
| Studio | completed | 全部结果 + 来源信息 | 变体、反馈、下载 | 是 |
| Studio | failed/refunded | 错误分类与明确退款状态 | 重试、查看任务 | 是 |
| Studio | cancelled | 取消结果和计费状态 | 重新生成 | 是 |
| Gallery | empty | 该角色还没有视觉时刻 | 从 Chat/Create/Studio 开始 | 是 |
| Gallery | loading | 保留骨架与筛选状态 | 切换角色/筛选 | 否 |
| Gallery | partial | 部分缩略图不可用但资产列表可操作 | 重试预览、删除/反馈 | 是 |
| Gallery | error | 不展示陈旧列表，显示 Retry | 重试 | 是 |
| Gallery | ready | Moments/Looks/Identity 分区 | 查看、反馈、继续创作 | 是 |
| Reference pack | building | 身份已可用，参考包后台构建 | 查看进度、重试 | 否 |
| Reference pack | ready | 参考角色与质量可查看 | 运营替换/归档 | 是 |
| Reference pack | failed | 身份仍可用但能力降级 | 自动/人工重试 | 是 |

退款只能由 Main 的 GenerationJob 终态决定；Chat attachment 和 Gallery 不能自行推断。

所有状态在 390px 宽度下保持主动作可见且无横向滚动；状态变化用 `aria-live`，错误用 `role="alert"`；所有操作可键盘到达，焦点不因异步刷新丢失。取消是请求态：若 provider 在取消后返回，Main 仍接收并归档资产，但 job 终态保持 cancelled、不得交付到 Chat/Gallery、不得二次结算。

## 15. 持久化契约与不变量

### 15.1 ReferenceSetRevision

身份快照不可变，但普通 reference 候选会变化。引入不可变 `ReferenceSetRevision` 解开二者：

```text
CharacterVisualProfile 1 ── N ReferenceCandidatePool（可变）
CharacterVisualProfile 1 ── N ReferenceSetRevision 1 ── N CharacterVisualReferenceSnapshot（不可变）
GenerationJob ── pins ── visualProfileId/version + referenceSetRevisionId
```

每个 Job 还保存 resolved reference manifest，字段包括 assetId、role、weight、crop、qualityScore、identityScore、selectorVersion 和选择原因。即使未来 reference 被删除或归档，历史任务仍可解释。

### 15.2 Schema-grade 字段

| Object | 必需字段与约束 |
|---|---|
| ReferenceSetRevision | `id`, `visualProfileId`, `revision`, `status`, `selectorVersion`, `createdFrom`, `createdById?`, timestamps；`unique(visualProfileId, revision)`；active 后不可改 |
| ReferenceCandidate | `id`, `visualProfileId`, `mediaAssetId`, `proposedRole`, scores, `source`, `status(candidate/rejected/promoted)`, timestamps；它是唯一可变 reference 生命周期 |
| CharacterVisualReferenceSnapshot | `id`, `referenceSetRevisionId`, `mediaAssetId`, `role`, `weight`, `crop`, scores, `availableAtSnapshot`；无 mutable status；同 revision/asset 唯一；asset 软删不改历史 snapshot |
| CharacterLook | `id`, `characterId`, `visualProfileId`, `ownerId`, `label`, `appearanceDelta`, `status`, `rebasedFromLookId?`, timestamps；同 owner/character/label active 唯一；角色删除 cascade，profile 归档不删除 Look |
| GenerationFeedback | `id`, `actorId`, `generationJobId`, `mediaAssetId`, `characterId?`, `visualProfileId?`, `referenceSetRevisionId?`, `type`, `reason?`, `sourceSurface`, `retryJobId?`, `idempotencyKey`, timestamps；`unique(actorId, idempotencyKey)` |
| MomentSpec | 作为 Job 的不可变 JSON snapshot 保存：`schemaVersion`, `parserVersion`, `rawInput`, 结构字段, `confidence`, `continuitySources[]`, `createdAt` |

所有会改变未来身份的动作写 AdminAuditLog 或等价审计事件。Like、feedback 和 display avatar 软删/撤销不删除生成资产。

### 15.3 生命周期

```text
candidate: candidate → promoted
                    └→ rejected
reference revision: draft → active → superseded（active 后成员不可变）
look:      draft → active → archived
feedback:  active → retracted
```

Feedback 写入与重试创建使用同一 idempotency key lineage；重复点击返回原记录。

Candidate promotion 在一个 Main DB 事务里完成：锁 active revision → 复制未变化 snapshot + 新 candidate → 创建 revision N+1 → 原 revision 标 superseded → 新 revision 标 active → candidate 标 promoted。任何一步失败全部回滚，历史 revision 永不改写。

Look 是 character-scoped delta，但记录创建时的 visualProfileId。使用旧 Look 时先验证它是否只改变 outfit/makeup/accessory 等允许字段；兼容则创建一个新 Look 记录并写 `rebasedFromLookId`，绑定 active profile；触及 face/body/signature invariant 则拒绝自动 rebase，要求用户确认身份变化。

## 16. 服务边界与事件序列

| 职责 | 权威服务 |
|---|---|
| MomentSpec 提取、聊天上下文连续性 | Chat |
| Identity/Look/Moment prompt assembly、profile 路由、计费预留 | Main |
| workflow 执行、候选生成、文件 sanity | Gen |
| artifact/identity/intent evaluator orchestration | Gen 执行，Main 保存结果和决策 |
| GenerationJob 终态、退款、Gallery 资产、feedback | Main |
| Chat attachment 展示终态 | Chat，严格消费 Main 事件 |

### 16.1 Chat 生成序列

```text
Chat(message/tool)
  → outbox chat.image.requested(attachmentId, MomentSpec, visualProfile snapshot hint)
Main consumer
  → idempotent create GenerationJob + reserve coins
  → generation.accepted(jobId)
Gen worker
  → produce candidate(s) + evaluator results
Main finalizer
  → choose terminal state and refund/settle exactly once
  → outbox generation.completed|degraded|failed|cancelled
Chat inbox
  → update the same attachment exactly once
```

关键幂等键：Chat request=`attachmentId`；GenerationJob=`sourceType+sourceId`；候选=`jobId+candidateIndex`；quality retry=`rootJobId+retryOrdinal`；refund=`jobId+ledgerReason`。

Main 是 job 与账本终态唯一权威。任何重放不得二次扣费、二次退款或创建第二个 Chat attachment。

### 16.2 P0 最小 feedback contract

P0 先写 `GenerationJobEvent(type="user_feedback")`，metadata 固定为：

```json
{
  "schemaVersion": 1,
  "actorId": "user_id",
  "mediaAssetId": "asset_id",
  "feedbackType": "identity_match | identity_mismatch",
  "sourceSurface": "chat",
  "idempotencyKey": "actor_id:asset_id:identity",
  "supersedesEventId": null
}
```

P0 按 `actorId + mediaAssetId + feedback dimension` upsert 当前值；用户从“像她”改为“不像她”时，新事件写 `supersedesEventId`，旧事件不再计入 active 指标。P1 回填到 `GenerationFeedback` 表并 dual-write；P0 feedback 只用于度量和重试建议，不自动修改 reference。

### 16.3 免费质量重试

原 Job 保持终态并通过 `retryJobId/rootJobId` 关联系统重试。重试不再次 reserve；只有一个 delivered asset set 可以 settle。超过最大次数进入 degraded 或 failed，不无限循环。

| 最终证据 | 是否可交付 | 终态 | 计费 |
|---|---:|---|---|
| 文件/artifact 失败 | 否 | failed/refunded | 退款 |
| 明确 identity fail | 否 | failed/refunded，或仍有次数则 retrying | 退款或免费重试 |
| identity evaluator unavailable，sanity pass | 是，但标 unscored | degraded | 正常计费；实验指标不计 identity pass |
| intent 部分不符，身份与 artifact pass | 是 | degraded | 正常计费，提供纠正重试 |
| 至少一张全部通过 | 是 | completed | 正常计费 |
| 用户取消且 provider 后返回 | 否，资产只归档 | cancelled | 按下方取消账本规则执行，绝不二次结算 |

取消账本规则只有一次状态转换：

- provider 尚未 start：`reserved → released`，全额释放预留币。
- provider 已 start、尚无输出：受控 beta 仍执行 `reserved → refunded`，平台承担成本；后续是否引入取消费必须单独产品决策。
- provider 已产生输出但 Main 尚未 deliver：结果归档不交付，`reserved → refunded`。
- Main 已 deliver：取消按钮不可再把 job 改为 cancelled；用户只能删除资产，账本保持 settled。

Ledger 用 `jobId + cancellation` 唯一键保证 release/refund/settle 三者只能成功一个；迟到的 provider/finalizer 事件只记审计，不改变终态。

## 17. Workflow 能力契约

每个可发布 workflow/profile 必须声明，而不是靠名称推断：

```ts
type IdentityCapability = {
  identityModes: Array<"text_seed" | "single_reference" | "multi_reference" | "trained_adapter" | "multi_id">;
  referenceRoles: Array<"source" | "face" | "body" | "look" | "regional">;
  minReferences: number;
  maxReferences: number;
  supportsIdentityWeight: boolean;
  supportsEdit: boolean;
  supportedStyles: string[];
  supportedShots: string[];
  evaluatorCompatibility: string[];
  expectedP50Ms: number;
  expectedP95Ms: number;
  estimatedGpuSeconds: number;
  estimatedInternalCostUsd: number;
  fallbackProfileKey: string | null;
};
```

路由器只消费此契约。能力未声明或 smoke 过期时，该 profile 不进入默认角色路径。需要图片的任务还必须按 descriptor 的 semantic role 与 cardinality 精确绑定 required slot；zero、missing、extra 或 ambiguous reference 在上传和 prompt submit 前 fail closed，不按数组顺序猜测，也不降级为丢弃 source/reference 的 text-only 任务。

以下 Gate 相互独立，任何一项通过都不能替代后一项：

1. descriptor schema/load；
2. ComfyUI UI sync/readback；
3. provider 执行与 artifact sanity；
4. profile publish 与 route qualification；
5. 生产容量、对象存储和 live probe。

因此 multi-identity smoke 只证明 transport/runtime 可执行，不把 P3D 的人数上限、identity bleed eval 与独立发布证据标成完成。

## 18. 质量与成本策略默认值

以下是受控 beta 初始配置，不是永久常量；Generation Ops owner 负责按 eval 校准：

| Policy | 初始值 | 超时/失败行为 |
|---|---:|---|
| Chat candidates | 1；仅实验 cohort 为 2 | 回落单候选 |
| 自动质量重试 | 最多 1 次 | degraded 或 failed |
| evaluator 总预算 | P95 ≤ 5s | evaluator unavailable 时不宣称 identity pass，标 unscored |
| Chat 端到端目标 | P50 ≤ 45s，P95 ≤ 120s | 超过 P95 显示延迟状态，不静默失败 |
| Studio 端到端目标 | P50 ≤ 90s，P95 ≤ 240s | 保留任务，后台完成 |
| 稳态成本门槛 | `estimatedInternalCostUsd / netRevenueUsd ≤ 0.35` | 超出不进入默认路由 |
| beta 实验补贴 | 单用户每天最多额外 $0.50，单实验总 burn cap 预先配置 | 达 cap 自动关闭多候选实验 |
| identity publish gate | 人工 match ≥ 90%，每矩阵至少 40 张 | 80–89% 仅内部候选 |

“高质量 anchor”初始定义：单主体、脸部可见且有效区域 ≥ 160px、无遮挡/无严重压缩、artifact pass、人工 identity pass。阈值按 realistic/anime 与 shot type 分开校准。

“连续身份失败”定义：同 profile 在 30 分钟滚动窗口内至少 20 个已评分结果且 identity failure ≥ 15%，或连续 5 个失败；触发自动 pause 建议，是否自动 pause 由 rollout policy 决定。

`netRevenueUsd` 是扣除退款、支付通道费和税费后的该生成产品单位净收入；GPU 秒和 USD 必须同时记录，避免汇率或基础设施价格变化掩盖真实算力回归。

## 19. 指标事件与口径

| Metric | 分母 | 分子 | 窗口与缺失处理 |
|---|---|---|---|
| First Good Image Rate | 用户×角色的首次 completed/degraded 生成 | 10 分钟内无系统/用户重试，且发生继续聊天、like、download、save look、set avatar 任一正向行为 | 24h 归因；无反馈但继续聊天算行为成功，不算 identity 人工通过 |
| Identity Match Rate | 有人工抽样或明确用户 identity feedback 的结果 | identity_match / 人工 pass | 未反馈不进入分母；按 style×shot 分层并报告 95% CI |
| Moment Continuation Rate | Chat 图片 delivered | 10 分钟内同 session 新消息或基于图片操作 | 排除机器人/运营账户 |
| Visual Memory Rate | delivered assets | 7 天内 like/download/save look/display avatar/后续 source 引用 | 多动作去重到 asset |
| Semantic Failure Rate | delivered + system-rejected candidates | 对应 identity/intent/artifact failure | unscored 单列，不计 pass |

事件名固定为：`image_moment_requested`, `image_job_accepted`, `image_candidate_generated`, `image_quality_scored`, `image_delivered`, `image_retry_started`, `image_feedback_recorded`, `image_moment_continued`, `image_cost_settled`, `image_cost_refunded`。

首轮实验至少每组 200 个 delivered moments 或达到预先设定的 95% CI 宽度；没有样本量计算不做胜负结论。

## 20. 迁移、发布与回滚

1. **Expand**：新增 reference revision/feedback/look 字段与表，不改旧读取。
2. **Dual write**：现有 `anchorAssetIds/referenceAssetIds` 写入时同步写 revision；失败记录 reconciliation 队列，不阻塞用户主动作。
3. **Backfill**：按 visual profile version 把 JSON 顺序转换为 primary_face + identity_reference，无法解析的 asset 标 unavailable。
4. **Shadow read**：新 selector 读取 revision，但与 legacy 结果对比并记录差异，不用于生成。
5. **Cutover cohort**：feature flag 按内部角色 → 5% beta → 25% → 100%；每阶段检查 missing reference、identity failure、job failure、成本和延迟。
6. **Legacy freeze**：100% 稳定 14 天后停止写 JSON，但保留读取回滚窗口。
7. **Contract**：再经过 30 天无回滚才移除 legacy 字段。

回滚只切 feature flag 回 legacy selector；新增表和数据不删除。若 dual-write 不一致 >0.1%、identity failure 超预算或 P95 延迟恶化 >20%，停止扩量并回滚读取。

受控 beta 上线还必须具备生产形态的生成容量、对象存储和端到端 live probe；本地 smoke 不能替代。

## 21. Create 候选家族方法

“四张候选是同一个人”不能只靠四次独立文生图。P0 方法：

1. 用 traits 生成一个低成本 primary candidate。
2. 其余候选使用共享 identity condition/reference 或同一 candidate-family latent，限定只变化表情、四分之三角度和构图。
3. 若底层只有 text+seed，候选页必须标为外观探索，用户确认后再用确认图构建真正 reference pack；不能承诺四张已是同一身份。
4. eval matrix：每个 style 至少 20 组四联图，人工判断“能否被看成同一角色家族”；默认发布门槛 90%。

## 22. 文档边界

本文是产品目标、领域对象和跨服务不变量的 SSoT。具体 Prisma schema/SQL、共享事件 Zod contract、evaluator 实现、Admin 页面和部署 runbook 分别在工程计划中落地并反向链接本文。本文不替代这些可执行工程契约。

### 22.1 关联工程契约

| 契约 | Owner | 目标路径/现有入口 |
|---|---|---|
| Prisma schema + migration/backfill | Main | `packages/main/prisma/schema.prisma`, `db/sql/` |
| Chat/Main/Gen 事件 Zod | Shared | `packages/shared/src/contracts/` |
| Moment parser + Chat attachment | Chat | `packages/chat/src/` |
| assembler/router/billing/finalizer | Main | `packages/main/src/server/modules/ourdream/` |
| workflow capability + evaluator runner | Gen/Shared | `packages/shared/src/gen/workflow.ts`, `packages/gen/src/` |
| Admin reference/quality/rollout workflows | Main Admin | `packages/main/src/components/admin/`, `modules/admin/` |
| deploy/live probe/runbook | Platform | `docs/architecture/`, launch probes |

Admin 必须支持：candidate reference 审批、revision 对比/回滚、Look 兼容性警告、quality 维度查看、profile pause/rollout、失败样本钻取和 reconciliation 队列；具体页面布局不在本文重复定义。

## 23. 分阶段 Definition of Done

| Phase | 适用能力 | 完成定义 |
|---|---|---|
| P0 | Chat 单角色 moment、P0 feedback、Generate 信息层级 | attachment 全终态与取消竞态测试；identity feedback 事件幂等；5 人受控测试；默认 UI 不暴露版本/ref/model |
| P1 | ReferenceCandidate/Revision、跨页面 feedback | expand/dual-write/backfill/shadow-read 完成；历史 job manifest 可回放；revision 原子激活和回滚测试 |
| P2 | MomentSpec、CharacterLook、连续性 | parser version 固定；raw input + sources 可追溯；Look rebase/拒绝路径测试；Chat/Studio 使用相同 assembler |
| P3A | 分维度 evaluator | style×shot eval matrix、unscored 语义、超时降级、人工抽样和 90% publish gate 上线 |
| P3B | 排序/补生成/路由 | 成本/延迟 spike 通过；最多候选/重试硬上限；路由只消费 capability contract；灰度与回滚演练 |
| P3C | adapter/LoRA | 训练数据 provenance、版本/删除、fallback workflow、官方/高频角色 ROI 通过 |
| P3D | multi-ID | 独立 regional contract、人数上限、identity bleed eval、不得复用单人 publish 证据 |

第 4 章描述 target-state。P0 使用现有 prompt hint 作为 Moment 输入、现有 sanity 作为质量门；完整 `MomentSpec` 从 P2 生效，identity/intent evaluator 从 P3A 生效。在对应阶段之前，UI 不得宣称尚未具备的自动理解或质量保证。
