# RedCraft RedMix3 与 iDream 替换评估

日期：2026-07-19  
目标：Civitai model `958009` / version `3139241`
当前 iDream 基线：RedCraft Krea2 RedMix 1.1 的 BF16 派生文件，Apple MPS，10 steps

## 更正

此前只读取了尚未包含新版本的 Civitai `.com` API 结果，错误地判断页面没有已发布的 RedMix3。登录后的 Civitai Red 实际页面与 `.red` API 已确认：

- 版本名：`赤佬 3.0 (Krea2)`
- Version ID：`3139241`
- 发布时间：2026-07-17 19:04 UTC
- Base model：Krea 2
- 三个公开文件：FP8 scaled、NF4 INT4 ConvRot、INT8 ConvRot

因此，RedMix3 是已经发布、可以下载的真实 Krea2 新版本，不是集合标题或未发布说明。

来源：[RedMix3 页面](https://civitai.red/models/958009/redcraft-or-2-or-3-int8int4fp8-scaled?modelVersionId=3139241)、[version `3139241` API](https://civitai.red/api/v1/model-versions/3139241)。

## 决策

**RedMix3 值得推进为 iDream 的替换候选；当前 Mac 路径应选 FP8 scaled 文件并转换为 BF16，不应选 INT8 或 NF4。**

但不直接覆盖现有默认：

1. 保留现有 RedMix 1.1 BF16 与 `redcraft-krea2-txt2img` 作为 serving baseline 和回滚通道。
2. 下载 RedMix3 FP8 scaled，固定 file ID 与 SHA-256。
3. 用已有 scaled-FP8 → BF16 路线生成独立 RedMix3 BF16 文件。
4. 新建候选 workflow，以作者样例的 12 steps / Euler / Simple / CFG 1 起测。
5. 完成同 prompt、seed、分辨率的受控 A/B；质量和稳定性达标后再把 Mac 默认切到 RedMix3。

这与此前 RedMix2 只有 INT8 下载物时不同：RedMix3 公开提供了作者样例实际使用的 FP8 scaled 变体，所以 Mac 升级路线已经可落地。

## 一、RedMix3 文件事实

### 1. 版本

| 字段 | 官方值 |
| --- | --- |
| Version ID | `3139241` |
| 版本名 | 赤佬 3.0 (Krea2) |
| Created | 2026-07-17 18:17:56 UTC |
| Published | 2026-07-17 19:04:35 UTC |
| Base model | Krea 2 / Standard |
| 作者推荐 | ER_SDE 或 Euler / Simple / CFG 1 / 8–12 steps |
| 内容定位 | Optimize visual effects |

作者说明中的内容名有 `RedMix3.1`，Civitai version 名和样例文件名使用 `RedMix3.0`。生产路由应以 version ID、file ID 和 SHA 为准，不依赖显示名的小版本差异。

### 2. 三个变体

| File ID | 页面文件名 | 格式 | 大小 | SHA-256 |
| --- | --- | --- | ---: | --- |
| `3019490` | `Krea2RedMix3.0-fp8-scaled-ComfyUI.safetensors` | FP8 SafeTensor | 12.24 GiB | `F6088960C0FEBD27CBD372FC758BB07D012F2D8AE3CD10C45C903D48B94409EA` |
| `3019523` | `Krea2RedMix3.0-ComfyUI-int4_convrot.safetensors` | NF4 / INT4 ConvRot SafeTensor | 5.98 GiB | `167BC68F286D6ACCC69D0572DDF23850EBC43ADDA09D36CA3F3F891FA525A5F1` |
| `3019607` | `Krea2RedMix3.0-ComfyUI-int8_convrot.safetensors` | INT8 ConvRot SafeTensor | 11.95 GiB | `A5DD85F90F873F80E2B07CB8D06FD6011755FCFB22434DFBB04155345EAA44B9` |

Civitai API 返回的三个底层资产名相同，都是 `redcraft23INT8INT4FP8_30Krea2.safetensors`；必须使用 `fileId` 或 `fp` 参数选择正确变体，不能只按底层文件名下载。

来源：[version `3139241` API](https://civitai.red/api/v1/model-versions/3139241)。

## 二、为什么 Mac 选择 FP8 → BF16

### 1. 作者样例与 FP8 下载物对得上

RedMix3 的 10 张作者样例 metadata 全部记录：

- Model：`Krea2RedMix3.0-fp8-scaled-ComfyUI`
- Sampler：Euler
- Scheduler：Simple
- CFG：1
- Steps：12
- 分辨率包括 1024×1536、1440×2160、1920×2880

这次样例所用模型名与公开 FP8 scaled 变体一致。与 RedMix2 不同，不再存在“样例用 FP8、公开下载只有 INT8”的证据断裂。

作者样例仍不能代替我们的角色资产 A/B，但足以证明 FP8 是 RedMix3 的一等发布路径，而不是自行猜测的转换来源。

### 2. 当前 MPS 仍不应直接跑 INT8 ConvRot

2026-07-19 对 iDream 实际连接的 `127.0.0.1:8188` 重新核验：

- ComfyUI `0.28.0`
- comfy-kitchen `0.2.21`
- PyTorch `2.10.0`
- device=`mps`
- `aten::_int_mm` MPS kernel=`false`

因此：

- INT8 ConvRot 可由 ComfyUI 识别，不代表 Apple MPS 有原生 INT8 加速；
- NF4/INT4 也不是当前已验证的 iDream MPS serving 路线；
- 当前最稳妥的 Mac 路线仍是把 scaled FP8 离线反量化为 BF16，再走原生 MPS。

### 3. 现有转换路线可复用，但仍需先验 header

当前 RedMix 1.1 的 BF16 文件来自已验证的 scaled-FP8 转换：

```text
FP8 weight.float() * weight_scale → BF16
```

RedMix3 文件名明确为 `fp8-scaled`，文件大小也与旧 FP8 同级，因此复用转换器的概率很高。但下载后仍必须先检查 SafeTensor header：

- `.comfy_quant` / format metadata
- `weight_scale` sidecar 形状
- FP8 tensor 数量与非量化 tensor dtype
- 是否仍为 per-tensor scaled FP8

只有 header 语义与旧格式一致，才能直接复用现有转换器。转换后必须检查全部量化 sidecar 已正确处理，并在 MPS 真实出图验证。

## 三、与当前默认的差异

当前 canonical descriptor：[`packages/gen/workflows/redcraft-krea2-txt2img.json`](../../packages/gen/workflows/redcraft-krea2-txt2img.json)。

| 项目 | 当前默认 | RedMix3 候选 |
| --- | --- | --- |
| 内容版本 | RedMix 1.1 | RedMix3.0 / 作者说明 RedMix3.1 |
| Diffusion | 旧 FP8 的 24 GiB BF16 派生物 | 新 FP8 scaled → BF16 |
| Text encoder | `qwen3vl_4b_bf16.safetensors` | 预计复用，下载后按 workflow metadata 复核 |
| VAE | `qwen_image_vae.safetensors` | 预计复用 |
| Steps | 10 | 作者推荐 8–12；样例统一 12 |
| Sampler | ER_SDE | 样例 Euler；作者推荐 ER_SDE 或 Euler |
| Scheduler / CFG | Simple / 1 | Simple / 1 |
| Mac 执行 | BF16 / MPS 已闭环 | 需新 BF16 转换与闭环 |

## 四、替换验收

### 1. 接入方式

- 保留 `redcraft-krea2-txt2img` 不动；
- 新建 `redcraft-krea2-redmix3-txt2img`；
- 新文件名带版本与精度，例如 `redcraftKREA2RedMix3-bf16.safetensors`；
- 固定来源 version `3139241`、file `3019490`、SHA `F608...09EA`；
- 首轮不叠加 LoRA、upscaler 或 detailer，避免混入额外变量。

### 2. A/B 矩阵

至少覆盖：

- 同一组角色资产 prompt；
- 同 seed、832×1216、单候选；
- 旧 RedMix 1.1 / 10 steps / ER_SDE；
- 新 RedMix3 / 12 steps / Euler；
- 新 RedMix3 / 10 steps / ER_SDE；
- 记录冷加载、热态耗时、峰值统一内存、失败率；
- 评审脸、手、身体结构、构图、提示词遵循、材质细节和角色一致性。

### 3. 切换门槛

满足以下条件后，才把 RedMix3 设为 Mac 默认：

- 20 样本总体偏好和角色一致性不低于旧版；
- 畸形率、白图率、OOM 和任务失败率不退化；
- 12-step 质量收益足以覆盖额外步骤成本，或 10-step 已优于旧版；
- 冷热态内存、卸载和连续任务稳定性通过；
- 旧 RedMix 1.1 BF16 继续保留为回滚。

## 最终建议

**是 RedMix3；值得替换，但应按“并行候选 → FP8 转 BF16 → A/B → 切默认”执行，而不是把下载物直接覆盖旧文件。**

- Apple M4 Max：下载 FP8 scaled `3019490`，不要下载 INT8/NF4 作为主路径。
- NVIDIA CUDA：可额外测试 INT8 ConvRot `3019607`；它是另一条 backend 优化，不影响 Mac 的 BF16 决策。
- 当前旧版继续 serving，直到 RedMix3 BF16 完成真实 MPS 闭环。
