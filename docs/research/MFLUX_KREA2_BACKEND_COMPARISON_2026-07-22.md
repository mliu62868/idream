# Apple Silicon Krea 2 后端比较：ComfyUI / Draw Things / stable-diffusion.cpp / MFLUX

日期：2026-07-22
目标机器：Apple M4 Max（40 GPU cores、128 GB unified memory）

## 结论

目前没有证据能证明某一个后端在 **M4 Max、Krea 2、相同模型/尺寸/步数/量化** 下绝对最快。四个项目均未发布这组 apples-to-apples benchmark；把其他模型、M5 或不同位宽的数字直接横比会误导决策。

对 iDream 当前资产，建议不是选一个后端替换全部，而是分工：

1. **ComfyUI 继续作为能力最完整的保底和工作流事实源。** 它是当前唯一已经跑通 RedCraft BF16、RedMix3 scaled-FP8 转换路径、DarkBeast 多参考图和复杂节点图的后端，但 MPS BF16 速度慢。
2. **Draw Things 是最值得优先做 Krea 2 实机 A/B 的 Apple 主 runner 候选。** 当前已安装的 `1.20260716.0` 支持官方 Krea 2 和 LoRA；7 月 20 日后的源码又加入完整 Krea 模型导入，并明确处理 `model.diffusion_model.` 前缀，和 RedCraft BF16 的形态最贴近。但完整导入尚不在本机发布版，速度也尚未对本机 Krea 2 实测。
3. **MFLUX 是第二个强速度候选，但当前只能作为固定 commit 的实验后端。** Krea 2 于 6 月 30 日才合入 `main`，仍在 `Unreleased`；本机/PyPI `0.18.0` 没有 `mflux-generate-krea2`。它有 MLX 原生 q8、8-step Turbo、LoRA 和单图 img2img，但没有 M4 Max Krea 2 公共 benchmark，且上游仍有未合入的 Krea 2 调度器正确性修复。
4. **stable-diffusion.cpp 保留为轻量可移植 runner 与 PiD 专用快路径。** 它已经在本机证明 PiD 可显著缩短两阶段生成时间；Krea 2 本身支持 safetensors/GGUF，但没有证据证明其 Krea 2 Metal 路径比 Draw Things 或 MFLUX 更快，参考图与自定义 LoRA 边界也更窄。

若目标是“现有 RedCraft 自定义 Krea 2 模型尽快提速”，试验优先级应为：

```text
Draw Things HEAD / 下一发布版
  -> MFLUX main（先转换并等待/带入调度器修复）
  -> stable-diffusion.cpp Krea 2
  -> ComfyUI 保底
```

这只是试验优先级，不是未经实测的速度排名。

## 一、MFLUX Krea 2 的真实版本状态

