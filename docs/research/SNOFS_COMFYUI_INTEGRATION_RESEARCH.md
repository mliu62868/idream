# SNOFS v1.4（Civitai 2960556）接入 iDream ComfyUI 研究

> 核验日期：2026-07-24
>
> 目标版本：[Civitai 页面](https://civitai.red/models/1972981/sex-nudes-other-fun-stuff-snofs?modelVersionId=2960556) / [Civitai 官方版本 API](https://civitai.com/api/v1/model-versions/2960556)
>
> 结论：**适合做独立、关闭流量的成人内容 LoKR 候选，不应替换 Qwen Image Edit 或当前生产线路；未取得两层商业授权前不可暴露给 iDream 用户。**

## 1. 它到底是什么

| 项目 | 核验结果 |
|---|---|
| Civitai model / version | `1972981` / `2960556` |
| 版本名 | `Klein 9b v1.4`，发布于 2026-05-20 |
| 资产类型 | Civitai 分类为 `LORA`；文件头进一步确认它实际是 **factor-4 LoKR（LyCORIS）适配器**，不是 checkpoint |
| 底模 | `Flux.2 Klein 9B`；作者样例加载的是 undistilled `flux-2-klein-base-9b` |
| 文件 | `klein_snofs_v1_4.safetensors` |
| 精确大小 | `1,090,563,760` bytes = `1.091 GB` / `1.016 GiB` |
| 精度与结构 | 336 个 BF16 tensor；键名为 `*.lokr_w1`、`*.lokr_w2`、`*.alpha` |
| 训练元数据 | `ai-toolkit 0.9.4`，step `122300`，`ss_base_model_version=flux2_klein_9b` |
| SHA-256 | `512C7F1D8DC7FA5DBC1FEE6049C2975EF3007300A5DE1712B3E1773CB95089F7` |
| BLAKE3 | `697051A1D617DF4DCD5FEDD27FD54D818EE2EA88FBAD735D8B13C9137CE2F664` |
| Civitai AutoV2 | `512C7F1D8D` |

来源：[Civitai version API](https://civitai.com/api/v1/model-versions/2960556)、[Civitai model API](https://civitai.com/api/v1/models/1972981)、作者的 [Hugging Face 仓库](https://huggingface.co/Ashen3/SNOFS/tree/main)。研究阶段先读取 SafeTensor 文件头确认 LoKR 结构；集成验证阶段随后下载了完整权重并校验 SHA-256。

下载可用性：

- Civitai API 公布的下载地址是 [`/api/download/models/2960556`](https://civitai.com/api/download/models/2960556)，但本次未登录请求返回 `401`。
- 作者 Hugging Face 仓库中的[同名文件](https://huggingface.co/Ashen3/SNOFS/resolve/main/klein_snofs_v1_4.safetensors)可公开读取，大小与 SHA-256 均和 Civitai 一致。

## 2. 提示词、强度和作者已公开的采样参数

没有专用 trigger token：版本 API 的 `trainedWords` 为空。作者明确说模型按**自然语言句子**训练，不应按 tag 堆词；直接完整描述人物、动作、构图、镜头和环境。作者列出的成人概念词只是可描述的语义，不是必须触发词。v1.4 对近景纹理偶有问题，作者建议出现该问题时在负面提示中加入 `goosebumps`。来源：[作者在 Civitai model API 中的完整说明](https://civitai.com/api/v1/models/1972981)。

Civitai 为该精确版本附了 10 张带完整 ComfyUI metadata 的作者样例，参数高度一致：

- 底模：`flux-2-klein-base-9b.safetensors`
- LoKR strength：`1.0`
- steps：`50`
- CFG：`5.0`
- sampler：作者有意混用了 `euler`、`res_multistep`、`er_sde`、`deis`、`ipndm`、`uni_pc`
- 文本编码器：作者本机命名为 `qwen_3_8b.safetensors`
- VAE：`flux2-vae.safetensors`

因此可把 **LoKR strength 1.0** 视为作者给出的起点，但不能把某一个 sampler 宣称为唯一推荐。样例都是 txt2img，没有提供 classic img2img 的 denoise strength。

## 3. 图生图是否合适

**底模适合，SNOFS 本身仅是成人概念增强，不是专门的图像编辑器。**

- BFL 将 FLUX.2 Klein 9B 定义为统一的 txt2img、单参考和多参考编辑模型；官方模型卡也给出 Apple `mps` 与 `image=` 输入示例。[BFL 9B 模型卡](https://huggingface.co/black-forest-labs/FLUX.2-klein-9B)
- ComfyUI 官方分别提供 9B Base 与 Distilled 的 image-edit workflow。[ComfyUI Klein 指南](https://docs.comfy.org/tutorials/flux/flux-2-klein)
- SNOFS 作者明确说它**没有用成对编辑数据训练**；作者当前建议 txt2img 用 Base，editing 用 Distilled。因此它可能改善编辑结果中的成人概念与肢体语义，但没有证据证明其人物身份保持、局部编辑精度或多参考一致性优于 Qwen Image Edit。

图生图建议保留两条试验配方：

| 配方 | 底模 | sampler / steps / CFG | LoKR |
|---|---|---|---|
| 作者质量向起点 | Klein 9B Base | 作者 showcase 为多种 sampler / `50` / `5`；官方 Base edit 模板为 Euler / `20` / `5` | `1.0` |
| 作者建议的编辑起点 | Klein 9B Distilled | 官方 Distilled edit 模板为 Euler / `4` / `1`，并使用 `ConditioningZeroOut` | `1.0` |

官方模板来源：[9B Base image edit JSON](https://raw.githubusercontent.com/Comfy-Org/workflow_templates/refs/heads/main/templates/image_flux2_klein_image_edit_9b_base.json)、[9B Distilled image edit JSON](https://raw.githubusercontent.com/Comfy-Org/workflow_templates/refs/heads/main/templates/image_flux2_klein_image_edit_9b_distilled.json)。

这里的“strength”应分清：

- LoKR 强度：作者样例是 `1.0`。
- 参考图强度：ComfyUI 核心 `ReferenceLatent` 没有 denoise/strength 参数；它把 VAE 编码后的参考 latent 加入 conditioning。编辑幅度主要由提示词、参考图组合和 Base/Distilled 采样配方决定，不是传统 SD img2img 的 denoise slider。

## 4. ComfyUI 最小工作流

不需要 IPAdapter、ControlNet 或第三方编辑节点。最小图应为：

```text
UNETLoader ──> LoraLoaderModelOnly(strength_model=1.0) ──> CFGGuider
CLIPLoader ──> CLIPTextEncode ──> ReferenceLatent ────────┘
LoadImage ──> ImageScaleToTotalPixels ──> VAEEncode ─────┘
EmptyFlux2LatentImage + Flux2Scheduler + RandomNoise + KSamplerSelect
  ──> SamplerCustomAdvanced ──> VAEDecode ──> SaveImage
```

多参考时，每张图走 `LoadImage → VAEEncode → ReferenceLatent`，把 `ReferenceLatent` 串起来即可。SNOFS 的 `LoraLoaderModelOnly` 只改 diffusion model，不接 text encoder。

依赖文件：

- LoKR：`ComfyUI/models/loras/klein_snofs_v1_4.safetensors`
- 9B UNET：Base 用 `flux-2-klein-base-9b-fp8.safetensors`；Distilled 用 `flux-2-klein-9b-fp8.safetensors`
- text encoder：`qwen_3_8b_fp8mixed.safetensors`
- VAE：当前官方 workflow template 使用 `full_encoder_small_decoder.safetensors`；ComfyUI 指南正文和作者样例仍写 `flux2-vae.safetensors`。两份官方材料有版本差异，首次 exact smoke 应优先照当前 raw workflow template，现有 `flux2-vae` 路径作为本地对照。

作者 showcase 中出现的 `FluxResolutionNode`、WAS `Image Save`、rgthree 尺寸节点只是便利节点，不是模型依赖。ComfyUI `v0.28.0` 已在 core 中实现 `LoKrAdapter`，能识别 `lokr_w1/lokr_w2`：[LoKrAdapter 源码](https://github.com/Comfy-Org/ComfyUI/blob/v0.28.0/comfy/weight_adapter/lokr.py)、[adapter registry](https://github.com/Comfy-Org/ComfyUI/blob/v0.28.0/comfy/weight_adapter/__init__.py)。

## 5. 当前 iDream / Mac MPS 适配状态

2026-07-24 对当前监听实例的只读核验：

- `http://127.0.0.1:8188/system_stats`：ComfyUI `0.28.0`、PyTorch `2.10.0`、`mps`、128 GiB unified memory、comfy-kitchen `0.2.22`
- `/object_info` 已有 `LoraLoaderModelOnly`、`ReferenceLatent`、`Flux2Scheduler`、`EmptyFlux2LatentImage`、`VAEEncode`
- LoRA 列表已经能看到 `klein_snofs_v1_4.safetensors`
- text encoder 已有 `qwen_3_8b_fp8mixed.safetensors`，VAE 已有 `flux2-vae.safetensors`
- UNET 列表中只有现有 Dark Beast Klein 候选，没有官方 `flux-2-klein[-base]-9b-fp8.safetensors`
- 现有 `darkBeastINT8Convrot2_dbkleinv2BFS.safetensors` 虽然文件名保留 `INT8Convrot`，实际文件头是 201 个普通 `F8_E4M3` tensor；它是从原模型通过 ComfyUI `ModelSave` 导出的 FP8 文件，不会走当前 MPS 不支持的 ConvRot `int_mm` 路径

因此：

1. **格式与节点兼容已成立。** 这是 BF16 LoKR，不是 INT8 ConvRot，不涉及 `aten::_int_mm` 的 MPS 阻断。
2. **内存容量合理。** BFL 列出的 9B Distilled / Base 推理显存约为 19.6 / 21.7 GB，当前 128 GiB unified memory 有容量余量。[BFL Klein 产品页](https://bfl.ai/models/flux-2-klein)
3. **精确 LoKR + 当前本地 Klein FP8 的 MPS 实图已通过。** 使用仓库 provider → registry → ComfyUI 完整链路，单参考 `ReferenceLatent`、832×1216、Euler、5 steps、CFG 1、seed `20260724` 成功输出 1,235,777-byte PNG，端到端 98.554 秒；像素 sanity 检查通过。
4. **做了同参数 LoKR 0/1 对照。** strength `0.0` 也成功输出 1,208,390-byte PNG。两张都保住参考人物的主要脸部身份；strength `1.0` 的皮肤和网料细节更锐，但手指、腋下和近景纹理伪影没有明显消失。两次耗时受模型驻留和执行顺序影响，不能当作 LoKR 速度结论。
5. 这次实图证明的是“目标 LoKR 能叠加在当前可运行的 Dark Beast Klein FP8 候选上并通过 iDream backend seam”，不是官方 Base/Distilled 底模质量结论。若要评估作者原始配方，仍需另装官方 9B Base/Distilled 后按相同样本复测。

## 6. 授权结论

生产接入目前有**两层独立授权门槛**：

1. **SNOFS 权重许可。** 作者发布的是 “Model Personal Use License (No Service, No Derivatives, No Redistribution) v1.1”。本地出图和出售已生成图片被允许，但未经另行书面商业许可，不得把模型能力放进网站、App、API、bot 或任何替第三方生成的服务，也不得合并、再训练或重分发权重。[作者 LICENSE](https://huggingface.co/Ashen3/SNOFS/blob/main/LICENSE)
2. **FLUX.2 Klein 9B 底模许可。** 9B 是 FLUX Non-Commercial License；商业主体可以在非生产环境做测试/评估，但本地商业生产需要 BFL 商业授权。[BFL 9B license](https://huggingface.co/black-forest-labs/FLUX.2-klein-9B/blob/main/LICENSE.md)、[BFL 官方许可说明](https://help.bfl.ai/articles/7108141705-can-i-run-or-fine-tune-flux-2-klein-locally)

Civitai API 同时返回 `allowDerivatives=false` 和一个不透明的 `allowCommercialUse="{RentCivit}"`；模型页又明确指向上述作者 LICENSE。应以作者链接的完整许可文本为准。对于 iDream：

- **可以**作为本机、非生产、无用户流量的研究候选进行固定样本 A/B。
- **不可以**在未取得 Ashen3 与 BFL 两方所需授权前进入面向用户的生成线路。
- “产出图片可以商用”不等于“可以把模型做成商业生成服务”。

## 7. iDream 候选接入建议

仓库已有 [`darkbeast-flux2-klein-9b-multi-reference.json`](../../packages/gen/workflows/darkbeast-flux2-klein-9b-multi-reference.json)，其 `VAEEncode → ReferenceLatent`、语义 image slot 和 `ComfyUIBackend` 绑定结构可以直接复用。SNOFS 无需改 backend；应新增独立 descriptor，而不是改现有 Qwen 或 Dark Beast：

- 独立 `modelId` / `workflowKey`，例如 `snofs-flux2-klein-9b-img2img-candidate`
- 本地 workflow / disabled / `0%` 流量，只允许显式 smoke
- `UNETLoader → LoraLoaderModelOnly → CFGGuider`
- 先跑官方 Distilled edit 配方；再用 Base 20/50 steps 做质量对照
- 固定 source、identity reference、prompt、seed、分辨率，与 `qwen-image-edit-multi-reference` 同条件比较
- 至少比较 LoKR `0.0 / 0.7 / 0.85 / 1.0`；`0.0` 用来证明 LoKR 确实生效
- 日志必须无 `lora key not loaded`；检查生成图像非黑、非空，并评估身份、意图、肢体、近景纹理
- 完成许可采购前不得提升为 production candidate

本地落地状态：

- 完整 LoKR 已安装到 `/Users/kk/ComfyUI-Shared/models/loras/klein_snofs_v1_4.safetensors`
- ComfyUI Workflows 中已保存 `iDream · SNOFS FLUX.2 Klein 9B v1.4 · Local Img2Img`
- 本地评估 descriptor 位于 gitignored 的 `.tmp/snofs-workflows/`，不会进入产品 registry
- strength `1.0` 与 `0.0` 的实图证据位于 gitignored 的 `.tmp/snofs-eval/`

最终判断：**技术接入与当前 Mac MPS 实图均已通过；产品上只值得做“成人概念覆盖候选”，不是 Qwen Image Edit 的替代者。授权未解决前应保持在本机隔离评测，不进入产品 registry 或用户流量。**
