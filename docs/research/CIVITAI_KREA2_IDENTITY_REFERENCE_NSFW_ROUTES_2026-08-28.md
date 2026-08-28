# Civitai.red：Krea 2 参考图人物保持 + NSFW 路线核验

日期：2026-08-28  
范围：只调查 Civitai.red 上标为 `Krea 2` 的模型与 ComfyUI 工作流；重点判断工作流是否**真实读取人物参考图并把图像送进 Krea 2 identity/edit 路径**。

## 结论

当前没有找到一个同时满足下面四项、且已有同一次运行完整证据的单一 Civitai 资源：

1. 精确 Krea 2 权重；
2. 真实读取人物参考图；
3. 换姿势、服装或场景后保持身份；
4. 同一次 identity-edit 运行完成明确 NSFW 出图。

但已经有三条可执行路线：

| 优先级 | 路线 | 判断 |
|---|---|---|
| P0：首选 | **Muse V3.0 Extended Turbo Edit 3200345 + RedNode v1.3 3153173 / ComfyUI-Krea2Edit** | Muse 把 identity-edit 烘进 checkpoint；RedNode / Krea2Edit 负责把人物参考图送入 grounded encode 与 reference latent。Muse 同版本页有明确 NSFW 样图，但样图元数据指向同系列 NVFP4 文件，不是该 INT8 Edit 文件，仍需真实 A/B 闭环。 |
| P1：备选 | **Identity Instant Pose 3167685 + Muse v2.5 INT8 Turbo 3147272 + Identity Edit v1.2 3139172** | 现成 pose / outfit / background 入口，作者明确推荐该 Muse 版本；人物保持来自独立 Identity Edit LoRA 与 grounded reference，不来自 pose prompt。 |
| P2：备选 | **Img2Img FaceSwap 3228763 + Jib Mix Krea 2** | 工作流把 Krea2 Edit Model 接进第一 sampler，并用后续 sampler 改善脸；Jib Mix 作者的 v2 / v4 页面与样图提供 NSFW 能力证据，但 reference + NSFW 同跑仍未闭环。 |
| P3：实验组合 | **Moody Krea 2 Mix V7 + Identity Edit v1.2 + RedNode / ComfyUI-Krea2Edit** | 参考图、identity LoRA、NSFW checkpoint 三层最透明；可额外叠 PornMaster，但多 LoRA 竞争可能降低身份保持。 |

如果只选一条开始：用 **P0 Muse Edit + RedNode**。RedNode 当前示例默认还会加载独立 `krea2_identity_edit_v1_2`；换成 Muse Extended Turbo Edit 时应先移除这个重复 LoRA，只保留 RedNode / Krea2Edit 的参考图 conditioning 与 model patch。分别固定 checkpoint、参考图、prompt、seed 与采样参数做 A/B。

## 一、真正的 Krea 2 identity/reference 模型

### 1. Krea 2 Identity Edit v1.2 — 当前最有证据的单图身份编辑 LoRA