| 项目 | 核实结果 |
| --- | --- |
| 最新正式 PyPI / Release | `0.18.0`，2026-06-07，不含 Krea 2 CLI |
| Krea 2 合入 | `main` commit [`97ac5e6`](https://github.com/filipstrand/mflux/commit/97ac5e6280e8c65e48a609722229eb9d03ef2cbe)，2026-06-30 |
| Changelog 状态 | [`Unreleased`](https://github.com/filipstrand/mflux/blob/97ac5e6280e8c65e48a609722229eb9d03ef2cbe/CHANGELOG.md#L8-L18) |
| 本机状态 | `uv tool list` 为 `mflux v0.18.0`；有 `mflux-generate`，没有 `mflux-generate-krea2` |
| 包版本陷阱 | 合入后的 `main` 仍写 `version = "0.18.0"`，不能只看版本字符串判断功能 |

因此普通的 `uv tool install --upgrade mflux` 不能得到 Krea 2。实验时应使用隔离环境并固定 commit，而不是覆盖当前全局工具：

```bash
uv tool install --force \
  'git+https://github.com/filipstrand/mflux.git@97ac5e6280e8c65e48a609722229eb9d03ef2cbe'
```

上游 Krea 2 命令是：

```bash
mflux-generate-krea2 \
  --prompt "a photograph of a red fox sitting in a sunlit forest clearing" \
  --width 1024 \
  --height 1024 \
  --seed 42 \
  --steps 8 \
  -q 8
```

默认模型是 `krea/Krea-2-Turbo`；默认 recipe 为 8 steps、guidance 1.0、ER-SDE。来源：[MFLUX Krea 2 README](https://github.com/filipstrand/mflux/blob/97ac5e6280e8c65e48a609722229eb9d03ef2cbe/src/mflux/models/krea2/README.md)、[CLI 实现](https://github.com/filipstrand/mflux/blob/97ac5e6280e8c65e48a609722229eb9d03ef2cbe/src/mflux/models/krea2/cli/krea2_generate.py)。

### 尚未收口的正确性风险

[`PR #465`](https://github.com/filipstrand/mflux/pull/465) 仍为 open。该 PR 指出已合入版本把 `shift=1.15` 当成静态线性 shift，而官方 Krea 2 scheduler 使用按图像 token 数插值的动态指数 shift；提交者在 1024² 的同 seed A/B 中观察到明显清晰度差异。

这意味着 `main@97ac5e6` 能出图，但不能把它当成已经与官方 recipe 完全对齐的生产实现。速度测试也必须先固定调度器版本，否则质量不同的结果不具备可比性。

另有 [`PR #478`](https://github.com/filipstrand/mflux/pull/478) 修复 Qwen VAE 跨线程使用问题。纯 CLI 单进程路径不一定触发，但若未来把 MFLUX 嵌入 ComfyUI 或线程池 worker，需要把它列入验收。

## 二、MFLUX 的模型、LoRA、量化与参考图边界

### 1. 本地模型不是“传一个 safetensors 就能跑”

当前 Krea 2 loader 要求 official-style 完整目录：

```text
model-dir/
  turbo.safetensors
  vae/*.safetensors
  vae/*.json
  text_encoder/*.safetensors
  text_encoder/*.json
  tokenizer/*
```

根文件名与组件路径由 [`Krea2WeightDefinition`](https://github.com/filipstrand/mflux/blob/97ac5e6280e8c65e48a609722229eb9d03ef2cbe/src/mflux/models/krea2/weights/krea2_weight_definition.py) 固定。`--model /path/model.safetensors` 会被当作模型根路径，随后仍会寻找 `turbo.safetensors`、VAE、text encoder 与 tokenizer，所以任意 ComfyUI 单文件不能直接加载。

MFLUX 当前只映射官方根目录 `turbo.safetensors` 的 native keys；支持 Raw、Diffusers shard 和 Krea 2 LoRA 训练的 [`PR #462`](https://github.com/filipstrand/mflux/pull/462) 仍为 open。

### 2. RedCraft BF16 不能原样直载，但转换成本可控

本机检查：

```text
redcraftKREA2RedMix_krea2Edition-bf16.safetensors
size:    25,640,200,624 bytes
tensors: 430
keys:    model.diffusion_model.blocks.0...
dtype:   BF16
```

MFLUX 的 native mapping 期望 `blocks.0...`、`first.*`、`txtfusion.*` 等无前缀 key。因此要做一次确定性的转换：

1. 去掉每个 tensor key 的 `model.diffusion_model.`；
2. 输出为根目录 `turbo.safetensors`；
3. 补齐官方 Krea 2 的 `vae/`、`text_encoder/`、`tokenizer/`；
4. 先用 BF16 固定 seed 出图校验，再生成 MFLUX q8 缓存。

这属于“架构上高度可迁移”，不是“当前文件已实机跑通 MFLUX”。

### 3. LoRA 推理支持比完整 checkpoint 更成熟

MFLUX Krea 2 已支持多 LoRA 与 scale，支持以下 key 族：

- Krea native / `transformer.*`；
- Diffusers/PEFT `base_model.model.*`；
- Comfy `diffusion_model.*`；
- flat `lora_unet_*`。

来源：[Krea 2 README 的 LoRA 部分](https://github.com/filipstrand/mflux/blob/97ac5e6280e8c65e48a609722229eb9d03ef2cbe/src/mflux/models/krea2/README.md#lora)、[LoRA mapping 源码](https://github.com/filipstrand/mflux/blob/97ac5e6280e8c65e48a609722229eb9d03ef2cbe/src/mflux/models/krea2/weights/krea2_lora_mapping.py)。

但当前已合入版本只有 LoRA **推理**；`mflux-train` 尚不能训练 Krea 2 LoRA。官方建议在 Krea 2 Raw 上训练、在 Turbo 上推理；相关训练实现仍在 open PR #462。

### 4. 量化

CLI 接受 `3/4/5/6/8-bit`，Krea 2 README 推荐 q8。量化不是把所有组件都压到该位宽：

- Qwen3-VL text encoder 明确跳过量化，以免降低 conditioning；
- 输入维度不满足 group-size 要求的层会跳过量化；
- 官方完整首次下载约 33 GB，其中 `turbo.safetensors` 约 24 GB；PR 验证的保存后 q8 目录约 21 GB。

应先用 `mflux-save` 缓存量化模型，避免每次启动重新量化。MFLUX q8 与 Comfy `scaled-FP8/comfy_quant`、Draw Things `i8x/q8p`、GGUF `Q8_0` 是不同格式，不能互换文件。

### 5. 参考图

MFLUX Krea 2 已支持一张 init image 的 strength-based img2img：

```text
input image -> Qwen VAE encode -> add noise by strength -> Krea 2 denoise
```

它明确不同于 Krea 托管版把参考图送进 Qwen3-VL vision tower 的 style-reference 路径。当前没有：

- Krea style-reference；
- 多参考图；
- 指令式 image edit；
- 角色身份锚点融合。

因此 MFLUX Krea 2 适合纯文生图和传统单图 img2img，不能替代当前 Qwen Image Edit 或 FLUX.2 Klein 多参考图工作流。

## 三、四后端能力矩阵

| 维度 | ComfyUI 0.28.0 | Draw Things | stable-diffusion.cpp | MFLUX Krea 2 |
| --- | --- | --- | --- | --- |
| Krea 2 文生图 | 本机已跑通 | `1.20260716.0` 官方支持 | 官方文档支持 Raw/Turbo | 仅 `main` 未发布支持 |
| 当前 RedCraft BF16 | **已跑通** | 发布版不可导；HEAD importer 高匹配候选 | safetensors 架构候选，未实图验收 | 需 strip prefix + 完整目录 |
| Comfy scaled-FP8 | **原生支持** | 不可直接复用 | 不可直接复用 | 不可直接复用 |
| 完整自定义 Krea 模型 | 最完整 | HEAD commit `12be777` 新增 | 取决于受支持的 raw/GGUF/safetensors layout | 仅 native official-style dir；Diffusers 支持仍在 PR |
| Krea LoRA 推理 | 支持 | 发布说明明确支持 | 通用 LoRA 存在，但 Krea 2 专项兼容未给出充分证据 | 支持多种 Krea/PEFT/Comfy key |
| Krea LoRA 训练 | 非 core 训练器 | Krea 2 发布说明未证明训练 | 不支持 | 当前不支持；open PR |
| Krea 单图 img2img | 节点图可构建 | 通用图生图候选，需按 Krea 2 验收 | Krea 2 官方文档只给出 txt2img 示例 | **明确支持** strength img2img |
| Krea style/multi-reference | 可通过复杂图/扩展研究，当前基线不是托管 style-reference | 无 Krea 2 专项公开证明 | 无 Krea 2 专项公开证明 | **不支持** |
| Apple 优化 | PyTorch MPS | 自研 Metal/MFA、Apple 产品优先 | ggml Metal | 原生 MLX、`mx.compile`、MLX quantization |
| 工程成熟度 | 当前生产保底 | 发布版稳定；完整 importer 需下一版/HEAD | CLI 已本机使用 | Krea 2 很新、未发布、仍有 open correctness PR |

来源：

- Draw Things [`1.20260716.0` 发布说明](https://drawthings.ai/downloads/)；
- Draw Things [`12be777` 完整 Krea importer](https://github.com/drawthingsai/draw-things-community/commit/12be7770c)，其中明确识别 430 tensors、Diffusers/native layout，并去除 `model.diffusion_model.` 前缀；
- stable-diffusion.cpp [Krea 2 文档](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/krea2.md)与[支持格式/Metal 后端](https://github.com/leejet/stable-diffusion.cpp)；
- MFLUX [`PR #453`](https://github.com/filipstrand/mflux/pull/453) 与合入后的 [Krea 2 README](https://github.com/filipstrand/mflux/blob/97ac5e6280e8c65e48a609722229eb9d03ef2cbe/src/mflux/models/krea2/README.md)。

## 四、iDream 现有模型迁移判断

| 当前资产 | ComfyUI | Draw Things | sd.cpp | MFLUX | 建议 |
| --- | --- | --- | --- | --- | --- |
| RedCraft Krea2 BF16 | 已验证基线 | **HEAD 最优先候选**；importer 会 strip 当前前缀 | split Krea 2 候选 | 可转换为 native dir 后 q8 | 先做 Draw Things，再做 MFLUX |
| RedMix3 Comfy scaled-FP8 | 当前唯一直接 loader | 不直载 | 不直载 | 不直载 | 先完成/验证 BF16 反量化，再分别转换；禁止用原 scaled 文件冒充兼容 |
| DarkBeast FLUX.2 Klein 9B | 两参考图 MPS 已跑通 | 官方支持 FLUX.2 Klein 与模型导入 | 官方支持 FLUX.2 Klein | `0.18.0` 已支持 4B/9B/KV、多图 edit、量化 | exact DarkBeast 文件仍需各 runner 实图；MFLUX 官方 9B-KV 可另立速度候选 |
| Qwen Rapid BF16 AIO | 当前 AIO 路径 | Qwen 架构支持，AIO 封装未验证 | 建议使用 split 组件 | 当前使用 Qwen Edit 2509 的 HF 目录，不是当前 AIO/2511 直接替代 | 最后迁；先拆 diffusion/text encoder/VAE，并保持 Qwen 生产路由不变 |
| PiD 1.5 BF16 | ComfyUI 可工作流化 | 无官方支持证据 | **本机已跑通** | 无 PiD 实现 | 继续留在 sd.cpp 的 draft/balanced 后处理路径 |

MFLUX 对 DarkBeast 的吸引力比对 RedCraft 更成熟：正式 `0.18.0` 已支持 FLUX.2 Klein 4B/9B、量化、LoRA、多图 edit，且 changelog 声称 9B KV-cache 在多参考图 edit 中约有 `2.4x` 相对加速。但该数字是 MFLUX 自身 KV 与非 KV 路径的相对值，不是与 Draw Things/ComfyUI/sd.cpp 的横向 benchmark，也不是 exact DarkBeast checkpoint 的结果。

## 五、速度证据：已证明什么，没证明什么

### 公开证据

| 来源 | 数据 | 能支持的结论 | 不能支持的结论 |
| --- | --- | --- | --- |
| MFLUX Krea 2 golden image metadata | 1024²、8 steps、q8，记录约 `49.22s` | 实现能完成一次 q8 出图 | 没有机器、GPU 核数、冷/热和加载口径，不能当 M4 benchmark |
| Draw Things 2026-04 性能文章 | 在 M5 的若干任务中比其他实现快 `1.24x–2.57x` | Draw Things 的 Metal kernel 是强速度候选 | 不是 Krea 2、不是 M4 Max，且未给同模型完整明细 |
| stable-diffusion.cpp Krea 2 文档 | 给出 raw/GGUF/safetensors 命令 | 支持 Krea 2 Metal/跨平台运行 | 没有 Krea 2 M4 时间 |
| ComfyUI 官方资料 | 支持 Apple Silicon/MPS 和 Krea 2 工作流 | 功能支持 | 没有 Krea 2 M4 同口径时间 |

Draw Things 性能文章：[Metal Quantized Attention](https://releases.drawthings.ai/p/metal-quantized-attention-pulling)。文章自己的测试主角是 M5，并未给 Krea 2/M4 Max 对照，因此只能作为候选优先级依据。

### iDream 本机已证明的速度

当前内部实测：

- ComfyUI RedCraft BF16，`832x1024`、10-step ER-SDE：一次记录 `102.381s`；
- ComfyUI RedCraft BF16，直接 `832x1216` 暖运行 wall 中位数：`108.205s`；
- `208x304 ComfyUI -> sd.cpp PiD 4x -> 832x1216`：`20.631s`，约 `5.24x`；
- `352x512 ComfyUI -> sd.cpp PiD 4x -> 1408x2048`：`49.718s`；直接原生 2K 为 `401.933s`，约 `8.08x`。

来源：[RedMix3 MPS 集成记录](./REDMIX3_MPS_INTEGRATION_2026-07-19.md)、[PiD 832x1216 benchmark](./SDCPP_PID_TWO_STAGE_SPEED_BENCHMARK_2026-07-21.md)、[PiD 2K benchmark](./SDCPP_PID_2K_QUALITY_SPEED_BENCHMARK_2026-07-22.md)。

PiD 数据证明的是“两阶段 pipeline 可显著提速”，不是 sd.cpp 直接生成 Krea 2 最快；它也有可见画质代价，不能用来推断四个 Krea runner 的原生速度排名。

## 六、应如何得到最终答案

先建独立候选，不改当前 production route。使用同一 RedCraft BF16 内容版本，分两轮测：

### 轮次 A：同精度/同内容能力

```text
prompt:       现有角色资产固定 prompt
seeds:        3 个固定 seed
size:         832x1216
steps:        8 与当前 10-step recipe 分开记录
guidance:     1.0
sampler:      尽量统一 ER-SDE；不能统一时明确记录 recipe 差异
precision:    BF16（能统一的后端）
runs:         1 cold + 3 warm
metrics:      load / text encode / sampling / VAE / wall / peak memory / swap
```

### 轮次 B：各后端最佳生产 recipe

- Draw Things：其推荐量化格式；
- MFLUX：预缓存 q8，guidance 1.0；
- sd.cpp：最合适的 GGUF/BF16 + Metal flash attention；
- ComfyUI：当前 BF16 基线；
- 另列 PiD draft/balanced，不混入原生质量排名。

每张图都要通过 PNG/尺寸/非黑图检查，并人工比较脸、手、身体结构、皮肤纹理、提示遵循和角色一致性。只有在同一质量门槛下，wall time 才能决定“哪个好、是否更快”。

## 许可证边界

runner 不会改变模型权重本身的许可证。Krea 2 及其 RedCraft 等 derivative 受 Krea 2 Community License 约束：公司及关联实体过去十二个月总营收低于 100 万美元时才可按社区许可证商用；达到或超过该门槛需要另行取得 enterprise license。[Krea 2 官方许可](https://www.krea.ai/krea-2-licensing)

PiD 的本机速度结果只可作为研究候选：`stable-diffusion.cpp` 代码是 MIT，但当前 NVIDIA PiD 权重是 NSCLv1，仅限非商业研究或评估，不能因换成 sd.cpp runner 就进入 iDream 商业生产。[NVIDIA PiD 模型卡](https://huggingface.co/nvidia/PiD#licenseterms-of-use)

## 最终推荐

当前可以立即做出的工程决策是：

```text
production fallback / complex workflow: ComfyUI
Apple Krea 2 primary experiment:         Draw Things HEAD or next release
Apple Krea 2 secondary experiment:       MFLUX pinned main + scheduler fix
portable / GGUF / PiD:                   stable-diffusion.cpp
```

不建议现在把 MFLUX 设为生产默认：本机正式版尚无 Krea 2、完整 checkpoint 不能原样加载、调度器修复未合入、且没有 M4 Max 同口径速度证据。它值得做 q8 暖运行 A/B；若质量达到 ComfyUI/Draw Things 且 wall time 更低，再把它接成独立 `mflux` backend，而不是静默替换现有模型路由。
