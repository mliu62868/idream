# RedCraft 赤佬 2/3 版本与 iDream 替换评估

日期：2026-07-19  
目标页：Civitai model `958009`  
当前 iDream 基线：RedCraft Krea2 RedMix 1.1 的 BF16 派生文件，ComfyUI / Apple MPS，10 steps

## 决策

**现在不替换 iDream 的 Krea2 BF16 / MPS 默认路径。**

- 用户给出的页面是一个跨多种 base model 的集合，不是单一的递进版本线。作者在模型总说明中明确说明：集合内模型为并列关系，不能按列表统一解释为升级。
- 按发布时间，集合中最新的公开版本是 `3100874`，但它是 **ZImageTurbo** 的 RedZiT2，不是 Krea 2，不能覆盖我们现有 Krea2 workflow。
- 与我们当前路径真正可比的最新 Krea 2 版本是 `3086841`（赤佬2 / RedMix2）。它是新内容权重，但当前唯一公开下载物是 13.16 GiB INT8 SafeTensor，不是我们 Mac 路径需要的 BF16。
- ComfyUI 可以原生识别这类 INT8 ConvRot 布局，但快速线性计算依赖 INT8 matmul。截至 PyTorch 2.13.0，`_int_mm` 仍只注册 CPU/CUDA/XPU，没有 MPS dispatch；因此它不能作为 Apple MPS 的生产替代。

正确动作是：**保留现有 BF16 默认与回滚路径；`3086841` 仅作为 NVIDIA CUDA 候选做独立 A/B。**

## 一、先拆清“页面”与“版本”

### 1. 集合标题不是文件清单

模型页标题是 `RedCraft | 红潮2 | 赤佬3 INT8/INT4/FP8 Scaled 加速`，但这只是 model `958009` 的集合级命名。Civitai API 当前只列出两个 `baseModel=Krea 2` 版本：

| Version ID | 版本名 | 发布时间 UTC | 实际文件情况 |
| --- | --- | --- | --- |
| `3086841` | 赤佬2 (Krea2)Edition | 2026-07-01 13:55 | 1 个 INT8 SafeTensor |
| `3066243` | 赤佬1.1 INT8 & INT4 | 2026-06-24 21:57 | Q4_0 GGUF + FP8 + NF4 + INT8 |

API 中没有已发布的 Krea2 “赤佬3 / RedMix3.1” version object 或可下载文件。作者在集合说明里提到 RedMix3.1 文件名，不等于 Civitai 版本 API 已经发布它。

