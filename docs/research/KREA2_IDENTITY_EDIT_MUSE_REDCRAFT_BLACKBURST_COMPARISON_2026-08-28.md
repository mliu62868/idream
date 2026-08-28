# Krea 2 人物参考：Muse、RedCraft 与 “BlackBurst” 核验

日期：2026-08-28  
范围：核验 Civitai 精确版本、作者说明、样图 `meta.comfy` 与 Krea2Edit / RedNode 作者仓库；本轮未下载权重、未实跑。

## 结论

1. 用户链接的 [`Muse modelVersionId=3258954`](https://civitai.red/api/v1/model-versions/3258954) 是 **v3.5 Int8 Extended**，不是带人物参考编辑的版本。文件是 `museByStableYogi_v35Int8Extended.safetensors`，约 12.57 GiB，SHA-256 `53D9A2AA...E1939AF`。该精确文件有强 NSFW 证据：版本 API 的 10 张首发图中 8 张为 `nsfwLevel=16`，图像模型 hash `53d9a2aa38` 与文件一致；但图像元数据只有 T2I 参数，没有参考图或 Krea2Edit graph。
2. 带 Identity Edit 的 Muse 是 [`modelVersionId=3200345`](https://civitai.red/api/v1/model-versions/3200345)，名称 **v3.0 Extended Turbo Edit**，文件约 11.95 GiB、INT8、SHA-256 `FD165504...750C22E`。作者在[模型总说明](https://civitai.red/api/v1/models/2741166)中明确说 editing baked in、使用 `comfyui-krea2edit`、跳过独立 edit LoRA loader。因此它应接 RedNode / Krea2Edit 的参考图 conditioning，但**不要再叠 `krea2_identity_edit_v1_2`**。作者没有公布 baked LoRA 的精确 revision。
3. [`RedCraft 赤佬 3.0 / versionId=3139241`](https://civitai.red/api/v1/model-versions/3139241) 是 NSFW Krea 2 T2I checkpoint，不含 Identity Edit。它可以作为外部 [`Identity Edit v1.2 / 3139172`](https://civitai.red/api/v1/model-versions/3139172) 的候选底模，再接 RedNode / Krea2Edit；但未找到作者对这个精确组合的实跑证明。
4. Civitai 公共 API（包括成熟内容）没有名为 **BlackBurst** 的 Krea 2 checkpoint 精确命中，不能擅自等同为 BF95、Black Beast 或 Dark Beast。若用户实际指的是 **Dark Beast / 黑兽**，最可能是 [`modelId=2242173 / versionId=3078453`](https://civitai.red/api/v1/model-versions/3078453)；它同样是 NSFW T2I checkpoint，不是参考身份模型。

## 精确版本对比

| 路线 | 基础标记 / 文件 | NSFW 证据 | Identity Edit | 与参考图工作流组合 |
|---|---|---|---|---|
| Muse v3.5 Extended [`3258954`](https://civitai.red/models/2741166?modelVersionId=3258954) | `Krea 2`；INT8，12.57 GiB | **强，且精确文件 hash 对得上** | **未烘入** | 可实验性加载 Identity Edit v1.2 @1.0，再接 RedNode / Krea2Edit；尚无精确组合实跑 |
| Muse v3.0 Extended Turbo Edit [`3200345`](https://civitai.red/models/2741166?modelVersionId=3200345) | `Krea 2` Turbo Edit；INT8，11.95 GiB | 页面有两张 level-16 图，但样图 hash 是同系列 V3.0 NVFP4 `e00c4ae933`，不是 Edit 文件 `FD165...` | **作者称已烘入** | **首选集成**；保留参考图节点，跳过独立 Identity LoRA loader |
| RedCraft 赤佬 3.0 [`3139241`](https://civitai.red/models/958009?modelVersionId=3139241) | `Krea 2`；FP8 12.24 GiB、INT8 11.95 GiB、INT4 5.98 GiB、NVFP4 7.15 GiB | 作者称 no mosaics；精确版本有 2 张 level-16 图 | **未烘入** | 加 Identity Edit v1.2 + RedNode / Krea2Edit；候选，需实跑 |
| Dark Beast 黑兽 FP8 [`3078453`](https://civitai.red/models/2242173?modelVersionId=3078453) | `Krea 2`；Diffusion Model FP8 11.94 GiB，另有同名 full Model 20.68 GiB，须按 file id 区分 | 作者明确 uncensored / zero mosaics；精确版本有 2 张 level-16 图 | **未烘入** | 加 Identity Edit v1.2 + RedNode / Krea2Edit；候选，身份漂移风险需实测 |

RedCraft 与 Dark Beast 的首发图 `meta.comfy` 都从 `EmptyLatentImage` 进入 `KSampler`，节点集合没有 `LoadImage`、`Krea2EditGroundedEncode` 或 `Krea2EditModelPatch`。这只能证明 NSFW T2I，不能证明人物参考保持。

“Dark Beast” 还存在多个容易混淆的资源：同一主模型的 [`3091496`](https://civitai.red/api/v1/model-versions/3091496) 是黑兽 1.1 INT8 ConvRot；[`3173268`](https://civitai.red/api/v1/model-versions/3173268) 是黑兽 3.0，提供 INT8 / INT4 / NVFP4 / FP8 / BF16；另有第三方 GGUF 资源 [`modelId=2749127 / versionId=3092542`](https://civitai.red/api/v1/model-versions/3092542)。它们都不叫 BlackBurst，也不能互换版本证据。

## 参考图路径与兼容边界

人物保持必须让参考图同时进入两条路径：

```text
LoadImage -> VAE/reference latent -> Krea2EditModelPatch
LoadImage -> Qwen3-VL grounded encode -> Krea2EditGroundedEncode
```

这是 [`ComfyUI-Krea2Edit`](https://github.com/lbouaraba/comfyui-krea2edit) 和 [`ComfyUI-Krea2Moodboard / RedNode`](https://github.com/RedNodeAI/ComfyUI-Krea2Moodboard) 的作者规格。普通 image-to-prompt、固定 seed 或 checkpoint 自身“人物画得稳定”都不算 reference identity。

- **Muse Edit 3200345**：接上述两条参考路径，但跳过外部 Identity LoRA，避免重复 patch。
- **Muse 3258954 / RedCraft / Dark Beast**：先加载 Identity Edit v1.2，再进入 ModelPatch。作者权重卡建议 Turbo 8–12 steps、CFG 1、LoRA 1.0、`ref_boost≈4`、≤2MP；参考 [`Identity Edit 作者模型卡`](https://huggingface.co/conradlocke/krea2-identity-edit)与[节点 README](https://github.com/lbouaraba/comfyui-krea2edit#minimal-wiring)。
- RedNode 要求含 vision weights 的 `qwen3vl_4b`、`qwen_image_vae`；`target_latent` 应接到 patch 节点，避免显存紧张时在采样中途 VAE encode 导致反复 CPU streaming。

量化文件大小不是完整显存需求，还要给 Qwen3-VL、VAE、参考 latent 与采样留余量。作者对 Muse v3.5 的经验档位是 INT8 面向约 16 GB NVIDIA、NVFP4 面向 RTX 50 系；RedCraft / Dark Beast 可按同类格式估算，但需要实机测峰值。

ComfyUI [`v0.27.0`](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.27.0) 才加入原生 INT8 ConvRot，并包含 INT8 LoRA re-quant / offload 修复；INT4 ConvRot 是 [`v0.28.0`](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.28.0) 才加入。Apple MPS 的 INT8 eager 路径仍可能因 `aten::_int_mm` 未实现而失败，CPU fallback 会很慢，见 [ComfyUI #15133](https://github.com/Comfy-Org/ComfyUI/issues/15133)；Mac 首测应优先 FP8 / BF16，而不是 INT8 / INT4 ConvRot。Muse Edit 3200345 只有 INT8 文件，因此不能仅凭文件存在认定本地 Mac 可用。

## 推荐顺序

1. **NVIDIA：Muse Edit 3200345 + RedNode / Krea2Edit，跳过外部 Identity LoRA。** 变量最少，人物参考能力由作者明确声明。
2. **对照：Muse v3.5 3258954 + Identity Edit v1.2 + RedNode。** 精确文件的 NSFW 证据最强，但 identity 组合需要自己闭环。
3. **RedCraft 3139241 FP8 + Identity Edit v1.2。** 适合作为较温和的 NSFW / 画质对照；不要把 T2I 一致性当锁脸。
4. **若 BlackBurst 实指 Dark Beast：3078453 FP8 + Identity Edit v1.2。** 成人倾向最激进，最后测，因为强 checkpoint prior 可能与 identity prior 竞争。

Apple MPS 上跳过第 1 项的 INT8 直跑，先测 RedCraft FP8 与 Dark Beast FP8；Muse Edit 需有可信 FP8/BF16 转换或换 CUDA 机器后再测。

## 最小 A/B

使用同一张合成成年人物参考图，固定 `1024×1536`、seed、prompt、Qwen3-VL、`qwen_image_vae`、Euler / Simple、12 steps、CFG 1、`grounding_px=768`、`ref_boost=4`，各跑两张：SFW 换场景和最低充分 NSFW 换场景。

四个候选只改变模型装配：Muse Edit（无外部 LoRA）、Muse v3.5 + v1.2、RedCraft FP8 + v1.2、Dark Beast FP8 + v1.2。每条再保留一个“断开参考图”的 T2I control。记录文件 SHA、workflow JSON、峰值显存、耗时、是否真正执行 `GroundedEncode + ModelPatch`、脸部相似度与跨姿势身份漂移。没有这组结果前，推荐顺序只是**证据与可复现性排序**，不是人物保持质量榜单。