- 作者：[`conrad_locke`](https://civitai.red/user/conrad_locke/models)
- Civitai：[`modelId=2761113 / versionId=3139172`](https://civitai.red/models/2761113?modelVersionId=3139172) · [精确版本 API](https://civitai.red/api/v1/model-versions/3139172)
- 类型 / 基础模型：LoRA / `Krea 2`
- 文件：
  - `krea2_identity_edit_v1_2.safetensors`，FP16，约 1.70 GiB，SHA-256 `6ADF9A69CC9502D286DB7B69964D37DA7E9CFE4B05B4D004BC275F087D3FD3CF`
  - 另有 rank-128 约 872 MiB、rank-64 约 436 MiB 版本。
- 必需组件：Krea 2 Raw 或 Turbo、`qwen3vl_4b` Krea 2 text encoder、`qwen_image_vae`、[`lbouaraba/comfyui-krea2edit`](https://github.com/lbouaraba/comfyui-krea2edit)。
- 真实读取参考图：**是**。上游最小工作流明确是 `LoadImage → VAEEncode → Krea2EditModelPatch.source_latent`，同一图片还进入 `Krea2EditGroundedEncode.image`；不是图片转 prompt 后再文生图。[作者工作流 JSON](https://github.com/lbouaraba/comfyui-krea2edit/blob/main/workflows/krea2_identity_edit.json)
- 身份保持证据：作者定义为 instruction-based identity-preserving editing；v1.2 增加 face likeness、head/face/person swap、try-on、`ref_boost` 与适配输出尺寸的 `fit` geometry。[节点说明](https://github.com/lbouaraba/comfyui-krea2edit#nodes) · [CHANGELOG](https://github.com/lbouaraba/comfyui-krea2edit/blob/main/CHANGELOG.md)
- NSFW 证据：**LoRA 本身没有**。作者明确说训练数据全是 SFW；NSFW 能力必须来自 checkpoint 或另一个 Krea 2 NSFW LoRA。作者也说明它可与 character/body/style LoRA 叠加，但这不是 NSFW 同跑实测。
- 下载条件：本轮匿名 Range 请求返回 HTTP 206，可不登录下载；模型页和版本 API 可匿名查看。
- 已知缺陷：明显依赖脸部几何的身份可能回归为“近亲脸”；多人物会身份融合；服装替换不稳定；建议不超过 2MP；Turbo 8–12 steps / CFG 1，删除类编辑应改用 Raw / CFG 3 / 约 20 steps。

### 2. Krea 2 Style Reference LoRA — 明确排除为“人物保持”

- 作者：[`ostris`](https://civitai.red/user/ostris/models)
- Civitai：[`modelId=2764349 / versionId=3111281`](https://civitai.red/models/2764349?modelVersionId=3111281) · [精确版本 API](https://civitai.red/api/v1/model-versions/3111281)
- 文件：`krea2_style_reference.safetensors`，BF16，约 436 MiB；基础模型 `Krea 2`。
- 作者定义：从 1–2 张参考图传递 style；必须使用 [`ComfyUI-Krea2-Ostris-Edit`](https://github.com/ostris/ComfyUI-Krea2-Ostris-Edit)。Ostris 节点确实把图片同时送进 Qwen3-VL 与 reference latents，但最终能保留 style、subject 或 identity 取决于**所加载 edit LoRA 的训练目标**。
- 结论：这个精确权重是 **style reference**，不是 identity LoRA。不能因为节点有 `image1..image3` 和 reference latents，就把它列为人物锁脸方案。
- 下载条件：本轮匿名 Range 请求返回 HTTP 206。

Krea 官方只承诺 Krea 2 LoRA 训练路线：在 Raw 上训练、在 Turbo 上推理；开放基础推理仍是 text-to-image。[Krea 2 官方仓库](https://github.com/krea-ai/krea-2#finetuning-krea-2) ComfyUI/Ostris 的 reference-latent 支持是后加的 edit-LoRA 基础设施，不等于任意参考图或任意旧适配器都能锁脸。[Ostris 节点说明](https://github.com/ostris/ComfyUI-Krea2-Ostris-Edit/blob/main/README.md)

## 二、真正读取人物参考图的 Civitai 工作流

| 工作流 | 精确资源 | 参考图路径与身份证据 | 主要依赖 | NSFW 证据 | 下载 / 缺陷 |
|---|---|---|---|---|---|
| **Krea 2 Moodboard + Identity Edit v1.3**，RedNodeAI | [`2794961 / 3153173`](https://civitai.red/models/2794961?modelVersionId=3153173) · [API](https://civitai.red/api/v1/model-versions/3153173) | Civitai 样图 `meta.comfy` 明确含 `LoadImage`（标题为“Subject (the face to keep)”）→ `Krea2RedNode.subject_image`，并加载 `krea2_identity_edit_v1_2`；另有第二人物 `LoadImage → Krea2EditSourceChain`。 | `ComfyUI-Krea2Moodboard` + core nodes；checkpoint、identity LoRA、Qwen3-VL、`qwen_image_vae`。[开源节点与 lean workflow](https://github.com/RedNodeAI/ComfyUI-Krea2Moodboard) | 样图 workflow prompt 出现 `Sexy underwear`，证明同图参考路径可接受成人向提示，但不是完整 explicit NSFW 质量证明。 | Civitai ZIP 匿名下载返回 401、需登录；GitHub 节点和 lean workflow 可匿名取得。多人物 3+ refs 易融合；不要把 moodboard style 分支当 identity。 |
| **Selfism AIO Krea 2 v1.1**，Artfat | [`2844184 / 3211045`](https://civitai.red/models/2844184?modelVersionId=3211045) · [API](https://civitai.red/api/v1/model-versions/3211045) | 样图 `meta.comfy` 的完整 graph 内有两张 `LoadImage`、`Krea2EditGroundedEncode`、`Krea2EditModelPatch`、`krea2_identity_edit_v1_2`；作者说明可 restage、换衣、两图合成和局部编辑。 | Selfora v2.1、Artfat nodes、rgthree、Krea2Edit、detailer / upscale / Control-LoRA 等，依赖多。 | 同一版本第二张样图为 `nsfwLevel=16` 且 prompt 明确 `explicit, uncensored`；graph 的 LoRA loader 还包含 PornMaster Krea 2 槽。 | JSON 匿名下载 401。成人样图走 T2I 分支，未证明同一次 identity-edit；作者推荐 edit VAE 含 Wan/krea2RealVae，和上游 `qwen_image_vae` 基准不一致，首测应改回上游 VAE。 |
| **Image 2 Image Krea 2 + LoRA loader + Identity Edit**，Fadoo2077 | [`2863753 / 3235151`](https://civitai.red/models/2863753?modelVersionId=3235151) · [API](https://civitai.red/api/v1/model-versions/3235151) | 三张样图暴露 `meta.comfy`；可见 `LoadImage → VAEEncode / Krea2EditGroundedEncode / Krea2EditModelPatch`，并加载 Identity Edit v1.2。 | Krea2Edit、Power LoRA Loader、Krea 2 checkpoint、Qwen3-VL、VAE。 | 两张样图工作流使用名为 `finepornV4TURBOFP8INT8_v4.safetensors` 的 checkpoint。 | JSON 匿名下载 401；`finepornV4...` 没找到可核验 Civitai model/version 页面，所以无法按作者配方完整复现，降级为旁证。 |
| **Lonecat's Krea2 Identity Edit & Head Swap v6** | [`2803688 / 3270374`](https://civitai.red/models/2803688?modelVersionId=3270374) · [API](https://civitai.red/api/v1/model-versions/3270374) | 作者页明确 1 或 2 张 reference、head swap、RMBG 提升一致性；属于真实 reference edit 设计。 | identity edit LoRA / nodes、RMBG、upscale、作者 LC123 / 后处理节点。 | 无该精确版本的 NSFW identity-edit 元数据。 | JSON 匿名下载 401；当前 API 样图未暴露 Comfy graph，证据弱于 RedNode / Selfism。 |
| **Krea2 Identity Instant Pose & Outfit v1**，ugurdoyduk341 | [`2809079 / 3167685`](https://civitai.red/models/2809079?modelVersionId=3167685) · [API](https://civitai.red/api/v1/model-versions/3167685) | 作者描述包含人物参考、RMBG 与 grounded encode，目标是同一身份换姿势、服装、背景。 | 自带 Gemini 生成的 pose/outfit custom node、RMBG；作者推荐 [`Muse v2.5 INT8 Turbo 2741166 / 3147272`](https://civitai.red/models/2741166?modelVersionId=3147272) · [API](https://civitai.red/api/v1/model-versions/3147272)，人物保持还应固定 [`Identity Edit v1.2 / 3139172`](https://civitai.red/api/v1/model-versions/3139172)。 | 内置 “spicy options” 只是提示词入口；成人能力来自 Muse，未见同跑 explicit 元数据。 | ZIP 匿名下载 401；使用 Heretic Qwen3-VL / 第三方 VAE，且 API 不暴露 graph，下载后需确认 Identity Edit LoRA、GroundedEncode 和 ModelPatch 没有被旁路。 |
| **Krea2 Img2Img Face Swap v2**，ugurdoyduk341 | [`2854733 / 3228763`](https://civitai.red/models/2854733?modelVersionId=3228763) · [API](https://civitai.red/api/v1/model-versions/3228763) | 作者说明 v2 把 Krea2 Edit Model node 接到第一 sampler，后续两次 sampler 改善脸部；目标是用参考身份替换 inspiration pose。 | Jib Mix Krea2、Krea2Edit、Heretic Qwen3-VL、三次 sampler；v2 已移除 SAM3。精确 Jib 候选是 [`v2.0 Bell Pepper / 3156474`](https://civitai.red/models/2799984?modelVersionId=3156474) · [API](https://civitai.red/api/v1/model-versions/3156474)，以及 [`v4.0 Habanero / 3252207`](https://civitai.red/models/2799984?modelVersionId=3252207) · [API](https://civitai.red/api/v1/model-versions/3252207)。 | Jib Mix v2 / v4 作者页及各自样图有 NSFW 内容证据；但 FaceSwap 页没有参考图 + explicit NSFW 同一次运行的元数据。 | JSON 匿名下载 401；多次 sampler 会重绘脸，身份漂移风险高。v4 与该 workflow 发布时使用的版本可能不同，必须分别 A/B。 |
| **Krea 2 head swap in ComfyUI v1**，Stable_Yogi | [`2884442 / 3260452`](https://civitai.red/models/2884442?modelVersionId=3260452) · [API](https://civitai.red/api/v1/model-versions/3260452) | 作者明确“两张照片输入”；比较六组同 seed 后称只用 identity LoRA 比叠 head-swap + identity 两个 LoRA 更少混脸。 | Muse checkpoint、Identity Edit、`comfyui-krea2edit`、`qwen_image_vae`。 | 无同跑 NSFW 元数据。 | JSON 匿名下载 401；非 16:9 会出现底部 smear；作者明确警告错误 VAE 会产出彩色噪声。 |

普通 `LoadImage → QwenVL image-to-prompt → 文生图` 只让模型得到语义描述，不构成人物保持；普通 `VAEEncode → KSampler denoise` 只能保持原图像素/构图，不能证明换场景后的身份锁定。`Krea 2 Turbo Image-to-Image (+ Face Preservation)`（`2768351 / 3116348`）依靠保护面罩保留原始脸像素，或通过 ReActor 事后换脸，因此也不算 Krea 2 原生 identity-reference。

## 三、可组合的 NSFW checkpoint / LoRA

| 组件 | 精确资源 | NSFW 证据 | 与 identity 路线的关系 | 条件 / 缺陷 |
|---|---|---|---|---|
| **Muse V3.0 Extended Turbo Edit**，Stable_Yogi | [`modelId=2741166 / versionId=3200345`](https://civitai.red/models/2741166?modelVersionId=3200345) · [API](https://civitai.red/api/v1/model-versions/3200345)；INT8 `museByStableYogi_v30ExtendedTurboEdit.safetensors`，约 11.95 GiB，SHA-256 `FD16550425043577D0173BF5E6110AAB8533FAF87AB2FF23A0B020C2C750C22E` | 精确版本页有两张 `nsfwLevel=16` 样图和明确成人 prompt。 | 作者总说明称 identity editing 已烘进 checkpoint，使用 `comfyui-krea2edit` nodes，并跳过独立 edit LoRA loader；这是最接近一体模型的候选。 | 匿名下载 401。关键边界：版本页样图元数据的 model hash 是 `e00c4ae933`、名称是同系列 NVFP4，不等于该 INT8 Edit 文件哈希；也没有参考图 + NSFW 同跑元数据。 |
| **Moody Krea 2 Mix V7**，catlover1937 | [`2731187 / 3209007`](https://civitai.red/models/2731187?modelVersionId=3209007) · [API](https://civitai.red/api/v1/model-versions/3209007) | 作者明确说 V7 “NSFW influence is relatively strong”；样图包含 NSFW prompts。 | 作为底模先加载，再加载 Identity Edit v1.2；RedNode/Krea2Edit 接收人物参考。可额外叠 NSFW LoRA，但先测底模本身，避免 LoRA 互相抢注意力。 | 匿名下载 401。作者的 V7 样图 workflow 本身是 `EmptyLatentImage` T2I，不是 reference identity；与 Identity Edit 的成人同跑需要 A/B。 |
| **Selfora v2.1 Night Fix**，Artfat | [`2841090 / 3231439`](https://civitai.red/models/2841090?modelVersionId=3231439) · [API](https://civitai.red/api/v1/model-versions/3231439)；INT8 checkpoint | 作者称从 clean Krea 2 Raw 重建、烘入 PornMaster Krea2、fully uncensored，偏写实 amateur NSFW；并说明可叠 character LoRA。 | 与 Selfism AIO 的 identity-edit 分支组合最方便；也可替换 RedNode 的 checkpoint。 | 匿名下载 401；个人非商用许可。角色 LoRA 与 baked merge 可能互相竞争，作者建议强度约 0.8；这不是单图参考 identity 的替代品。 |
| **PornMaster Krea2 Uncensored V2**，iamddtla | [`2768638 / 3199198`](https://civitai.red/models/2768638?modelVersionId=3199198) · [API](https://civitai.red/api/v1/model-versions/3199198)；BF16 LoRA 约 109 MiB | 精确版本页全部为 `nsfwLevel=16` 成人样图；作者称用于绕过 Krea 2 refusal，权重 0.5–1。 | 可放在 Moody / 官方 Krea 2 与 Identity Edit v1.2 之前一起加载，NSFW 来自它，身份来自 Identity Edit。 | 匿名下载 401。作者明确说它没有优化生殖器质量，并建议配其他 NSFW LoRA；容易无意加入白色液体。多 LoRA 堆叠可能削弱身份保持。 |
| **NSFW LoRA Krea2 v2**，Ai_Art_Vision | [`655753 / 3231284`](https://civitai.red/models/655753?modelVersionId=3231284) · [API](https://civitai.red/api/v1/model-versions/3231284)；FP16 LoRA 约 224 MiB | 精确版本页含多个 `nsfwLevel=16` 样图；作者建议权重 0.5–1。 | PornMaster 的替代 NSFW LoRA，可与 identity-edit 叠加测试。 | 匿名下载 401；作者没有提供 Krea2 训练配置或 identity 同跑结果，证据比 PornMaster 少。 |

## 推荐装配

### P0：Muse Edit + RedNode 首选路线

```text
Muse V3.0 Extended Turbo Edit 3200345
  + qwen3vl_4b_fp8_scaled (type=krea2)
  + qwen_image_vae
  + RedNode v1.3 3153173 / ComfyUI-Krea2Edit reference conditioning
  + LoadImage subject -> Krea2RedNode 或 GroundedEncode + reference latent/model patch
  + 不加载 krea2_identity_edit_v1_2（已烘入）
```

RedNode v1.3 的公开示例默认显式加载 Identity Edit v1.2；换成 Muse Edit 时删除这个重复 LoRA，只保留 `Krea2RedNode` / Krea2Edit 的参考图 conditioning。首测按 Muse 作者范围用 16 steps、CFG 2、Euler / Simple、约 1MP、`ref_boost` 2–4。分别做 SFW 换背景和最低充分 NSFW 换场景两次，记录同一参考脸的相似度；这是确认“烘入 edit + 成人生成”是否在精确 INT8 文件上同时成立的最低闭环。

### P1：Identity Instant Pose + Muse v2.5 备选路线

```text
Identity Instant Pose & Outfit workflow 3167685
  + Muse v2.5 INT8 Turbo 3147272
  + Krea 2 Identity Edit v1.2 3139172 @ 1.0
  + comfyui-krea2edit GroundedEncode + ModelPatch
  + qwen_image_vae 作为首轮基准
```

这条路线适合批量换 pose、outfit、background。Pose 节点只负责产生提示组合；人物保持必须由参考图进入 GroundedEncode / reference latent 与 Identity Edit LoRA 来完成。作者配方使用 Heretic encoder 和第三方 VAE，首轮建议先换回上游 Qwen3-VL + `qwen_image_vae`，减少变量。

### P2：Img2Img FaceSwap + Jib Mix 备选路线

```text
Krea2 Img2Img FaceSwap v2 3228763
  + Jib Mix v2.0 Bell Pepper 3156474 或 v4.0 Habanero 3252207
  + Krea2Edit reference path
  + 第一 sampler 做 identity edit，后两段仅低强度修脸/细节
```

Jib Mix v2 与 v4 的作者页 / 样图提供 NSFW 能力证据；workflow 作者则提供参考身份替换的设计说明。两项证据来自不同运行，不能合并写成“已验证 NSFW 人物保持”。先从 v2 开始复现作者时期的配方，再单独测 v4；第二、三 sampler 的 denoise 必须足够低，否则会重绘身份。

### P3：Moody V7 透明实验组合

```text
Moody Krea 2 Mix V7 3209007
  -> LoraLoaderModelOnly: krea2_identity_edit_v1_2 @ 1.0
  -> 可选 PornMaster Krea2 V2 @ 0.5 起步
  -> Krea2EditModelPatch

LoadImage subject
  -> VAEEncode -> EditModelPatch.source_latent
  -> Krea2EditGroundedEncode.image

EmptySD3LatentImage
  -> KSampler.latent_image
  -> EditModelPatch.target_latent
```

优先使用上游 `qwen_image_vae`，Turbo 8–12 steps、CFG 1、Euler / Simple、≤2MP。先不加载第二个 NSFW LoRA，确认 Moody 本身能否完成；需要时再加 PornMaster，避免一次堆太多 LoRA 后无法判断身份下降来自哪里。RedNode v1.3 可把这套 wiring 简化为一个 identity 节点，但模型与 LoRA 版本仍应显式冻结。

### P4：Selfism AIO 对照路线

用 `Selfism AIO 3211045 + Selfora v2.1 INT8 3231439`，启用 Edit Mode、两张 reference、Krea2 identity edit，禁用第一段普通 T2I sampler。首轮把 Edit VAE 改回 `qwen_image_vae`，并关闭不必要的 detailer、ControlNet、额外 NSFW sliders；确认基础 identity-edit 后再逐项启用。

## 明确排除

- 普通 style reference / moodboard：只能证明风格、色彩、光影或主体语义传递，不能当锁脸。
- 只靠固定 seed、prompt、脸部描述：只能得到相似审美，不是跨姿势、场景身份保持。
- 只有 `LoadImage → image-to-prompt`：参考图没有进入 reference latent / identity edit 路径。
- 只有普通 img2img denoise、保护面罩或 ReActor 后处理：分别是像素保留或事后换脸，不是 Krea 2 identity-reference。
- 只有 NSFW 解锁、prompt enhancer、image-to-prompt、upscale 或普通 T2I 的工作流：例如 `Krea2 [SFW / NSFW] Uncensored`（`2738703 / 3079753`）能证明成人文生图，但没有 Identity Edit / GroundedEncode / reference latent 时，不能回答人物保持问题。
- SDXL / FLUX 的 InstantID、PuLID、IP-Adapter：未找到 Krea 2 专用权重与一手兼容证据，不列入。
- 单独的 character LoRA：可以长期保持一个训练过的人物，但不满足“临时给一张参考图就锁定身份”的目标，应与 one-shot identity-edit 分开评估。

## 验证状态

本轮通过 Civitai 精确 model/version API、作者说明、Civitai 样图 `meta.comfy`、作者开源节点与 workflow JSON，以及 Krea / Ostris / ComfyUI 一手来源完成能力边界核验。匿名下载探针显示：Identity Edit v1.2、Ostris Style Reference 与 Skimpy Slider 可直接下载；多数近期 checkpoint / workflow / NSFW LoRA 返回 401，要求登录。

本轮没有下载 8–14 GiB checkpoint，也没有执行本地 reference + NSFW 同跑，因此推荐优先级是**证据完整度与可复现性排序**，不是人物相似度实测榜单。
