# RedCraft Krea2 RedMix2 INT8 ConvRot 更新与替换评估

日期：2026-07-16  
目标：Civitai model `958009` / version `3086841`  
当前基线：Civitai version `3066243` 的 RedCraft Krea2 RedMix 1.1 FP8，以及由它正确反量化得到、当前 M4 Max / MPS 工作流使用的 BF16 文件

## 结论

**它确实是相对我们当前模型的更新，但现在没有必要直接替换。正确动作是：把它作为新的 RedMix2 CUDA 候选测试；Mac 继续使用现有 RedMix 1.1 BF16，直到拿到或制作出经过验证的 RedMix2 BF16。**

- 目标版本 `3086841` 于 **2026-07-01** 发布，作者称其为 **Krea2-RED-Mix2 / RedMix2.1、8 steps**；我们当前源文件对应 `3066243`，于 **2026-06-24** 发布，作者称 **Krea2-RED-Mix 1.1、10 steps**。两者文件 SHA-256 不同，目标并非旧文件改名。
- 更新同时改变了两件事：**内容权重从 RedMix 1.1 变为 RedMix2/2.1**，运行格式从我们当前源文件的 **scaled FP8** 变为 **INT8 ConvRot**。因此不能把输出变化只归因于量化，也不能无评测覆盖原模型。
- 目标版本当前只暴露一个 13.16 GiB 的 INT8 SafeTensor；模型页总标题虽然写有 `INT8/INT4`，但 `3086841` 没有单独的 INT4 文件。不要因为页标题而把这个下载物当成 INT4。
- **Apple M4 Max / MPS：不应直接替换。** ComfyUI 能识别原生 INT8 ConvRot，不代表 MPS 能原生计算它。ComfyUI / comfy-kitchen 的快速路径以 CUDA capability 为条件，非 CUDA eager 路径最终调用 `torch._int_mm`；PyTorch 官方源码仍没有该算子的 MPS dispatch，官方测试也明确把 `_int_mm` 标为 MPS 失败项。
- **NVIDIA CUDA：值得另立候选。** ComfyUI v0.27.0 已原生支持 INT8 ConvRot，工程图与当前工作流同构；但作者没有给出这个 RedCraft checkpoint 的可复现速度、显存或同 seed 质量 benchmark。“2 倍速”不能直接当作我们的验收结果。

## 一、目标版本到底更新了什么

### 1. 版本与文件事实

| 项目 | 当前源版本 | 目标版本 |
| --- | --- | --- |
| Civitai version | `3066243` | `3086841` |
| 版本名 | 赤佬1.1 INT8 & INT4 | 赤佬2 (Krea2)Edition |
| 作者描述 | Krea2-RED-Mix；Raw + Turbo merged | Krea2-RED-Mix2；样例 metadata 称 RedMix2.1 |
| 发布时间 | 2026-06-24 21:57 UTC | 2026-07-01 13:55 UTC |
| Base model | Krea 2 | Krea 2 |
| 推荐采样 | ER_SDE / Euler、Simple、CFG 1、10 steps | ER_SDE / Euler、Simple、CFG 1、8 steps |
| 我们使用的源格式 / 目标格式 | scaled FP8 SafeTensor | INT8 ConvRot SafeTensor |
| 文件大小 | 12,833,772.890625 KiB，约 12.24 GiB | 13,801,011.46875 KiB，约 13.16 GiB |
| SHA-256 | `92E8D4EECBF4F89B30140DC231E377118823BE3A30C5C04342BCF394FE27E73B` | `C7C8D0EED618F7B971629B0AA7B115D4536C8BEE14E3AFB6D928B0A9DC14F804` |