来源：[model `958009` API](https://civitai.red/api/v1/models/958009)、[用户给出的模型页](https://civitai.red/models/958009/redcraft-or-2-or-3-int8int4fp8-scaled)。

### 2. “最新”有两个不同答案

| 口径 | Version ID | Base model | 发布时间 UTC | 是否能替换当前 Krea2 |
| --- | --- | --- | --- | --- |
| 整个集合按发布时间最新 | `3100874` RedZiT2 2026HD | ZImageTurbo | 2026-07-05 11:42 | **不能**，模型架构/workflow 不同 |
| Krea 2 线最新 | `3086841` 赤佬2 | Krea 2 | 2026-07-01 13:55 | 可做候选，但不能在 MPS 直接替换 |

`3100874` 的版本说明是 ZImageTurbo HD 2026，作者宣称 INT8 ConvRot 带来 2x 提速。集合级说明写了 8 steps，但该 version 的独立说明没有给出 sampler、scheduler 或 CFG，也没有可复现的硬件、耗时、显存和对照方法。这些宣传不能成为 iDream 替换 Krea2 的证据。

来源：[version `3100874` API](https://civitai.red/api/v1/model-versions/3100874)、[model `958009` API](https://civitai.red/api/v1/models/958009)。

## 二、官方版本与文件元数据

### 1. 新 Krea2 目标：`3086841`

| 字段 | 官方 API 值 |
| --- | --- |
| 版本名 | 赤佬2 (Krea2)Edition |
| Base / type | Krea 2 / Standard |
| Created | 2026-07-01 02:30:01 UTC |
| Published | 2026-07-01 13:55:47 UTC |
| Version record updated | 2026-07-17 18:17:56 UTC |
| 作者推荐 | ER_SDE 或 Euler / Simple / CFG 1 / 8 steps |
| 作者内容标识 | Krea2-RED-Mix2；样例 metadata 为 RedMix2.1 |

2026-07-17 的 `updatedAt` 是 **version record** 更新，不能单独证明 checkpoint 二进制重传。当前文件 ID、大小和 SHA-256 仍为：

| File ID | 文件 | Civitai 精度标记 | 大小 | SHA-256 |
| --- | --- | --- | ---: | --- |
| `2968503` | `redcraft23INT8INT4FP8_2Krea2Edition.safetensors` | SafeTensor / INT8 | 13,801,011.46875 KiB (13.16 GiB) | `C7C8D0EED618F7B971629B0AA7B115D4536C8BEE14E3AFB6D928B0A9DC14F804` |

这个 version **没有** INT4、NF4、GGUF、FP8 或 BF16 附件。集合标题中的 `INT8/INT4/FP8` 不能投影成该 version 的文件清单。Civitai 文件 metadata 直接标记的是 `fp=int8`；“ConvRot”来自作者对该下载物的说明。本评估没有下载 13.16 GiB 文件，因此未独立解析其 SafeTensor header/layout sidecar。

来源：[version `3086841` API](https://civitai.red/api/v1/model-versions/3086841)、[model `958009` API](https://civitai.red/api/v1/models/958009)。

### 2. 旧 Krea2 源版本：`3066243`

旧版本作者推荐 ER_SDE 或 Euler / Simple / CFG 1 / 10 steps，其当前完整文件表如下：

| File ID | 格式 / 量化 | 大小 | SHA-256 |
| --- | --- | ---: | --- |
| `2982648` | GGUF Q4_0 | 7.74 GiB | `3C5DD604D63884D7146B5242AD5A97933D4EAC608E4571E9A4827E4F701A2566` |
| `2945029` | SafeTensor FP8（primary） | 12.24 GiB | `92E8D4EECBF4F89B30140DC231E377118823BE3A30C5C04342BCF394FE27E73B` |
| `3002159` | SafeTensor NF4 | 6.82 GiB | `1D7BE949FD84654491AEE04C2DAAB641932742B5E0EB98FEDB67FE9FB79D72E8` |
| `2969307` | SafeTensor INT8 | 13.16 GiB | `CCB4A7D361D82599BD0CE57270892BB24A421EB134C2267855E1D4D6AF56D626` |

iDream 当前 MPS 默认并不是直接运行这些低比特文件，而是使用 FP8 primary 正确反量化得到的 `redcraftKREA2RedMix_krea2Edition-bf16.safetensors`。

来源：[version `3066243` API](https://civitai.red/api/v1/model-versions/3066243)、[model `958009` API](https://civitai.red/api/v1/models/958009)。

### 3. 全集合最新文件：`3100874`

| File ID | 文件 | Base / 精度 | 大小 | SHA-256 |
| --- | --- | --- | ---: | --- |
| `2980681` | `redcraft23INT8INT4FP8_redzit222026HD.safetensors` | ZImageTurbo / INT8 | 6.69 GiB | `C10B4C614DB9D90332EAC41E2FD4ABECD48E097901AECECF54B4ACB2E0B4371E` |

它是另一条 ZImageTurbo 模型线，不使用 Krea2 的 text encoder / VAE / conditioning 约定，因此不应与 iDream 当前 Krea2 BF16 checkpoint 做文件覆盖式替换。

来源：[version `3100874` API](https://civitai.red/api/v1/model-versions/3100874)。

## 三、作者样例不是当前 INT8 下载物的直接证明

`3086841` 的 10 张作者样例都带有 ComfyUI metadata。其中可验证的核心图为：

- `UNETLoader`: `Krea2RedMix2.1-8Steps-fp8-scaled-ComfyUI.safetensors`
- `CLIPLoader`: `qwen3vl_4b_bf16.safetensors`, type=`krea2`
- `VAELoader`: `qwen_image_vae.safetensors`
- negative conditioning: `ConditioningZeroOut`
- steps / CFG / scheduler: 8 / 1 / Simple
- sampler: 10 张中 8 张 Euler，1 张 ER_SDE，1 张 Euler ancestral

这些样例证明 RedMix2.1 内容线可以复用我们已有的 Krea2 text encoder、VAE 与大部分 workflow 拓扑。但样例的 UNet 是 **FP8 scaled 源权重**，不是 Civitai version 实际公开的 `2968503` INT8 文件。

因此，作者样例不能证明：

- 公开 INT8 文件在某个具体 GPU 上的速度或显存；
- INT8 与样例 FP8 的同 seed 输出一致性；
- INT8 在 Apple MPS 上可运行；
- 作者宣称的 2x 是量化带来，而不是 10 → 8 steps、内容权重或其他运行配置的混合结果。

来源：[version `3086841` API 的 `images[].meta.comfy`](https://civitai.red/api/v1/model-versions/3086841)、[Comfy-Org Krea 2 官方文件](https://huggingface.co/Comfy-Org/Krea-2)。

## 四、与 iDream 当前路径的精确差异

当前 canonical descriptor 是 [`packages/gen/workflows/redcraft-krea2-txt2img.json`](../../packages/gen/workflows/redcraft-krea2-txt2img.json)：

| 项目 | iDream 当前默认 | `3086841` 候选 |
| --- | --- | --- |
| 内容版本 | RedMix 1.1 | RedMix2 / 样例标识 RedMix2.1 |
| Diffusion 文件 | `redcraftKREA2RedMix_krea2Edition-bf16.safetensors` | `redcraft23INT8INT4FP8_2Krea2Edition.safetensors` |
| 执行精度 | BF16 | INT8（作者称 ConvRot） |
| 默认硬件 | Apple MPS | 快速路径面向 NVIDIA CUDA |
| Text encoder | `qwen3vl_4b_bf16.safetensors` | 作者样例相同 |
| VAE | `qwen_image_vae.safetensors` | 作者样例相同 |
| Steps | 10 | 8 |
| Sampler / scheduler / CFG | ER_SDE / Simple / 1 | ER_SDE 或 Euler / Simple / 1 |

当前仓库还把 `redcraft_krea2_default` 绑定到 `redcraft-krea2-comfyui` + `redcraft-krea2-txt2img`。[`docs/product/LAUNCH_READINESS_AUDIT.md`](../product/LAUNCH_READINESS_AUDIT.md) 记录的最新本地验收是 ComfyUI 0.28.0 / MPS，832×1024 成功图，该路径已是当前有证据的 serving baseline。新 INT8 文件既未在这条路径下载，也没有 MPS 成功闭环。

## 五、依赖与硬件边界

### 1. ComfyUI 原生加载

- 作者指向 ComfyUI 0.27 的原生 INT8 ConvRot 支持；目标是 diffusion-only 文件，应使用标准 `UNETLoader` / Load Diffusion Model，而不是 All-in-one checkpoint loader。
- 截至 2026-07-19，ComfyUI 最新官方 release 是 v0.28.0，其 requirements 固定 `comfy-kitchen==0.2.20`。v0.28.0 新增 ConvRot INT4 支持，但不会把 `3086841` 这个只有 INT8 的文件变成 INT4。
- Krea2 完整图仍需 `qwen3vl_4b_bf16.safetensors`、`qwen_image_vae.safetensors`、Krea2 CLIP type 以及 zeroed negative conditioning。

来源：[ComfyUI v0.28.0 release](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.28.0)、[v0.28.0 requirements.txt](https://github.com/Comfy-Org/ComfyUI/blob/v0.28.0/requirements.txt)、[v0.28.0 quant_ops.py](https://github.com/Comfy-Org/ComfyUI/blob/v0.28.0/comfy/quant_ops.py)。

### 2. NVIDIA CUDA

`comfy-kitchen` v0.2.20 的 `TensorWiseINT8Layout` 说明：

- INT8 快速 matmul 使用 `torch._int_mm` / cuBLASLt IMMA；
- 最低 fast-path compute capability 是 **SM 7.5（Turing）**；
- `supports_fast_matmul()` 在没有 CUDA capability 时返回 false；
- ComfyUI v0.28.0 的内建 comfy-kitchen CUDA backend 还要求 PyTorch CUDA 13.0+ 才不会被禁用；实际部署必须与驱动、PyTorch wheel 和 GPU 一起验证。

来源：[comfy-kitchen v0.2.20 INT8 layout](https://github.com/Comfy-Org/comfy-kitchen/blob/v0.2.20/comfy_kitchen/tensor/int8.py)、[eager INT8 implementation](https://github.com/Comfy-Org/comfy-kitchen/blob/v0.2.20/comfy_kitchen/backends/eager/quantization.py)、[comfy-kitchen v0.2.20 README](https://github.com/Comfy-Org/comfy-kitchen/blob/v0.2.20/README.md)。

### 3. Apple MPS

Apple MPS 不满足这条快速路径。`comfy-kitchen` 的 eager INT8 线性实现最终使用 `torch.int8_mm`（若存在）或 `torch._int_mm`。PyTorch 2.13.0 的官方 operator dispatch 仅列出 CPU、CUDA 和 XPU，没有 MPS。PyTorch 中已有另一个 `_weight_int8pack_mm` MPS kernel，但它不是 comfy-kitchen 当前 ConvRot 线性路径调用的 `_int_mm`，不能混为一谈。

2026-07-19 对 iDream 实际连接的 `127.0.0.1:8188` 重新核验：

- 活动 runtime 是 ComfyUI `0.28.0`、comfy-kitchen `0.2.21`、PyTorch `2.10.0`；
- `/system_stats` 报告的计算设备是 `mps`；
- 同一 Python runtime 的 dispatch probe 返回 `aten::_int_mm`：MPS kernel=`false`、CPU kernel=`true`；
- 当前 canonical workflow 仍加载 24 GiB 的 RedMix 1.1 BF16 派生文件并使用 10 steps；
- `3086841` 的 INT8 文件尚未下载到共享模型目录。

这说明结论不是由旧 ComfyUI 版本造成：本地已经在 `0.28.0` / `0.2.21`，真正缺失的仍是 PyTorch MPS 的 INT8 matmul 执行能力。

结论：

- “ComfyUI 可以识别/加载”不等于“MPS 可以执行”；
- CPU fallback 即使可设法打通，也不是 INT8 MPS 加速，不适合作为现有 BF16 生产路径的替代；
- 升级 ComfyUI 0.28.0 不会自动补上 PyTorch `_int_mm` 的 MPS kernel。

来源：[PyTorch 2.13.0 `_int_mm` dispatch](https://github.com/pytorch/pytorch/blob/v2.13.0/aten/src/ATen/native/native_functions.yaml)、[PyTorch 2.13.0 release](https://github.com/pytorch/pytorch/releases/tag/v2.13.0)、[comfy-kitchen v0.2.20 eager INT8](https://github.com/Comfy-Org/comfy-kitchen/blob/v0.2.20/comfy_kitchen/backends/eager/quantization.py)。

## 六、替换建议

| 环境 / 目标 | 建议 | 原因 |
| --- | --- | --- |
| 当前 Apple MPS 默认 | **不替换** | 现有 BF16 已闭环；INT8 ConvRot 的 matmul 无 MPS dispatch |
| 用 `3100874` 覆盖 Krea2 | **禁止** | ZImageTurbo 与 Krea2 是不同 base/workflow |
| NVIDIA CUDA SM 7.5+ | **新增独立候选** | 格式与快速 INT8 路径匹配，但需真实 A/B |
| 全平台统一默认 | **现在不做** | 相同 INT8 文件无法同时作为 CUDA 快路径和 MPS 稳定路径 |

### 如果要评测 `3086841`

1. 不覆盖 `redcraft-krea2-txt2img`，不删除旧 BF16；新建 CUDA-only model/workflow key。
2. 下载时固定 file ID `2968503` 与 SHA-256 `C7C8...14F804`；不以 `updatedAt` 判断权重变化。
3. 复用 Krea2 的 Qwen3-VL BF16 text encoder、Qwen Image VAE、`ConditioningZeroOut`；默认 8 steps / CFG 1 / Simple，先比 ER_SDE 和 Euler。
4. 用相同 prompt、seed、分辨率和候选数对比旧 RedMix 1.1 BF16；记录冷启动、热态 p50/p95、峰值 VRAM、OOM/回退、成功率、角色一致性和解剖失败率。
5. 只有拿到作者样例所用的同内容 RedMix2.1 FP8/BF16，才能把“内容升级”与“INT8 量化收益”分开归因。

### Mac 想要 RedMix2 内容

优先等待/获取作者样例的 RedMix2.1 scaled-FP8 或 BF16 权重，再以已有 BF16 路径验证。若只有 INT8 ConvRot，则需 layout-aware 离线反量化：必须使用文件中的 scale、group size 和逆 Hadamard/ConvRot 语义，不能把现有 FP8 的 `weight * scale` 脚本直接套用。转换结果未与原生 CUDA INT8 及 MPS 生图对照前，不应进入 serving。

## 最终回答

**这个集合确实有比我们当前 RedMix 1.1 新的 Krea2 RedMix2 内容，但不应现在替换。**

- 对现有 M4 Max / MPS：继续用 BF16 / 10-step 基线。
- 对 NVIDIA CUDA：可以把 `3086841` 作为 RedMix2 INT8 ConvRot 候选，但必须独立接入、固定 SHA、完成受控 A/B 后才决定是否成为 CUDA 默认。
- 不要被集合标题中的“赤佬3 / INT8 / INT4 / FP8 / 2倍速”合并命名误导；真实替换单位必须是具体 version ID + file ID + SHA + backend capability。
