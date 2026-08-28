# iDream 单人物参考图生图：模型与工作流选型

> 核验日期：2026-08-28
>
> 范围：一个成年虚构角色、一张权威参考图、换场景/服装/姿态并保持人物。本文不研究多人身份，也不提出每角色训练方案。
>
> 方法：官方模型卡、官方仓库/许可证、Civitai 精确 model/version API、作者随版本提交的 ComfyUI graph。没有下载权重，没有生成图片。
>
> 证据边界：作者样图只证明某个 checkpoint 曾生成过该类画面；只有参考图真正进入训练匹配的 conditioning graph，才算“人物保持”证据。

## 结论

iDream 现在不应在没有同参实测时宣布某个 checkpoint 是最终赢家。真正进入最终资格赛的两条主线是：

1. **模块化 incumbent**：RedCraft `3139241` FP8 + Krea 2 Identity Edit v1.2 `3139172` full + `comfyui-krea2edit` v1.2.5 单参考双条件 graph；
2. **一体化 challenger**：SinoX Edit_v1.1 `3174825` FP8 + 同一套 Krea2Edit 单参考双条件 graph，但不重复加载 Identity LoRA。

如果今天必须在没有新生成的前提下选择实施起点，RedCraft 风险更低：模型已在本机运行，成人 checkpoint、Identity 权重和 node revision 可以分别 pin、替换和归因。但如果问“哪个新模型最可能减少集成变量”，答案是 SinoX：它是本轮唯一同时具备烘入 Identity v1.2、精确参考图 graph、FP8 和作者层 `Rent` 的一体 Edit checkpoint。**最终默认必须由同一参考图、prompt、seed 和 graph 的 A/B 决定。**

RedCraft 之外应分两种问题回答：

1. **允许使用一体 Edit checkpoint 时，第一替代候选是 SinoX Edit_v1.1 `3174825` FP8。** 它是本轮找到的唯一同时具备“作者明确集成 Identity Edit v1.2、精确 Edit graph、FP8、Civitai `Rent`”的候选。它比 Muse Edit 更适合 Apple/站外服务资格赛。限制是精确 Edit_v1.1 画廊最高为 `nsfwLevel=8`，没有 level-16 证据；所以它是最值得实测的替代，不是已经证明更强的默认。
2. **若严格要求“成人底模 + 外接 Identity Edit”，第一压力候选是最新 Dark Beast Krea2 3.0 `3173268` FP8。** 它的显式成人 prior 比 RedCraft 更强、同样有 `Rent`，但更激进的 checkpoint prior 更可能压过参考图的脸/体型/肤质，必须把身份漂移率作为一票否决指标。旧 `3078453` 只保留为历史复现，不再作为最新候选。

另外建立一条透明诊断基线：

**官方 Krea 2 Turbo FP8 + NSFW_Krea2 v2 `3231284` + Identity Edit v1.2。**

这条路线不是预判的画质冠军，但三层职责完全可拆：官方底模负责通用构图，`NSFW_Krea2 v2` 负责成人概念，Identity Edit 负责参考身份。它最适合回答“失败来自成人 LoRA、身份层还是某个 merge checkpoint”，是资格赛必须保留的控制组。

不应进入 iDream 站外付费默认路线的候选：

- **Moody V7**、**Lustify v10**：成人样图强，但精确版本作者 graph 是 T2I，不自带参考身份；且都没有 Civitai 站外收费服务所需的 `Rent`。
- **Muse Extended Turbo Edit**：确实烘入 Identity Edit，但精确文件只有 INT8，Civitai 只有 `RentCivit`；版本页成人样图用的还是另一个 NVFP4 文件 hash，不是 Edit 文件。
- **Selfora v2.1**：API 虽显示 `Rent`，作者正文却写明“Personal, non-commercial use only”。冲突时取更严格的作者文本，直接排除。
- **官方 Krea 2 Raw/Turbo**：是干净兼容性基线，不是成人专项 checkpoint；Raw 也不是日常推理默认。
- **Mage-Flow Edit Turbo**：4B/4-step 很适合做延迟对照，但不是身份专项；微软官方 pipeline 的强制内容 gate 会拒绝成人请求。ComfyUI raw-weight 路径是另一条执行路径，不能把两者混称为同一能力。

