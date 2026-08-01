# Mage-Flow-Edit Turbo：图像编辑、Apple MPS 与成人内容边界

日期：2026-07-31

范围：微软官方论文/源码/模型发布信息、ComfyUI 官方实现与工作流、当前 iDream 本机 ComfyUI 只读预检。

本轮先完成研究与预检，随后在同一天完成 ComfyUI BF16 权重下载、SHA-256 校验、普通编辑、三 seed 成人探针和当前 Qwen v19 对照。**没有修改 iDream 路由或默认模型。**

## 结论

用户点名的准确模型是 **`microsoft/Mage-Flow-Edit-Turbo` / `Mage-Flow-Edit-4B-Turbo`**：4B Native-Resolution MMDiT，使用 Mage-VAE 与 Qwen3-VL 条件编码，rectified-flow 训练，Turbo 版经 few-step distillation，推荐 **4 steps / CFG 1.0**。

它值得作为独立候选继续评估，本机首轮结果如下：

1. 微软官方代码和论文只给出 NVIDIA A100 数据；1024² 编辑为 1.02 秒、峰值约 18–20GB，**不是 Apple MPS 测速**。
2. ComfyUI 已有官方原生支持和官方 Turbo 工作流；当前本机 ComfyUI 0.29.0 的 **ComfyUI BF16** 路径已真实生成 800×992 输出，普通冷跑 15.223 秒，成人热跑中位数 9.792 秒。
3. 微软官方推理代码有不可关闭的内容分类器：成人裸体/性内容 prompt 或输入图会被拒绝并返回占位图。因此，**微软官方 pipeline 明确不支持成人内容直通**。
4. ComfyUI 原生节点直接执行权重，没有调用微软的 `screen_edit` 分类器；本机三个不同 seed 的裸体编辑均成功，没有拒绝、占位图或自动补衣。因此可以确认**这组固定权重在这条固定 ComfyUI/MPS 路径支持成人内容**。它仍不是成人专项 checkpoint，局部手势、皮肤质感和细节稳定性有明显缺点。
5. 2026-07-31 实查时，微软官方 Hugging Face 模型 URL 与 API 都返回 HTTP 401。Comfy-Org 的官方 ComfyUI 转换权重仍可访问，但应固定 revision 与 SHA-256，不能把微软页面曾经公开等同于今天仍可直接下载。
6. 同条件实际工作流对照中，MageFlow 普通冷跑比当前 Qwen v19 快约 7.22×，成人热跑快约 8.78×；Qwen 的身份与身体比例保持更忠实。当前结论是独立 opt-in 候选，不替换 Qwen 默认路由。

## 1. 精确身份与架构