来源：[目标版本 API](https://civitai.com/api/v1/model-versions/3086841)、[旧版本 API](https://civitai.com/api/v1/model-versions/3066243)、[模型全部版本 API](https://civitai.com/api/v1/models/958009)、[用户给出的目标页面](https://civitai.red/models/958009/redcraft-or-2-or-2-int8int4-convrot-2?modelVersionId=3086841)。

目标版本 API 当前还返回 `updatedAt=2026-07-15T02:29:30.202Z`。这只能证明 Civitai 版本记录在 7 月 15 日更新过，**不能证明 checkpoint 二进制在该日被重新上传**；当前文件 ID `2968503` 和 SHA-256 才是应锁定的供应链身份。

### 2. 本地旧模型身份已确认

本轮对本地源文件的校验结果：

```text
redcraftKREA2RedMix_krea2Edition.safetensors
size   = 13,141,783,440 bytes
sha256 = 92e8d4eecbf4f89b30140dc231e377118823be3a30c5c04342bcf394fe27e73b
```

它与 Civitai `3066243` 的 FP8 文件完全一致。当前 [`redcraft-krea2-txt2img.json`](../../packages/gen/workflows/redcraft-krea2-txt2img.json) 加载的是其 BF16 反量化产物 `redcraftKREA2RedMix_krea2Edition-bf16.safetensors`，默认仍为 10 steps；反量化过程及 MPS 闭环记录在 [`2026-07-07-image-generation-redesign-design.md`](../superpowers/specs/2026-07-07-image-generation-redesign-design.md)。

因此，问题不是“我们是否已在使用目标文件”：**没有。我们当前是 RedMix 1.1 FP8 的 BF16 派生物；目标是另一组 RedMix2/2.1 INT8 ConvRot 权重。**

### 3. 作者样例能证明什么、不能证明什么

目标 API 的 10 张作者样例都带有 ComfyUI workflow metadata，核心图一致：

1. `UNETLoader`：`Krea2RedMix2.1-8Steps-fp8-scaled-ComfyUI.safetensors`；
2. `CLIPLoader`：`qwen3vl_4b_bf16.safetensors`，type=`krea2`；
3. `VAELoader`：`qwen_image_vae.safetensors`；
4. `KSampler`：8 steps、CFG 1、Simple，主要使用 Euler，部分使用 ER_SDE / Euler ancestral；
5. `ConditioningZeroOut` 生成 negative conditioning。

这能支持以下判断：

- 内容版本确实属于 **RedMix2.1 / 8-step** 路线；
- 目标继续复用我们已有的 Qwen3-VL 4B BF16 text encoder 和 Qwen Image VAE；
- 当前 `UNETLoader` split workflow 结构可复用，CUDA 候选接入成本低。

但这些图片实际记录的 UNet 是作者的 **FP8 RedMix2.1 源文件**，不是 Civitai 下载物 `redcraft22INT8INT4_2Krea2Edition.safetensors`。因此它们**不是目标 INT8 文件的直接运行证明，也不提供 INT8 速度证明**。目标版本 API 没有公开耗时、GPU、PyTorch/CUDA 版本、峰值显存或同 seed BF16/FP8 对照。

来源：[目标版本 API 的 `images[].meta.comfy`](https://civitai.com/api/v1/model-versions/3086841)、[Comfy-Org Krea 2 文件布局](https://huggingface.co/Comfy-Org/Krea-2)。

## 二、格式、依赖与兼容硬件

### 1. 目标实际格式

Civitai 对 `3086841` 唯一文件的登记为：

```text
name:     redcraft22INT8INT4_2Krea2Edition.safetensors
type:     Diffusion Model
format:   SafeTensor
fp:       int8
size:     13.16 GiB
sha256:   C7C8D0...14F804
```

模型总标题里的 `INT8/INT4` 是集合级命名；目标版本只有这一份 `fp=int8` 文件，没有 Q4 GGUF、NF4 或 ConvRot INT4 附件。ComfyUI v0.28.0 新增的 ConvRot INT4 支持不会把该 INT8 文件变成 INT4。

来源：[目标版本 API](https://civitai.com/api/v1/model-versions/3086841)、[ComfyUI v0.28.0 release](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.28.0)。

### 2. 运行依赖

最低合理组合：

- ComfyUI **v0.27.0 或更新**：v0.27.0 release 明确以 “added support for int8 convrot models” 为主要变化，并合入原生 INT8 PR；
- ComfyUI v0.27.0 固定的 `comfy-kitchen==0.2.16`；
- `qwen3vl_4b_bf16.safetensors` 放在 `models/text_encoders/`；
- `qwen_image_vae.safetensors` 放在 `models/vae/`；
- 目标 diffusion 文件放在 `models/diffusion_models/`；
- 使用原生 `UNETLoader`，`weight_dtype=default`，不需要为了加载该原生格式安装旧版第三方 INT8 loader。

来源：[ComfyUI v0.27.0 release](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.27.0)、[原生 INT8 PR #14636](https://github.com/Comfy-Org/ComfyUI/pull/14636)、[v0.27.0 requirements.txt](https://github.com/Comfy-Org/ComfyUI/blob/v0.27.0/requirements.txt)、[Comfy-Org Krea 2 model card](https://huggingface.co/Comfy-Org/Krea-2)。

### 3. NVIDIA CUDA

`comfy-kitchen` 的 `TensorWiseINT8Layout` 明确说明：

- 快速矩阵乘使用 `torch._int_mm` / cuBLASLt IMMA；
- 最低 CUDA compute capability 是 **SM 7.5（Turing）**；
- `supports_fast_matmul()` 在没有 CUDA capability 时直接返回 `false`。

ComfyUI v0.27.0 的量化入口在没有 CUDA 时禁用 comfy-kitchen CUDA backend；其官方 pinned 版本的快速 INT8 路线因此面向 NVIDIA CUDA。v0.27.0 还专门合入了 Turing 支持，v0.28.0 又补充了 Turing INT8/INT4 优化。

对官方 v0.27.0 CUDA backend，源码还要求 PyTorch CUDA **13.0+** 才不禁用内建 CUDA backend；`comfy-kitchen` README 对预编译 CUDA wheel 列出的要求是 CUDA Runtime 13.0+、NVIDIA driver r580+。如果改走 Triton，必须按实际 ComfyUI/PyTorch/驱动组合单独验证，不能把 CUDA wheel 条件与 Triton 条件混为一谈。

来源：[comfy-kitchen v0.2.16 INT8 layout](https://github.com/Comfy-Org/comfy-kitchen/blob/v0.2.16/comfy_kitchen/tensor/int8.py)、[ComfyUI v0.27.0 quant_ops.py](https://github.com/Comfy-Org/ComfyUI/blob/v0.27.0/comfy/quant_ops.py)、[ComfyUI v0.27.0 release](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.27.0)、[comfy-kitchen v0.2.16 README](https://github.com/Comfy-Org/comfy-kitchen/blob/v0.2.16/README.md)。

### 4. Apple M4 Max / MPS

**当前仍不能把原生 INT8 ConvRot 当作 MPS 可用生产格式。**

官方代码链是确定的：

1. ComfyUI 无 CUDA 时禁用 comfy-kitchen CUDA backend；
2. comfy-kitchen v0.2.16 的非 CUDA INT8 eager 实现最终调用 `torch._int_mm`；
3. PyTorch `native_functions.yaml` 只为 `_int_mm` 注册 CPU、CUDA、XPU，没有 MPS；
4. PyTorch 官方测试表仍写明 `aten::_int_mm is not implemented for MPS backend`，并将该测试列为 MPS failure。

来源：[ComfyUI v0.27.0 quant_ops.py](https://github.com/Comfy-Org/ComfyUI/blob/v0.27.0/comfy/quant_ops.py)、[comfy-kitchen v0.2.16 eager INT8 implementation](https://github.com/Comfy-Org/comfy-kitchen/blob/v0.2.16/comfy_kitchen/backends/eager/quantization.py)、[PyTorch `_int_mm` dispatch 定义](https://github.com/pytorch/pytorch/blob/main/aten/src/ATen/native/native_functions.yaml)、[PyTorch MPS test failures](https://github.com/pytorch/pytorch/blob/main/test/inductor/test_aot_inductor.py)、[PyTorch MPS operator coverage tracker](https://github.com/pytorch/pytorch/issues/141287)。

本轮本机核验与上述源码一致：

- 活动 8188 runtime：ComfyUI `0.27.0`、comfy-kitchen `0.2.16`、PyTorch `2.10`、device=`mps`；
- 源码 checkout 已更新到 `v0.28.0-4`，但活动 listener 仍是上述 runtime；
- 真实 MPS `_int_mm` probe 仍抛 `NotImplementedError: aten::_int_mm`。

ComfyUI v0.28.0 新增的是 ConvRot INT4、AMD/ROCm Triton 与 Turing 优化，release notes 没有 MPS INT8 kernel；同时 PyTorch 当前主线源码依旧没有 `_int_mm` MPS dispatch。因此**升级 ComfyUI 本身不能解除这个阻塞**。

`PYTORCH_ENABLE_MPS_FALLBACK=1` 即便让某些缺失算子回退到 CPU，也不是 MPS INT8 加速，并且当前真实链路没有因此形成可用闭环。不能以 CPU fallback 的“可能可执行”替代原生 MPS 性能与稳定性验收。

## 三、性能与质量：现有证据能支持到哪里

### 1. “2 倍速”不是目标 checkpoint 的已验证结果

作者把“2倍速”写入模型集合标题，但目标版本没有提供受控 benchmark。与目标最接近的一手实现 benchmark 来自 INT8-Fast 作者，但测的是其他模型：

| GPU / 模型 | FP8 | INT8 ConvRot | INT8 ConvRot + compile | 可支持的判断 |
| --- | ---: | ---: | ---: | --- |
| RTX 3090 / Flux2 Klein 9B | 2.06 s/it | 1.64 s/it，约 1.26x | 1.04 s/it，约 1.99x | compile 后可接近 2x |
| RTX 5060 8 GB / Klein 9B | 3.04 s/it | 2.53 s/it，约 1.20x | 2.25 s/it，约 1.35x | GPU 与 compile 收益差异很大 |

来源：[INT8-Fast Speed.md，commit 48a88b2](https://github.com/BobJohnson24/ComfyUI-INT8-Fast/blob/48a88b2fde88e986c6444fa1f51589b6089d04f3/Speed.md)、[INT8-Fast README，commit 48a88b2](https://github.com/BobJohnson24/ComfyUI-INT8-Fast/blob/48a88b2fde88e986c6444fa1f51589b6089d04f3/README.md)。

这些数据说明“CUDA 值得测”，不能证明 RedCraft Krea2 在我们的 GPU 上必然 2x。目标还把推荐 steps 从 10 降为 8；端到端若变快，其中至少混合了：

- 采样步数减少 20%；
- 内容模型 / distillation 配方变化；
- FP8/BF16 到 INT8 ConvRot 的 kernel 变化；
- compile、加载、offload 和分辨率差异。

没有同 checkpoint、同 steps、同 seed、同分辨率的对照，就不能给这些因素分摊收益。

### 2. ConvRot 的一般质量证据不能替代 RedMix2 产品评测

INT8-Fast 的 latent benchmark 显示，在其测试的 Anima、Flux2 Klein、Z-Image、Qwen Image 等模型上，INT8 ConvRot 通常比普通 INT8 和 FP8 更接近 BF16；实现说明 ConvRot 通过对权重和激活做正交分组旋转来降低量化 outlier。

但这些 benchmark **没有测试目标 RedCraft RedMix2**。更重要的是，我们现在比较的是 RedMix 1.1 与 RedMix2.1 两个内容 checkpoint，而非同权重的 FP8 与 INT8。目标 INT8 质量必须通过我们的角色资产 prompt、脸/手/身体结构、构图、文字遵循、角色一致性与失败率评测决定。

来源：[INT8-Fast Metrics.md，commit 48a88b2](https://github.com/BobJohnson24/ComfyUI-INT8-Fast/blob/48a88b2fde88e986c6444fa1f51589b6089d04f3/Metrics.md)、[comfy-kitchen ConvRot 参数与反量化实现](https://github.com/Comfy-Org/comfy-kitchen/blob/v0.2.16/comfy_kitchen/tensor/int8.py)。

## 四、是否替换：按运行环境给决策

| 运行环境 | 决策 | 原因 |
| --- | --- | --- |
| 当前 M4 Max / MPS | **不替换** | 目标 INT8 快速路径依赖 `_int_mm`；MPS 无该实现，当前真实 probe 失败 |
| Mac CPU fallback | **不作为生产替换** | 即使能执行也是 CPU 回退，不具备作者宣传的加速价值 |
| NVIDIA CUDA SM 7.5+ | **新增候选，A/B 后决定** | 原生 ComfyUI 图可复用，INT8 可能有性能收益，但目标缺少直接 benchmark |
| 全平台统一默认 | **现在不做** | 同一文件无法同时成为 CUDA 快路径和 MPS 稳定路径；应按 backend capability 路由 |

### Mac 想使用新内容权重，需要什么

有两条合理路线，优先级如下：

1. **优先取得作者样例所用的 RedMix2.1 scaled-FP8 或官方 BF16 文件**，然后按实际格式生成并验证 BF16；目标 Civitai version 当前没有把该 FP8/BF16 文件作为下载物公开。
2. 如果只能取得目标 INT8 ConvRot，则编写并验证 **layout-aware 的 ConvRot → BF16 离线转换器**。

第二条不能复用现有 FP8 转换脚本做简单 dtype 替换。当前旧模型的 scaled-FP8 转换是 `weight.float() * weight_scale`；ConvRot 权重还包含旋转布局语义。comfy-kitchen 在 `convrot=true` 时走专门的 `dequantize_int8_convrot_weight_dtype`，会按 scale 反量化并做逆旋转。新转换器必须：

- 先检查目标 SafeTensor 的实际 header、`.comfy_quant` / layout metadata 和 sidecar 名称；
- 对每个 ConvRot 权重使用与原生 loader 一致的 scale、group size 和逆 Hadamard rotation；
- 保留非量化张量与原始 dtype 语义；
- 与原生 CUDA INT8 用同 prompt / seed 做数值与图像对照；
- 在 MPS 跑过非白图、sanity、20 样本一致性和长时间稳定性后，才允许替换 Mac 默认。

在目标文件尚未下载并检查 header 前，不能假设其全部字段布局，也不能宣称现有 FP8 转换器已经支持它。

## 五、推荐落地与验收门槛

### 1. 不覆盖现有 workflow

保留 `redcraft-krea2-txt2img` 作为当前 Mac BF16 / 回滚通道，另建候选，例如：

```text
model key:    redcraft-krea2-redmix2-int8-convrot
workflow key: redcraft-krea2-redmix2-int8-txt2img
device gate:  cuda, SM >= 7.5
steps:        8
cfg:          1
sampler:      er_sde or euler
scheduler:    simple
```

新图继续使用原生 `UNETLoader`、`CLIPLoader(type=krea2)`、`VAELoader`、`ConditioningZeroOut` 和 `KSampler`；首轮不要同时加入 LoRA、upscaler 或 detailer，避免引入额外变量。

### 2. CUDA A/B 需要两层对照

**产品模式对照：**

- 旧 RedMix 1.1：10 steps；
- 新 RedMix2：8 steps；
- 相同 prompt 集、seed 集、分辨率和候选数；
- 记录冷加载、热态 p50/p95、峰值 VRAM、OOM / fallback、总成功率；
- 人工评审脸、手、结构、构图、细节、prompt 遵循、角色一致性与总体偏好。

**量化归因对照：**

- 只有取得内容相同的 RedMix2.1 FP8/BF16 后，才能把它与 RedMix2.1 INT8 用相同 steps 做对照；
- 如果没有同权重基线，只能判断“新候选整体是否更好”，不能判断“INT8 是否比 FP8 质量更好”。

### 3. 替换门槛

只有同时满足以下条件，才把新候选设为对应 backend 默认：

- 产品质量和角色一致性不低于当前 20 样本基线；
- 失败率、畸形率和 sanity 不退化；
- CUDA 热态吞吐或成本有明确收益，而不是只靠 10 → 8 steps 的表面差异；
- 峰值显存、加载/卸载和 LoRA 行为已验证；
- 保留当前 RedMix 1.1 BF16 为 Mac 默认与回滚版本；
- 通过 model file SHA、workflow version 和 backend capability 固定路由，禁止 MPS 误选 INT8 文件。

## 最终建议

**有必要“测”，没有必要“现在替换”。**

- 对当前 Apple M4 Max：继续使用已经跑通的 RedMix 1.1 BF16。若业务确实喜欢 RedMix2 的画风/细节，先拿到同内容 FP8/BF16 或完成正确 ConvRot → BF16 转换，再做 Mac A/B。
- 对未来 NVIDIA CUDA runner：将 `3086841` 作为独立 RedMix2 INT8 ConvRot 候选接入。它比此前评估的 Dark Beast 更适合作为“RedCraft 家族升级”候选，但仍须用我们的角色资产数据集验证。
- 不要删旧文件、改原 workflow 或把新文件直接路由到 MPS；也不要依据模型标题中的“2倍速”直接做生产切换。

相关本地基线：[`DARK_BEAST_KREA2_INT8_CONVROT_INTEGRATION.md`](./DARK_BEAST_KREA2_INT8_CONVROT_INTEGRATION.md)、[`redcraft-krea2-txt2img.json`](../../packages/gen/workflows/redcraft-krea2-txt2img.json)。