## 1. 第一性原理：我们实际在组合四种不同的东西

单参考角色图的结果不是“一个模型分数”，而是四个独立环节的乘积：

```text
最终可用率
  = checkpoint 的画面/身体 prior
  × Identity Edit 的人物保持能力
  × workflow 是否按训练方式输送参考图
  × 运行格式与许可是否可上线
```

必须严格区分：

- **成人画面 prior**：checkpoint/成人适配层是否理解身体、姿态、皮肤和明确场景。它不等于知道“参考图中的人是谁”。
- **Identity Edit 层**：把参考人物的 appearance 与语义身份加入模型。当前公开生产候选是 v1.2；它只用 SFW 数据训练，不能为成人组合质量背书。[Identity Edit 模型卡](https://huggingface.co/conradlocke/krea2-identity-edit)
- **workflow graph**：同一张参考图必须同时进入 VAE latent 路径和 Qwen3-VL grounded 路径。普通 `CLIPTextEncode`、只做 img2img denoise、或只写外貌 prompt，都不是训练匹配的身份锁。[上游 node README](https://github.com/lbouaraba/comfyui-krea2edit/blob/bdfa8b267fdb13730868d435b277dcfe696ec083/README.md)
- **格式/许可**：FP8、BF16、INT8、GGUF 是运行形态，不是模型能力；Civitai `Rent` 只回答作者是否允许站外收费生成，不能覆盖 Krea 上游许可证。

因此，一张漂亮的裸体图只能证明成人 prior；一张漂亮的人像 edit 只能证明某个 edit case；都不能单独证明“任意单参考角色在多场景保持稳定”。

## 2. 版本事实修正：公开的 Identity Edit v1.3 并不存在

截至核验日，Civitai model `2761113` 只有 v1.0、v1.1、v1.2 三个版本；Hugging Face 文件树也只到 v1.2。[Civitai model API](https://civitai.red/api/v1/models/2761113)；[Hugging Face 文件树](https://huggingface.co/conradlocke/krea2-identity-edit/tree/89e9e7a09ee2e5c9331e952063d79b1b8a703280)

作者在“1.3 When?”讨论中只说正在研究下一版、希望做成明显升级，没有发布权重或日期。[作者回复](https://huggingface.co/conradlocke/krea2-identity-edit/discussions/49)

容易混淆的三个版本号是：

| 名称 | 它是什么 | 当前状态 |
|---|---|---|
| Identity Edit **v1.2** | 身份编辑权重 | 当前公开推荐版本 |
| `comfyui-krea2edit` **v1.2.5** | ComfyUI 节点包 | node-only 更新；加入 `target_latent` 预编码，tag 对应 commit `bdfa8b267fdb13730868d435b277dcfe696ec083`。[release](https://github.com/lbouaraba/comfyui-krea2edit/releases/tag/v1.2.5) |
| RedNode **v1.3** `3153173` | 第三方节点/工作流归档 | 不是 Identity 权重；文件 `3033937` SHA `0037E14672FFEB2868E837E21F1D70F0DC0A5EFE994980C56A04B1E8267BA0DD`。[Version API](https://civitai.red/api/v1/model-versions/3153173) |

生产配置现在只能 pin v1.2；不得用一个不存在的 v1.3 权重名做自动解析或回退。

## 3. Krea 候选矩阵

| 路线 | 成人 prior 的精确证据 | 单参考身份层 | Apple/MPS 候选格式 | 站外付费服务 | 判断 |
|---|---|---|---|---|---|
| **RedCraft `3139241` + Identity v1.2** | 作者写 `No Mosaics`；精确版本有 2 张 level-16 图，但随图 graph 是 `EmptyLatentImage + CLIPTextEncode` 的 T2I | 外接 v1.2 full；双条件 graph | FP8、INT4、INT8、NVFP4；Apple 首测 FP8 | **有 `Rent`** | 当前主线 |
| **SinoX Edit_v1.1 `3174825`** | 作者称 uncensored；精确 Edit 画廊最高 level 8，没有 level 16 | **已烘入 v1.2**；精确随图 graph 有 `Krea2EditModelPatch + GroundedEncode`，无需再次加载 Identity 权重 | **FP8**、INT8；Apple 首测 FP8 | **有 `Rent`** | 最值得替代 RedCraft 的一体路线 |
| **Dark Beast Krea2 `3078453` + Identity v1.2** | 作者明确 uncensored/zero mosaics；精确版本有 2 张 level-16 图 | 外接 v1.2；作者版本页未给精确 edit 同跑 | **FP8** | **有 `Rent`** | 最强成人底模替代；身份竞争风险更高 |
| **官方 Turbo FP8 + NSFW_Krea2 v2 + Identity v1.2** | 成人适配层 v2 精确画廊含 level-16；底模本身非成人专项 | 外接 v1.2，职责透明 | Turbo FP8 scaled + 两个 FP16 小权重 | 三层作者权限可成立；仍受 Krea 上游许可 | 透明诊断基线 |
| **Lustify v10 `3112728` + Identity v1.2** | 作者明示面向女性显式场景；精确版本 4 张 level-16，T2I graph | 外接 v1.2；作者 workflow `3159388` 明确依赖该层 | FP8/BF16/GGUF 可选 | **无 `Rent`**，只有 `Image + RentCivit` | 内部画质对照，不能开放站外收费生成 |
| **Moody V7 `3209007` + Identity v1.2** | 作者称 V7 NSFW tendency 较强；精确版本 2 张 level-16 | 外接 v1.2；作者 graph 仍是 T2I，没有 reference/edit nodes | FP8、NVFP4、INT8 | **无 `Rent`**，只有 `RentCivit` | 样图强，产品许可不成立 |
| **Muse Edit `3200345`** | 版本页有 level-16 图，但资源 hash `e00c4ae933` 属同系列 NVFP4，不是 Edit 文件 `FD165…` | **已烘入 v1.2**；仍需 Krea2Edit nodes，不能再加载同一 Identity 权重 | **只有 INT8** | **无 `Rent`**，只有 `RentCivit` | NVIDIA 研究对照，不是 Apple/产品路线 |
| **官方 Krea 2 Turbo/Raw + Identity v1.2** | 官方模型做过安全定向训练，非成人专项 | 作者直接支持 Turbo/Raw | BF16；Comfy-Org 有 FP8 scaled | Krea Community License | 干净兼容性基线 |

成人图数量和 graph 类型来自各精确 [RedCraft Version API](https://civitai.red/api/v1/model-versions/3139241)、[Dark Beast Version API](https://civitai.red/api/v1/model-versions/3078453)、[Moody V7 Version API](https://civitai.red/api/v1/model-versions/3209007)、[Muse Edit Version API](https://civitai.red/api/v1/model-versions/3200345)、[Lustify v10 Version API](https://civitai.red/api/v1/model-versions/3112728)、[SinoX Edit Version API](https://civitai.red/api/v1/model-versions/3174825)。

### 3.1 精确文件、格式和 hash

| 组件 | 精确文件 | SHA-256 | 说明 |
|---|---|---|---|
| RedCraft `3139241` | file `3019490` `redcraftREDMIXHybridA2A_30Krea2.safetensors`，FP8，约 12.24 GiB | `F6088960C0FEBD27CBD372FC758BB07D012F2D8AE3CD10C45C903D48B94409EA` | 主线底模 |
| SinoX Edit_v1.1 `3174825` | file `3055566` `sinoxKrea2Aesthetics_editV11.safetensors`，FP8，约 12.24 GiB | `D4CE8A5E742330EC96C5E26EDE52C7E3E619C217735E7A58F6ADE65C0EFFD0B8` | 一体 Edit 首选资格赛文件；另有 INT8 `3061571` |
| Dark Beast `3078453` | file `2958418` `darkBeast30BF16INT8_darkBeastKREA2FP8.safetensors`，FP8，约 11.94 GiB | `0C005BB2DA4AA249CEB4E9A90C3914DA9280660CF480F780C7386B92A8CFFC1B` | 成人压力候选 |
| Moody V7 `3209007` | file `3090691` `moodyKrea2Mix_v70.safetensors`，FP8，约 13.16 GiB | `405DB6A1D060075D176C3578063B6FA2FEB07B58BB61DDB403DDBA0669A35A6D` | 主文件其实是 NVFP4 `3090679`；Apple 比较应明确选 FP8 |
| Muse Edit `3200345` | file `3081686` `museByStableYogi_v30ExtendedTurboEdit.safetensors`，INT8，约 11.95 GiB | `FD16550425043577D0173BF5E6110AAB8533FAF87AB2FF23A0B020C2C750C22E` | 无 FP8/BF16/GGUF 同版文件 |
| Lustify v10 `3112728` | file `2997637` Turbo FP8，约 11.94 GiB | `94D92700FC45200EF053895EC5655D4F64A69B924C1EFAA457521DFC22BD5E00` | 同版另有 BF16、INT8、Q2/Q4 GGUF、Raw |
| Identity Edit v1.2 `3139172` | file `3019297` `krea2_identity_edit_v1_2.safetensors`，FP16，约 1.70 GiB | `6ADF9A69CC9502D286DB7B69964D37DA7E9CFE4B05B4D004BC275F087D3FD3CF` | 质量基线用 full；r128/r64 只能在证明无损后降级 |
| NSFW_Krea2 v2 `3231284` | file `3113642` `NSFW_Krea2_loRA_ep9_v2.safetensors`，FP16，约 224 MiB | `9B2EA0A79D7AC43949F159EB6FE066BF80DB5D3BA3F3FD36C02A1D99C18DC7B8` | 透明成人适配层；作者建议 strength 0.5–1。[Version API](https://civitai.red/api/v1/model-versions/3231284) |
| 官方 Krea Raw BF16 | `raw.safetensors`，repo revision `6b0ece7fffb640c5e3bcbe0a7f10f66b8e60a603` | `F99BB0FF8E362B77342BC4994E0C50906FE7EF7074864B181B7D48D2FA6D03D7` | 官方 52 steps / CFG 3.5；不是日常推理默认 |
| Comfy-Org Raw FP8 | `diffusion_models/krea2_raw_fp8_scaled.safetensors`，repo revision `e5ea8b4dd7f38f348b138eb0fe29f92c0e367e96` | `48CD5D6C100297968349B41A8E77C6591D1DAC18A215807F5F25F59E5C54CD61` | Raw 的较小运行格式；仍保留 Raw 的高步数职责 |
| 官方 Krea Turbo BF16 | `turbo.safetensors`，repo revision `98e0fe118d17c9e3547fbb2e25acdbae2cadf7c7` | `78BBF8F4165EDA19CEA3CB06C78089221932A39E2EED8AF9DA741F942C47FFB3` | 官方完整精度文件 |
| Comfy-Org Turbo FP8 | `diffusion_models/krea2_turbo_fp8_scaled.safetensors`，repo revision `e5ea8b4dd7f38f348b138eb0fe29f92c0e367e96` | `EB4DD8C612CFD10F64F25B057E6E6BBCB5737C94A7372177E456DBF7579502F1` | 透明基线的 Apple 首测 DiT 文件；[固定文件树](https://huggingface.co/Comfy-Org/Krea-2/tree/e5ea8b4dd7f38f348b138eb0fe29f92c0e367e96) |

官方 Krea 共用的 Qwen3-VL BF16 text encoder SHA 是 `36F3FF447EF59201722E8F9CE6020C9819FDCFBA6AA2608C4E09B1C0CE114E34`，Qwen Image VAE SHA 是 `A70580F0213E67967EE9C95F05BB400E8FB08307E017A924BF3441223E023D1F`。部署清单必须把它们与 DiT 一起 pin，不能只记录 checkpoint 名。

### 3.2 为什么 SinoX 是一体 Edit 的第一候选

SinoX 的证据比 Muse 完整：

- 作者在精确版本说明中明确写明 Edit_v1.1 集成 Identity Edit v1.2；[Version API](https://civitai.red/api/v1/model-versions/3174825)
- 同一版本的 Civitai image metadata graph 直接加载 SinoX Edit UNET，经 `Krea2EditModelPatch` 和 `Krea2EditGroundedEncode` 采样；对照支路则是 official Turbo + external v1.2；
- 集成支路没有再次经过 `LoraLoaderModelOnly`，说明正确用法是“跳过外部 Identity loader，但保留两类 reference nodes”；
- 精确版本提供 FP8，model `2777406` 权限包含 `Image, RentCivit, Rent`。[Model API](https://civitai.red/api/v1/models/2777406)

但不能跨过的证据缺口也很清楚：精确 Edit_v1.1 画廊没有 level-16 图片；“uncensored”来自作者文字和同系列 prior，不是精确显式 edit 结果。因此，SinoX 可以优先替换测试，不可直接替换生产默认。

### 3.3 为什么 Dark Beast 是外接 Identity 的第一替代底模

Dark Beast 具备最强的精确成人画面证据、FP8 和 `Rent`。它的不足不是“不够 NSFW”，而是 prior 过强：当底模把脸型、身材、皮肤、摄影风格都推向自己的高概率分布时，Identity Edit 需要更大 reference influence 才能拉回参考人物；过高的 `ref_boost` 又会降低换场景/姿态服从度。

所以 Dark Beast 的验收标准不能是“能否出图”，而必须是：在相同 reference、seed 集、12 steps、CFG 1 下，它是否在显式场景保持脸、体型和标志特征的通过率不低于 RedCraft。没有这个 A/B，就只能叫更强成人底模，不能叫更好的角色模型。

### 3.4 为什么透明三层基线必须保留

```text
official Krea 2 Turbo FP8
  + NSFW_Krea2 v2（成人概念，strength 可调）
  + Identity Edit v1.2 full（身份，strength 1.0）
  + canonical dual-conditioning graph
```

这条路线的价值是可解释：成人服从差就调/替换成人层；身份差就调 `ref_boost`/`grounding_px`；构图差则回到底模或 prompt。RedCraft、Dark Beast、SinoX 都是 merge/fine-tune，失败时无法同样干净地归因。

它也不是无条件生产首选：两个附加权重可能互相干扰；`NSFW_Krea2 v2` 的训练细节披露有限；Civitai `allowDerivatives=false` 意味着不要把三层另存为新 merge 分发。正确做法是运行时分别加载、固定各自 hash。

### 3.5 官方 Raw 与 Turbo 的正确分工

官方把 Raw 定义为未做后训练/蒸馏、适合 fine-tuning 或 post-training 的底模，并明确说不推荐用于常规推理；官方 recipe 是 52 steps、CFG 3.5。Turbo 是后训练和蒸馏后的推理版本，官方 recipe 是 8 steps、CFG 0。[Raw 模型卡](https://huggingface.co/krea/Krea-2-Raw)；[Turbo 模型卡](https://huggingface.co/krea/Krea-2-Turbo)

Identity Edit 的 node 作者进一步给出编辑侧分工：Turbo 8 steps/CFG 1 适合大多数换装、属性和场景编辑；真正的删除类编辑才切 Raw、约 20 steps/CFG 3。[节点使用说明](https://github.com/lbouaraba/comfyui-krea2edit/blob/bdfa8b267fdb13730868d435b277dcfe696ec083/README.md#usage-notes-read-these--they-matter)

对 iDream 的单人物成人场景变化，默认应是 Turbo 路线；Raw 只保留为“删除显著内容/大幅结构修改失败时”的诊断支路。Raw 没有额外成人 prior，也不会因为步数多自动更像参考人物。

## 4. 单参考最佳 graph

当前最小、训练匹配、可审计的 graph 是 `comfyui-krea2edit` v1.2.5 的单图路径，不是 RedNode v1.3 的大一统工作流。RedNode 对 moodboard、服装、多个来源做了封装，但 iDream 当前只需一个人物 reference；多一层第三方封装只增加版本和许可证变量。

```text
                         ┌─> VAEEncode ───────────────────> ModelPatch.source_latent
LoadImage(reference) ────┼─> ModelPatch.source_image
                         └─> GroundedEncode.image

VAELoader ─────────────────> ModelPatch.vae
EmptySD3LatentImage ───────> KSampler.latent_image
                 └────────> ModelPatch.target_latent

UNETLoader(checkpoint)
  ├─ modular route: [adult LoRA if used] -> Identity v1.2 @ 1.0
  └─ integrated route (SinoX/Muse): skip Identity loader
                         └─> Krea2EditModelPatch.model ───> KSampler.model

GroundedEncode(prompt + same reference) ─────────────────> KSampler.positive
GroundedEncode(empty prompt + same reference) ───────────> KSampler.negative
```

节点与布线依据：[上游 minimal wiring](https://github.com/lbouaraba/comfyui-krea2edit/blob/bdfa8b267fdb13730868d435b277dcfe696ec083/README.md#minimal-wiring)；[`target_latent` release](https://github.com/lbouaraba/comfyui-krea2edit/releases/tag/v1.2.5)。

推荐首轮固定值：

| 参数 | 首轮固定 | 原因 |
|---|---:|---|
| Identity weight | `1.0` | 作者训练/示例契约 |
| `fit_mode` | `fit` | v1.2 训练匹配几何；允许 source/output 不同纵横比 |
| `ref_boost` | `4` | 作者给出的强 likeness 起点；再用 2/4/6 小范围资格赛 |
| `grounding_px` | `768` | v1.2 训练范围上沿；1024 可做人物增强实验，但属于范围外尝试 |
| sampler/scheduler | `Euler / simple` | Identity 作者和多数 Krea Turbo checkpoint 共通 |
| steps / CFG | `12 / 1` | 在 8–12 Turbo 区间优先身份细节；CFG 1 避免额外 guidance 变量 |
| 输出 | `≤2MP` | 上游警告更高分辨率会 source bleed 或复制主体 |

两个实现细节不能省：

1. `target_latent` 必须连到与 sampler 相同的 latent。v1.2.5 会在采样前完成 pixel-path VAE encode，避免采样中途为 VAE 腾内存后模型逐步从 CPU 流式回载。
2. 同一张 reference 必须同时进入 `ModelPatch` 和 `GroundedEncode`。前者保 appearance，后者让 Qwen3-VL 理解“这张图中的这个人”。缺一条都会退化。

每次变化都从同一版不可变 reference 重跑，不把上一张生成图链式作为下一张参考。链式编辑会把小的脸型、体型和皮肤偏差逐轮固化。

## 5. 非 Krea 对照

| 路线 | 单参考身份事实 | 成人 prior | 格式/速度 | 许可与判断 |
|---|---|---|---|---|
| **Qwen-Image-Edit-2511 官方** | 官方明确“improved character consistency”，示例是原生 `QwenImageEditPlusPipeline`；40 steps | 非成人专项 | 20B BF16，官方页面提示可切 MPS，但没有 Apple 性能基准 | Apache-2.0；高质量身份基线，不是低延迟默认。[官方模型卡](https://huggingface.co/Qwen/Qwen-Image-Edit-2511) |
| **Qwen Rapid-AIO NSFW v19** | 原生 edit 输入；作者总结 v19 最偏 edit consistency | 明确 NSFW merge | 4–8 steps、CFG 1；AIO FP8 单文件 26.48 GiB | repo 标 Apache-2.0，但合并的 accelerator/skin/成人权重没有完整精确 transitive manifest；运行能力对照，许可尚需清单。[固定模型卡](https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO/blob/691024f438640508f8aa86414863fc15edfb8a84/README.md) |
| **Mage-Flow-Edit-4B-Turbo** | 通用 instruction edit，单 reference 原生；官方没有把它定义成身份专项 | 非成人专项；官方 pipeline 强制 `screen_edit` | 4B、4 steps、CFG 1；Comfy-Org 有 BF16 DiT | MIT；延迟/资源控制组，不替代身份主线。[官方 README](https://github.com/microsoft/Mage/blob/76bec2bb3818863f470de7e867c2dc7f1d0bfd83/mage_flow/README.md) |

精确 pin：

- Qwen official repo revision `6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9`；
- Rapid repo revision `691024f438640508f8aa86414863fc15edfb8a84`，v19 文件 `v19/Qwen-Rapid-AIO-NSFW-v19.safetensors`，28,431,843,583 bytes，SHA `BA71575515709C9912560D1176B2386EAA49294FEDC6CE57B9734AA57E91E5AC`；
- Mage Comfy-Org revision `f46772415dd30c3def49a0b2807af2bf781ff96d`，`mage_flow_edit_turbo_bf16.safetensors` SHA `29C3726ECD64AFE149EEF28AF3E27B6B40DE52646BFD16757A37DA4B6FBCF288`，另需 Qwen3-VL BF16 与 Mage VAE。[固定文件树](https://huggingface.co/Comfy-Org/Mage-Flow/tree/f46772415dd30c3def49a0b2807af2bf781ff96d)

Qwen official 的价值是判断“蒸馏/成人 merge 是否损伤身份”；Rapid v19 的价值是与当前少步成人 edit 能力对比；MageFlow 的价值是判断 4B/4-step 的速度收益是否值得较低的人物保持上限。三者都不改变 Krea 单参考 graph 的结论。

## 6. Apple/MPS 选择

本轮只做格式级判断，没有运行或测速：

1. **正确性基线优先 BF16；资源受限资格赛优先 FP8 scaled；不要把 INT8 ConvRot 设为 Apple 默认。** PyTorch/ComfyUI 的公开 MPS 报告显示 `aten::_int_mm` 未实现，CPU fallback 会更慢。[ComfyUI issue #15133](https://github.com/Comfy-Org/ComfyUI/issues/15133)
2. Krea 官方 BF16 模型卡明确提示 Apple 可切 `mps`，但没有给 Apple 延迟/峰值；这只是兼容入口，不是性能证明。[Krea Turbo 模型卡](https://huggingface.co/krea/Krea-2-Turbo)
3. FP8 在 MPS 上可能由 loader 转为 BF16/FP16 计算，磁盘减半不等于运行内存减半。必须从日志记录实际计算 dtype、offload 和峰值。
4. Muse Edit 只有 INT8，因此即使身份效果好，也在 Apple 主线先天落后于 SinoX FP8。
5. Lustify 的 GGUF 形态适合做 Metal/GGUF 后端实验，但许可已阻止站外付费默认；格式优势不能覆盖许可。
6. `stable-diffusion.cpp` 已有 `krea2_edit`、`qwen`、`mage_flow` presets，可作为 Metal/GGUF 平行后端；支持列表不等于质量或速度结论。[官方 edit 文档](https://github.com/leejet/stable-diffusion.cpp/blob/be0e34480dada95f8ce9a021bbb95c5de85d67c7/docs/edit.md)

## 7. 许可矩阵

Civitai 的权限源码把 `Image` 解释为可出售生成图片，`Rent` 解释为可运行在收费生成服务，`RentCivit` 只解释为可在 Civitai 运行。[Civitai 固定源码](https://github.com/civitai/civitai/blob/390a70c33285c5470a3b33f455f286afeb522972/src/components/PermissionIndicator/PermissionIndicator.tsx#L39-L54)

| 模型 | `allowCommercialUse` | iDream 站外付费判断 |
|---|---|---|
| RedCraft `958009` | `RentCivit, Rent, Image` | 作者层允许 |
| SinoX `2777406` | `Image, RentCivit, Rent` | 作者层允许 |
| Dark Beast `2242173` | `Image, RentCivit, Rent` | 作者层允许 |
| Identity Edit `2761113` | `RentCivit, Image, Rent` | 作者层允许 |
| NSFW Krea2 `655753` | `RentCivit, Rent, Image` | 作者层允许运行；不可据此分发新 merge |
| Lustify `573152` | `RentCivit, Image` | 不允许据此开放站外收费生成 |
| Moody `2731187` | `RentCivit` | 不允许 |
| Muse `2741166` | `RentCivit` | 不允许 |

所有 Krea derivative 还受 [Krea 2 Community License](https://github.com/krea-ai/krea-2/blob/db3984fbc6e13b34c0064990fc2d95ac64d00058/docs/KREA-2-COMMUNITY-LICENSE) 约束：过去 12 个月全公司总营收低于 100 万美元才可依社区许可商业使用；达到门槛需 Enterprise License。§3 还规定包含模型/derivative 的产品或服务的协议、命名和 NOTICE 要求。Civitai 的 `Rent` 不能覆盖这些上游条件。

Selfora 说明了为什么不能只读 API checkbox：model `2841090` 的 API 有 `Rent`，作者正文却明确写“Personal, non-commercial use only. Don't sell the model or anything made with it”。[Selfora Model API](https://civitai.red/api/v1/models/2841090) 因此按更严格文本排除。

## 8. 哪些是“样图强，但不适合 iDream”

### Lustify v10

它是本组最清晰的女性显式场景 checkpoint，精确画廊与 8-step graph 证据都强；但 graph 是 T2I。作者另发的 `3159388` workflow 明确要求安装 Krea2Edit nodes 和 Identity 权重，反过来证明 checkpoint 本身没有身份输入。[Workflow Version API](https://civitai.red/api/v1/model-versions/3159388) 再加上没有 `Rent`，它只能做内部成人 prior 上限对照。

### Moody V7

V7 作者做过 500-image 测试并明确承认 NSFW influence 较强；精确版本有 FP8 和 level-16 图。但随图 graph 是标准 T2I/后处理链，没有 `LoadImage -> Krea2Edit` 身份路径。它证明画面审美和成人倾向，不证明单参考稳定；许可同样没有 `Rent`。

### Muse Edit

Muse 的产品形态看似最方便，因为 edit 已烘入；但精确 `3200345` 只有 INT8。更关键的是版本页展示图的 resource hash `e00c4ae933` 与 Edit 文件 SHA `FD165…C22E` 不同，而且图没有 reference workflow metadata。因此不能用这些图证明精确 Edit checkpoint 的成人身份保持。SinoX 已在 FP8、`Rent`、精确 edit graph 三项上超过它。

### Dark Beast

它不是“不适合”，而是不能因 level-16 图强就直接升默认。它的精确样图 graph 是 T2I；与 Identity v1.2 的组合仍是未验证交叉项。正确位置是 RedCraft 之后的成人压力候选。

## 9. 单人物资格赛设计

不下载/生成是本轮研究边界；实际选型必须用相同 graph 做最小资格赛。建议只测四条：

1. RedCraft FP8 + Identity v1.2；
2. SinoX Edit_v1.1 FP8（不重复加载 Identity）；
3. Dark Beast FP8 + Identity v1.2；
4. official Turbo FP8 + NSFW_Krea2 v2 + Identity v1.2。

固定一张已批准 reference，每个场景固定 5 个 seed：正面半身、全身换姿态、侧面/三分之二角度、强光/低光、服装改变、背景改变、明确成人场景。每次都从原 reference 开始。

逐张记录：

- 脸部身份：眼距、鼻型、下颌、发际线、肤色；
- 身体身份：身高比例、肩胯、胸腰臀比例、痣/纹身等标志；
- 指令服从：姿态、服装、镜头、背景；
- 成人完成度：是否回避、遮挡、解剖错误；
- reference leakage：是否复制原背景、姿态、衣物；
- 失败形态：重复人物、面部融合、过度磨皮、肢体错误；
- 冷/热耗时、实际 dtype、峰值统一内存、offload 次数。

晋级规则应是门槛而非平均分：身份通过率、成人完成率、无重复人物率任一低于门槛即淘汰。审美只在通过硬门槛后排序。

## 最终推荐顺序

1. **保留主线**：RedCraft `3139241` FP8 + Identity Edit v1.2 full + canonical v1.2.5 single-reference graph。
2. **第一替代资格赛**：SinoX Edit_v1.1 `3174825` FP8。若其身份通过率不低于 RedCraft，且精确显式场景完成率过线，它会成为更简单的一体生产候选。
3. **成人压力候选**：Dark Beast Krea2 `3078453` FP8 + Identity v1.2。它回答“更强成人 prior 是否值得身份损失”。
4. **透明控制组**：official Turbo FP8 + NSFW_Krea2 v2 + Identity v1.2。用于定位 merge 失败，不因样图不够华丽而删除。
5. **非 Krea 控制**：Qwen official 2511 做身份质量上限，Rapid v19 做少步成人 edit 当前对照，MageFlow 做 4B/4-step 延迟下限。

在没有新生成证据前，最诚实的决定不是宣布某个新模型“更强”，而是把 **SinoX Edit_v1.1** 提升为 RedCraft 之外的首个端到端替代候选，并把 **Dark Beast** 保留为严格意义上的首选替代成人底模。