| 项 | 事实 | 一手来源 |
| --- | --- | --- |
| 模型 | `Mage-Flow-Edit-4B-Turbo`，instruction-based image editing，few-step distilled | [微软模型族表](https://github.com/microsoft/Mage/blob/8c94a0ac905167f40b05b09332b78752b7f9fbef/mage_flow/README.md#-model-zoo) |
| Backbone | 4B Native-Resolution Multimodal Diffusion Transformer（NR-MMDiT），rectified flow matching | [论文](https://arxiv.org/abs/2607.19064)；[官方架构说明](https://github.com/microsoft/Mage/blob/8c94a0ac905167f40b05b09332b78752b7f9fbef/mage_flow/README.md#-architecture) |
| 图像 tokenizer | Mage-VAE，128-channel latent，16× 下采样 | [官方架构说明](https://github.com/microsoft/Mage/blob/8c94a0ac905167f40b05b09332b78752b7f9fbef/mage_flow/README.md#-architecture) |
| 条件编码 | Qwen3-VL；编辑输入同时包含 instruction 与 source-image latents | [论文](https://arxiv.org/abs/2607.19064)；[官方源码](https://github.com/microsoft/Mage/blob/8c94a0ac905167f40b05b09332b78752b7f9fbef/mage_flow/pipeline.py) |
| 能力范围 | 单图与多图 reference；语义/外观/修复/结构类编辑 | [官方 README](https://github.com/microsoft/Mage/blob/8c94a0ac905167f40b05b09332b78752b7f9fbef/mage_flow/README.md) |
| 发布版本 | 微软源码固定为 `8c94a0ac905167f40b05b09332b78752b7f9fbef`；本轮未发现正式 tag/release | [固定 commit](https://github.com/microsoft/Mage/tree/8c94a0ac905167f40b05b09332b78752b7f9fbef) |

官方训练/展示分辨率范围是每边 512–2048，宽高为 16 的倍数，可覆盖 4:1 极端比例。编辑默认根据第一张 reference 的比例决定输出；VL 条件图长边默认缩到 384。[官方参数表](https://github.com/microsoft/Mage/blob/8c94a0ac905167f40b05b09332b78752b7f9fbef/mage_flow/README.md#python-api)

## 2. 权重、格式与许可证

微软原发布是 self-contained、diffusers-style 目录：`transformer/`、`text_encoder/`、`vae/`、`scheduler/`，主权重为 BF16 Safetensors。[官方 README](https://github.com/microsoft/Mage/blob/8c94a0ac905167f40b05b09332b78752b7f9fbef/mage_flow/README.md#-model-zoo)

原微软仓库公开时的文件页记录总量约 **17.5GB**，其中 DiT 约 8.23GB、Qwen3-VL 约 8.89GB，其余主要是约 0.345GB Mage-VAE。当前微软模型页返回 401，所以下表采用仍可访问的 **Comfy-Org 官方 ComfyUI 单文件转换**；这些是转换/拆分发布，不是微软原仓库可用性的替代证明。

固定 Comfy-Org revision：`d8c99241f6fa80fbd453014234af2bf337ea21e6`。

| 文件 | 字节 | 用途 | LFS SHA-256 |
| --- | ---: | --- | --- |
| `mage_flow_edit_turbo_bf16.safetensors` | 8,231,536,760 | Turbo Edit DiT，Apple MPS 首选 | `29c3726ecd64afe149eef28af3e27b6b40de52646bfd16757a37da4b6fbcf288` |
| `mage_flow_edit_turbo_int8_convrot.safetensors` | 4,159,146,840 | INT8 ConvRot DiT；不作为本机 MPS 首选 | `345dd8a3376306624912dc46e1db18a6457d692053afe21c9822ed6719f79937` |
| `qwen3vl_4b_bf16.safetensors` | 8,875,719,384 | text / vision encoder | `36f3ff447ef59201722e8f9ce6020c9819fdcfba6aa2608c4e09b1c0ce114e34` |
| `mage_flow_vae_bf16.safetensors` | 345,053,056 | Mage-VAE | `34e076dc1e8a15321e1e07be5111d59cf16dd10b804b7c7e20b4de29013427e0` |

文件元数据：[Comfy-Org/Mage-Flow 固定 revision](https://huggingface.co/Comfy-Org/Mage-Flow/tree/d8c99241f6fa80fbd453014234af2bf337ea21e6)。BF16 三件套合计约 **17.45GB / 16.25GiB**；磁盘大小不是运行峰值。

代码与发布 metadata 均为 **MIT**：[微软 LICENSE](https://github.com/microsoft/Mage/blob/8c94a0ac905167f40b05b09332b78752b7f9fbef/LICENSE)；[Comfy-Org 模型页](https://huggingface.co/Comfy-Org/Mage-Flow)。许可证只回答使用授权，不回答成人能力或生产质量。

## 3. 推理路径与推荐参数

### 微软官方 Python / CLI

官方可复现依赖固定为 Python 3.10+、PyTorch 2.13、Transformers 5.5、Diffusers 0.38、Accelerate 1.13、Safetensors 0.8，并要求单独编译 `flash-attn==2.8.3`；文档与默认设备都是 CUDA。[官方 requirements](https://github.com/microsoft/Mage/blob/8c94a0ac905167f40b05b09332b78752b7f9fbef/mage_flow/requirements.txt)；[安装说明](https://github.com/microsoft/Mage/blob/8c94a0ac905167f40b05b09332b78752b7f9fbef/mage_flow/README.md#installation)

Turbo 推荐参数：

```text
steps = 4
cfg = 1.0
static_shift = 6.0
vl_cond_long_edge = 384
output = reference aspect ratio, 512–2048 per side, multiple of 16
```

来源：[官方 Python API 参数表](https://github.com/microsoft/Mage/blob/8c94a0ac905167f40b05b09332b78752b7f9fbef/mage_flow/README.md#python-api)。

“diffusers-style”不等于 vanilla Diffusers 已内置：微软官方入口是仓库自带的 `mage_flow.MageFlowPipeline`；截至本轮检查，Hugging Face Diffusers main 源码树没有 Mage-Flow pipeline。模型卡自动生成的 `DiffusionPipeline.from_pretrained(...)` 示例不能替代真实导入验证。

### ComfyUI 官方路径

ComfyUI 在 [PR #15026 / commit `45ffd543`](https://github.com/Comfy-Org/ComfyUI/commit/45ffd5430beeccf63682b5f8b569faad45fd60e1) 加入原生 Mage-Flow 支持，包括：

- `MageFlowTransformer2DModel` 与 Mage-VAE；
- Qwen3-VL-4B 的 Mage 模板；
- `TextEncodeMageFlowEdit` 单/多参考图节点；
- 原生 BF16/FP32 推理类型；
- 官方 Turbo workflow：4 steps、CFG 1、`euler` sampler、`simple` scheduler。

来源：[ComfyUI 当前实现](https://github.com/Comfy-Org/ComfyUI/tree/a1c421994cdcc5044dbce2bb7628e89386311cc5/comfy/ldm/mage_flow)；[编辑节点](https://github.com/Comfy-Org/ComfyUI/blob/a1c421994cdcc5044dbce2bb7628e89386311cc5/comfy_extras/nodes_mage.py)；[官方 Turbo workflow](https://github.com/Comfy-Org/workflow_templates/blob/1b3bdd46c945d54d893a3b43692d5963608fb7d4/templates/image_mage_flow_edit_turbo_int8.json)。

## 4. Apple Silicon / MPS 判断

### 上游声明

- 微软论文的 1.02 秒和 18–20GB 是单张 NVIDIA A100，不可迁移为 Mac 性能结论。[论文](https://arxiv.org/abs/2607.19064)
- 微软 README 只给 CUDA + FlashAttention 安装路径；官方代码虽已有 SDPA fallback，但默认 loader 仍以 `flash2` 初始化，未给出 MPS 命令、峰值或成图证据。[官方安装说明](https://github.com/microsoft/Mage/blob/8c94a0ac905167f40b05b09332b78752b7f9fbef/mage_flow/README.md#installation)；[attention backend](https://github.com/microsoft/Mage/blob/8c94a0ac905167f40b05b09332b78752b7f9fbef/mage_flow/models/modules/_attn_backend.py)
- ComfyUI 的实现使用其跨设备 attention / model-management 路径，并显式支持 BF16/FP32，因此是当前 Apple MPS 的最短可测路径。[ComfyUI Mage model config](https://github.com/Comfy-Org/ComfyUI/blob/a1c421994cdcc5044dbce2bb7628e89386311cc5/comfy/supported_models.py)

### 当前本机预检（2026-07-31）

| 项 | 结果 |
| --- | --- |
| iDream ComfyUI | `0.29.0`，core commit `e651b7bef55a5376343dcb1c0edb79f0142c985e` |
| PyTorch / device | `2.10.0` / `mps`，M4 Max 128GiB unified memory |
| Mage node | `/object_info/TextEncodeMageFlowEdit` 存在 |
| 已有组件 | `qwen3vl_4b_bf16.safetensors` 已在 CLIPLoader 列表 |
| 新增组件 | Turbo Edit DiT 与 Mage-VAE 已下载、SHA-256 通过并进入 loader 列表 |
| INT8 算子 | 同一 venv 运行 `torch._int_mm` on MPS，得到 `NotImplementedError: aten::_int_mm ... not currently implemented for the MPS device` |

本机最终按该判断下载 **BF16 DiT + BF16 VAE** 并复用已有 Qwen3-VL；真实输出证明 BF16 MPS 路径可用。INT8 ConvRot 仍未作为本机候选。

## 5. 成人内容 / NSFW 能力边界

### 微软官方 pipeline：明确拦截

当前微软官方源码在每次 edit 前强制调用 `model.txt_enc.screen_edit(prompt, refs)`，且注释标为 `MANDATORY`；没有 opt-out。分类器把下列情况归为 `sexual` 并阻断：裸体、性行为、暴露私密部位、内衣/透视湿衣、淋浴/沐浴、卧室亲密等；输入 reference 已含成人内容时，即便指令无害也会拦截。拒绝结果是 placeholder image，不进入真正采样。

一手证据：[官方 edit gate](https://github.com/microsoft/Mage/blob/8c94a0ac905167f40b05b09332b78752b7f9fbef/mage_flow/pipeline.py#L450-L492)；[官方分类规则](https://github.com/microsoft/Mage/blob/8c94a0ac905167f40b05b09332b78752b7f9fbef/mage_flow/models/modules/mage_text.py)。

因此，“微软官方本地 pipeline 是否支持 NSFW”答案是：**不支持直通。**

### ComfyUI raw-weight route：无该 gate，固定路径已实测可生成成人内容

ComfyUI 的 `TextEncodeMageFlowEdit` 只做 reference resize、VAE encode、Qwen3-VL prompt encode 与 conditioning 组装，没有调用微软的 `screen_edit`。[官方 ComfyUI 节点源码](https://github.com/Comfy-Org/ComfyUI/blob/a1c421994cdcc5044dbce2bb7628e89386311cc5/comfy_extras/nodes_mage.py)

预检只能确认 ComfyUI 不执行微软分类器；同日完成的真实输出进一步确认：

- 三个不同 seed 都能把同一成年角色的泳衣移除为完整裸体，没有自动补衣、拒绝或占位图；
- 脸、身体、构图和背景大体保持，但原本拉泳衣带的右手在三张图中都变成“捏空气”，皮肤偏磨皮，胸部细节略不稳定；
- 当前只验证了单 reference；多 reference 和多轮编辑仍未验证；
- 相比当前 `Qwen-Rapid-AIO-NSFW-v19`，MageFlow 明显更快，Qwen 的身份与原始身体比例更忠实。

微软官方论文、README 与 benchmark 没有成人专项数据，也没有 `uncensored` / `NSFW` checkpoint。故准确结论是：**它不是成人专项模型，但固定 BF16 权重在本机 ComfyUI/MPS raw-weight 路径已实测支持成人内容。**

## 6. 本地验证结果

验证环境：Mac16,6 / Apple M4 Max / 128GiB，ComfyUI 0.29.0，PyTorch 2.10.0，MPS。固定 recipe：同一 `800×999` source，输出 `800×992`，4 steps，CFG 1，seed 4242–4244。MageFlow 使用官方推荐 `euler/simple`；Qwen 保留当前 `sa_solver/beta`，因此这是实际工作流比较，不是纯 kernel 比较。

| 模型 | 场景 | Seed | Comfy history 用时 | 结果 |
| --- | --- | ---: | ---: | --- |
| MageFlow BF16 | 普通雪山湖背景编辑，冷跑 | 4242 | 15.223s | 成功，指令遵循好，轻微身份/体型重绘 |
| MageFlow BF16 | 成人裸体编辑 | 4242 | 11.210s | 成功 |
| MageFlow BF16 | 成人裸体编辑 | 4243 | 8.746s | 成功 |
| MageFlow BF16 | 成人裸体编辑 | 4244 | 9.792s | 成功 |
| Qwen v19 FP8→BF16 | 同普通编辑，模型切换冷跑 | 4242 | 109.887s | 成功，身份保持更忠实 |
| Qwen v19 FP8→BF16 | 同成人编辑，热跑 | 4242 | 98.366s | 成功 |

每次成人复跑都更换 seed；Comfy history 已记录缓存节点、起止时间和输出 PNG。Comfy 日志报告 MageFlow 加载组件合计约 16.58GB，Qwen 合计约 27.11GB；这不是操作系统峰值 RSS，未将其写成峰值内存。完整 prompt、seed、SHA、history id 和输出见 `output/mage-flow-edit-turbo-eval-2026-07-31/`。

## 最终判定

| 问题 | 当前答案 |
| --- | --- |
| 是图生图/编辑模型吗 | 是，准确说是 instruction-based image editing，支持单/多 reference |
| 值得试吗 | 值得；4B / 4-step，理论上比 20B Qwen 更轻，但 Mac 速度和角色质量未知 |
| 官方 Diffusers 能直接跑吗 | 不是 vanilla Diffusers 内置 pipeline；官方真实入口依赖 `mage_flow` 自带实现 |
| ComfyUI 支持吗 | 支持，且本机 0.29.0 已有原生节点 |
| Apple MPS 支持吗 | BF16 ComfyUI 路径已真实成图；INT8 ConvRot 当前本机算子不支持 |
| 支持 NSFW 吗 | 微软官方 pipeline 会强制拦截；固定 BF16 权重在 ComfyUI raw route 上 3/3 成人探针成功 |
| 现在能否替换 Qwen | 不能；速度显著领先，但身份保持和局部编辑质量还不足以替换，先做独立 opt-in 候选 |
