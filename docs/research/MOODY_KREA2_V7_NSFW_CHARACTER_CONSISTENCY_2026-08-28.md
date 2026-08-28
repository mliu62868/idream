# Moody Krea 2 Mix V7：NSFW 与人物保持能力核验

日期：2026-08-28  
目标版本：[Moody Krea 2 Mix (uncensored) V7.0](https://civitai.red/models/2731187/moody-krea-2-mix-uncensored?modelVersionId=3209007)（`modelVersionId=3209007`）

## 结论

**它支持 NSFW 文生图；但仅加载这个 V7 checkpoint，并不等于支持跨图人物身份保持。**

如果“人物保持”是指同一个角色在不同姿势、服装、场景和 seed 下仍保持同一张脸，当前一手证据支持的可靠路线是：

> Moody Krea 2 Mix V7 + 为 Krea 2 训练的角色 LoRA + 固定角色触发词与生成配方。

这条路线可以同时做 NSFW，但人物一致性来自**角色 LoRA**，不是 V7 checkpoint 自带的单图身份锁定能力。Krea 官方也明确说明：不使用 LoRA 时，角色在多张图中会发生脸型和比例漂移；长期一致性应先训练角色 LoRA，并在每张图中使用它。[Krea 官方角色一致性说明](https://www.krea.ai/blog/from-sketch-to-anime-panel-with-krea-2#frequently-asked-questions)

## 精确版本事实

- Civitai 精确版本是 `3209007 / V7.0`，基础模型标记为 `Krea 2`，文件均为完整 `Diffusion Model` SafeTensor，而不是人物适配器：
  - NVFP4：约 8.20 GiB，SHA-256 `A06425056C2A5FEE5267EB58A23D75B00FFAA2DF1A6D8CDD328FF45473EE14AB`
  - FP8：约 13.16 GiB，SHA-256 `405DB6A1D060075D176C3578063B6FA2FEB07B58BB61DDB403DDBA0669A35A6D`
  - INT8：约 13.16 GiB，SHA-256 `1EF6C1F750D70909732B830C4AED4E98FC4FAC909229D77570A0748C2E89BF6F`
- 作者对 V7 的原话是其 “NSFW influence is relatively strong”；页面样图元数据也包含明确 NSFW prompt。因此，**NSFW 出图能力有作者声明和样图工作流证据**。[模型页作者说明](https://civitai.red/models/2731187/moody-krea-2-mix-uncensored?modelVersionId=3209007) · [精确版本 API](https://civitai.red/api/v1/model-versions/3209007)
- 可解析的作者样图工作流以 `EmptyLatentImage` 开始，经 `UNETLoader`、`KSamplerAdvanced`、`VAEDecode`、细节修复与放大后保存；没有 `LoadImage`、IP-Adapter、PuLID、InstantID 或身份参考节点。
- 同一作者工作流确实加载了 Krea 2 LoRA，包括 NSFW LoRA `MysticXXX_KREA2_v3.safetensors`，以及角色 LoRA `Nari-k2-v1.safetensors`、`aiyo-k2-v2.safetensors`。这证明 **V7 可以参与“NSFW LoRA + 角色 LoRA”的组合工作流**；它不能证明不使用角色 LoRA 时也会稳定保持身份。[精确版本 API 中的样图 ComfyUI 元数据](https://civitai.red/api/v1/model-versions/3209007)

## 能力边界

| 需求 | 判断 | 证据边界 |
|---|---|---|
| NSFW 文生图 | **支持** | V7 作者明确称 NSFW 影响较强；样图含 NSFW prompt |
| 同一 prompt / 相近 seed 下得到相似人物 | **可能，但不构成人物保持** | 模型审美偏置和 seed 可提高相似感，不能抵抗换场景、换姿势后的身份漂移 |
| 跨多张图保持同一角色 | **checkpoint 单独不支持；角色 LoRA 路线支持** | Krea 官方明确说无 LoRA 会发生脸和比例漂移 |
| 用一张人物参考图零训练锁脸 | **没有原生证据** | 精确 V7 作者工作流无图像参考 / 身份节点；开放 Krea 2 官方推理是 text-to-image |
| 单张图像编辑 | **不是该 checkpoint 的原生任务** | Krea 官方把开放 Krea 2 定义为文生图；托管产品的 Edit 是独立工具 |
| 单图 / 多图 style reference | **Krea 2 生态支持，但不是身份参考** | 官方定义为风格、氛围、视觉方向控制，并刻意减少内容泄漏 |

Krea 2 是从零训练的独立模型，不是 FLUX.1 Krea [dev]。开放版官方仓库和 Diffusers 管线都把它定义为 text-to-image；官方 `inference.py` 只接收 prompt、尺寸、seed 和采样参数，没有 source image 输入。[Krea 2 官方仓库](https://github.com/krea-ai/krea-2) · [官方推理入口](https://github.com/krea-ai/krea-2/blob/main/inference.py) · [Diffusers Krea2Pipeline](https://github.com/huggingface/diffusers/blob/main/src/diffusers/pipelines/krea2/pipeline_krea2.py)

Krea 托管产品和 ComfyUI 另有 style-reference 系统，但官方用途是把一张或多张参考图的**风格、氛围和视觉方向**注入输出，而不是保留参考人物的脸。ComfyUI 官方工作流还明确要求专用 diffusion model 与 `krea2_style_reference.safetensors`；不能把这项能力默认算到 Moody V7 文件本身，更不能把 style reference 当作 identity reference。[Krea 2 技术报告](https://www.krea.ai/blog/krea-2-technical-report#style-reference-system) · [ComfyUI 官方 Krea 2 workflow](https://docs.comfy.org/tutorials/image/krea/krea-2)

## LoRA、IP-Adapter、PuLID、InstantID 兼容性

### LoRA：支持，且是官方人物保持路线

Krea 官方建议在 Raw 上训练 LoRA、在 Turbo 上推理；角色 LoRA 可用于 recurring face / character identity，并能与其他 LoRA 叠加。官方托管训练至少需要三张同一角色 / 风格 / 物体的图片；角色数据应覆盖不同角度、表情、光线和背景。[Krea 2 官方仓库](https://github.com/krea-ai/krea-2#finetuning-krea-2) · [Krea 2 LoRA 官方说明](https://www.krea.ai/blog/krea-2-lora-training)

对 Moody V7 的结论更窄：作者样图证明 Krea 2 角色 LoRA 能被其工作流加载，但具体角色 LoRA 与该 merge 的一致性、NSFW 姿势服从和画质仍需真实 A/B，不能从“节点能加载”推导为所有角色 LoRA 都稳定。

### IP-Adapter：现成权重不应视为兼容

IP-Adapter 官方 / 参考实现公开的权重面向 SD1.5、SDXL 和 Kolors；其可迁移范围是同一基础模型家族的 finetune。Krea 2 是从零训练的不同 DiT 架构，未见 Krea 2 专用 IP-Adapter 权重或官方工作流，因此不能直接套用现成 SD / SDXL IP-Adapter。[IP-Adapter 官方仓库](https://github.com/tencent-ailab/IP-Adapter) · [ComfyUI IP-Adapter 参考实现的权重清单](https://github.com/cubiq/ComfyUI_IPAdapter_plus#installation)

### PuLID：现成权重不应视为兼容

PuLID 官方 Model Zoo 只列 SDXL 与 FLUX 权重，没有 Krea 2。FLUX.1 Krea [dev] 即使有 FLUX 路线，也不是从零训练的 Krea 2，因此不能据此宣称 Moody Krea 2 V7 兼容 PuLID。[PuLID 官方 Model Zoo](https://github.com/ToTheBeginning/PuLID#european_castle-model-zoo)

### InstantID：现成权重不应视为兼容

InstantID 官方发布的是 SDXL 管线、ControlNet 与 IP-Adapter 权重，后来另有 Kolors 适配；未见 Krea 2 官方权重或管线。不能把 SDXL InstantID 节点直接接到 Moody Krea 2 V7 并期待身份保持。[InstantID 官方仓库](https://github.com/instantX-research/InstantID)

### Krea 2 专用 identity-reference LoRA：基础设施存在，但需专用权重

ComfyUI 已合并 Krea 2 reference-latent 支持，PR 明确面向 Ostris 和 identity-edit reference LoRA。这说明 Krea 2 可以通过**专门训练的 Krea 2 reference / identity LoRA**扩展身份参考能力；它仍不等于兼容 IP-Adapter、PuLID 或 InstantID，也不等于 Moody V7 自带该能力。[ComfyUI Krea 2 reference-latent PR #14843](https://github.com/Comfy-Org/ComfyUI/pull/14843)

## 实用判断

- 已有一组角色训练图：**可选 Moody V7 做 NSFW 底模，配 Krea 2 角色 LoRA**；这是当前证据最完整的路线。
- 只有一张角色参考图、又要求换姿势 / 换场景仍锁脸：**不要把 Moody V7 单独当作 one-shot identity model**。需要 Krea 2 专用 identity-reference LoRA，或改用明确支持单图身份编辑的模型路线。
- 只要求同一审美、发型、体型和大致脸感：prompt + 固定 seed 可以辅助，但这不应进入“人物身份保持已通过”的质量结论。

## 验证状态

本记录核验了精确 Civitai 版本元数据、作者说明、作者样图 ComfyUI workflow、Krea / ComfyUI / 各适配器官方资料；本轮没有下载 8–13 GiB 权重，也没有执行本地多 seed、多场景身份 A/B。因此结论是**能力与兼容性边界核验**，不是对该 V7 人物相似度的实测评分。
