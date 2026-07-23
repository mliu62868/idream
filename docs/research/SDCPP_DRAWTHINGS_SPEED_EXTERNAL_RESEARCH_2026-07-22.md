# stable-diffusion.cpp 与 Draw Things 在 Apple Silicon 上的速度外部调研

日期：2026-07-22

## 结论先行

1. **没有找到可信的 M4 Max 同参直测。** 截至本次检索，两个项目都没有发布在同一台 M4 Max 上，以同一模型、同一权重精度、同一分辨率、同一步数、同一冷/热口径运行的直接横向结果。因此不能负责任地宣称 Draw Things 比 stable-diffusion.cpp（下文简称 sd.cpp）快某个具体倍数。
2. **现有一手证据明显偏向 Draw Things 是 Apple Silicon 上更值得优先验证的速度后端。** Draw Things 发布了自有 Metal FlashAttention、量化 attention、Int8 矩阵乘等 Apple 专用优化及多组端到端数据；sd.cpp 当前官方构建文档仍明确提示 Metal 在超大矩阵上“高度低效”，其 macOS 官方构建任务也没有启用 `SD_METAL`。
3. **这还不是 Krea 2 的直接胜负。** Draw Things 的公开数字主要来自 FLUX.1、Z-Image、FLUX.2、Qwen Image；sd.cpp 也没有 Krea 2 的 M4 Max 官方速度数据。对本项目而言，最终决定必须来自本机 M4 Max 的受控 A/B。
4. **速度与部署能力应分开决策。** Draw Things 更像 Apple 平台的速度候选；sd.cpp 的强项是轻量 C/C++、GGUF、跨平台与易于嵌入。即使 Draw Things 最终更快，也不自动否定 sd.cpp 在 PiD、跨平台或低内存量化任务中的价值。

## 调研口径

核心结论只使用以下一手资料：

- Draw Things 官方发布/工程文章、官方仓库与 release notes；
- sd.cpp 官方仓库文档、构建配置、官方 issue/PR；
- 项目官方 issue/PR 中非维护者提交的数据只记为“项目社区样本”，不用于给出最终倍数；
- Reddit 等站外用户数据单列为 anecdotal，不作为排名核心。

比较数字时必须同时知道模型、精度/量化、分辨率、steps、硬件和冷/热口径。缺任一关键项，就不能视为严格横评。

## Draw Things：官方速度证据

### 1. M4 Pro：FLUX.1 20-step 端到端数据

Draw Things 的 Metal FlashAttention 2.0 文章给出了 FLUX.1 20-step 端到端表。文章说明：M4 Pro（20 GPU cores、24 GiB）上 Draw Things 使用 5-bit，`ComfyUI + gguf` 使用 8-bit；所以这是“实现 + 精度配置”的整体比较，不是同精度比较，更不是 sd.cpp 直测。

| M4 Pro 20c | 768×768 | 1024×1024 | 1280×1280 |
| --- | ---: | ---: | ---: |
| Draw Things，5-bit | 134.59 s | 235.14 s | 389.32 s |
| ComfyUI + GGUF，8-bit | 152.41 s | 303.41 s | 530.68 s |
| 后者/Draw Things | 1.13× | 1.29× | 1.36× |

原始来源：[Metal FlashAttention 2.0 官方文章及其端到端数据表](https://engineering.drawthings.ai/p/metal-flashattention-2-0-pushing-forward-on-device-inference-training-on-apple-silicon-fe8aac1ab23c)、[官方原始表格](https://docs.google.com/spreadsheets/d/1A8xC2_wh_Nwc5p2uvNMnKMtN4kkJac1E764XHrADpBs/edit?usp=sharing)。

同一文章中，M2 Ultra 的 Draw Things 与 `ComfyUI + gguf` 都使用 8-bit：1024×1024 分别为 73.15 s 和 141.60 s，约相差 1.94×。文章据此写出 Draw Things 的 FLUX.1 每步最高比 GGML/GGUF 实现快 94%。但 `ComfyUI + gguf` 不是 sd.cpp，不能把 1.94×直接套到 sd.cpp。

文章同时声称 Metal FlashAttention 2.0 在 M3/M4 上可为 FLUX.1、SD3/AuraFlow 带来最高约 20% 的推理改善。这个百分比是相对 Draw Things 旧实现，不是相对 sd.cpp。

### 2. M4 Pro：Z-Image Turbo 8-step 数据

Draw Things 的 Z-Image Turbo 官方文章提供了更接近现代快速模型的完整数据。图中版本为 Draw Things `v1.20251207.0`，模型为 6-bit 量化、8 steps；但文章没有充分说明第一次还是第二次运行，因此把它视为端到端结果，而不标成严格冷启动或严格热运行。

| M4 Pro 20c | 768×768 | 1024×1024 | 1280×1280 |
| --- | ---: | ---: | ---: |
| 单个 sampling step | 4.331 s | 8.310 s | 13.900 s |
| 8-step 端到端 | 38.359 s | 71.024 s | 117.644 s |

同一官方图中，1024×1024 端到端结果为：Draw Things 71.024 s、mflux 0.13.3 为 88.0 s、LingDong 1.0.4 为 95.69 s。它证明 Draw Things 在该测例中比这两个实现快约 1.24×和 1.35×，但图中没有 sd.cpp。

原始来源：[Draw Things 官方 Z-Image Turbo 性能文章](https://releases.drawthings.ai/p/quantify-z-image-turbo-efficiency)。

### 3. M5 Max：当前官方上限数据，只能证明 Draw Things 自身能力

Draw Things 在 `v1.20260330.0` 为 M5 默认启用 Metal Quantized Attention，并对 8-bit S 模型使用融合 Int8 路径。官方文章给出的 M5 Max 40c 端到端结果包括：

| 模型 | 设置 | M5 Max 40c 端到端 |
| --- | --- | ---: |
| Z-Image Turbo | 1024×1024，8 steps，8-bit S | 9.41 s |
| Qwen Image 2512 | 1024×1024，BF16，30 steps，CFG on | 103.48 s |
| FLUX.2 dev | 1024×1024，28 steps，8-bit S | 137.92 s |
| FLUX.2 klein 4B | 1024×1024，4 steps，8-bit S | 3.12 s |
| FLUX.2 klein 9B | 1024×1024，4 steps，8-bit S | 5.24 s |

文章报告，相对 `v1.20260323.0`，新优化的端到端提升为 1.19×–1.76×，只看 sampling step 为 1.43×–1.95×；其融合动态量化、Int8 matmul、反量化的内核相对 FP16 baseline 快 1.61×–1.87×。

同文还说 M5 Max 相对 M4 Max “out of the box” 测得约 3.3×，但没有给出足以复现的 M4 Max 逐模型绝对表。M5 的 Neural Accelerators 和专属 Int8 路径也不能外推成 M4 Max 上 Draw Things 对 sd.cpp 的倍数。

原始来源：[Metal Quantized Attention 官方文章](https://releases.drawthings.ai/p/metal-quantized-attention-pulling)。

### 4. GPU 与 ANE 边界

- Draw Things 的 M3/M4 核心速度证据来自自研 Metal FlashAttention，即 GPU/Metal 路径；官方工程文档报告在 M3/M4 上最高约 20% 的同实现升级收益。
- `v1.20260410.1` 又把 ANE 作为自有 runtime 内的局部 Int8 matmul accelerator，用于 M3/M4 的 8-bit S 模型。官方称 M4 **最高**可加速 1.8×，但没有发布具体模型、分辨率或 M4 Max 的逐项绝对表，不能把 1.8×当成所有 M4 Max/Krea 2 任务的固定收益。
- 该 ANE 路径要求 macOS/iOS 26 的直接 Int8 array 支持；官方说明在 M5 上 ANE 主要是节能选项，绝对时间反而可能比 GPU 慢。因此必须按芯片代际、模型变体和 Machine Settings 分 lane 测试。
- M5 的 Metal FlashAttention v2.5 Neural Accelerators 首次专门化可能额外花 10 秒以上。官方 M5 基准采用运行两次、取第二次，因此那是 warm/compiled 路径，不能与 sd.cpp 的进程冷启动混比。

来源：[Draw Things 的 ANE 集成官方说明](https://engineering.drawthings.ai/p/making-apple-neural-engine-work-in)、[Draw Things v1.20260410.1 release](https://github.com/drawthingsai/draw-things-community/releases/tag/v1.20260410.1)、[Metal FlashAttention v2.5 官方文章](https://releases.drawthings.ai/p/metal-flashattention-v25-w-neural)。

## sd.cpp：官方速度证据与限制

### 1. 官方目前没有 M4 Max 基准表

本次检查了 sd.cpp 的 README、`docs/performance.md`、`docs/build.md`、release/build workflow，以及包含 M4/M3/M2 的官方 issues/PRs。没有发现维护者发布的 M4 Max 同模型速度表，也没有发现与 Draw Things 的直接横评。

### 2. 官方明确提示 Metal 大矩阵效率问题

sd.cpp 当前构建文档对 Metal 的原话要点是：Metal 可以在 GPU 上运行，但非常大的矩阵操作仍有问题，当前会“highly inefficient”，未来才预期优化。这对 FLUX、Krea 2、Qwen Image 等大 DiT 尤其关键。

来源：[sd.cpp 官方 Metal 构建说明](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/build.md#build-with-metal)。

### 3. 官方 macOS 二进制并未默认启用 Metal

当前 `CMakeLists.txt` 中 `SD_METAL` 默认是 `OFF`；官方 macOS GitHub Actions 构建命令没有传入 `-DSD_METAL=ON`。因此下载官方 macOS release 后不能仅凭“在 Mac 上运行”就认定使用了 GPU，速度测试必须核实日志明确出现 Metal backend；本项目本机的 Metal 版本属于单独构建/分发事实。

来源：[sd.cpp CMake 选项](https://github.com/leejet/stable-diffusion.cpp/blob/master/CMakeLists.txt)、[sd.cpp 官方 macOS 构建 workflow](https://github.com/leejet/stable-diffusion.cpp/blob/master/.github/workflows/build.yml)。

### 4. Flash Attention 在 Metal 上不能默认当作加速开关

sd.cpp 性能文档说明 `--diffusion-fa` 可以显著节省显存，但“对多数 backend 会变慢”，只有 CUDA 通常也会加速；Metal 在支持列表中，但官方没有承诺 Metal 会提速。因此本机测试必须同时跑 FA on/off，不能把省内存等同于更快。

来源：[sd.cpp 官方 performance guide](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/performance.md)。

### 5. 官方仓库中的 Apple 样本，只能作为旁证

- 一个尚未合并的 FLUX.2 klein diffusers-format PR 报告：M3 Max 36 GB，FLUX.2 klein 4B，1024×1024，4 steps，`generate_image` 完成约 159.85 s。该 PR 的目标是格式支持，不是正式 benchmark；未完整注明冷/热、量化和全部 CLI 参数，不能用于排名。来源：[sd.cpp PR #1369](https://github.com/leejet/stable-diffusion.cpp/pull/1369)。
- 一个 2023 年 M2 Max 的问题日志显示：F32 SDXL Turbo、512×512、1 step，模型加载 6.02 s、sampling 2.71 s、VAE decode 4.33 s、总计 7.66 s。但输出是黑图，且代码版本很旧，因此只说明计时项应拆分，不能作为有效速度/质量结果。来源：[sd.cpp issue #128](https://github.com/leejet/stable-diffusion.cpp/issues/128)。
- 2026 年的 M4 Max issue 只是请求说明 Metal 状态，没有基准结果，仍处于 open。来源：[sd.cpp issue #1330](https://github.com/leejet/stable-diffusion.cpp/issues/1330)。

## 是否存在两者直接横向对比

**没有找到可用于决策的直接横评。** 最接近的一手数据是 Draw Things 对 `ComfyUI + gguf` 的 FLUX.1 测试，但 GGUF 是权重格式，`ComfyUI + gguf` 不是 sd.cpp；两者还用了不同量化。它最多说明 Draw Things 的 Apple 专用内核相对一个 GGML/GGUF 路径有明显优势，不能证明相对 sd.cpp 的精确倍数。

站外也没有找到同时满足以下条件的 M4 Max 对照：同一模型文件、同一量化、同一 seed/sampler/scheduler、同一分辨率/steps、两边都确认 Metal、同时报告冷启动与热生成。

## 站外 anecdotal：只做范围感知

Draw Things 社区中有一条相对完整的 M4 Max 样本：MacBook Pro 14-inch、M4 Max 40c、64 GB，SDXL base + refiner（75%）、1024×1024、DPM++ 2M Karras、20 steps，冷却状态约 15.31–15.84 s，热饱和后最慢约 19.60 s；4-step Lightning LoRA 约 7.87–8.00 s。它没有对应的 sd.cpp 同机结果，而且包含 refiner，不能拿来算两者倍数。

来源：[Draw Things 社区 Generation Times 讨论](https://www.reddit.com/r/drawthingsapp/comments/1os74fb)。

## 证据强弱分级

| 结论 | 强度 | 原因 |
| --- | --- | --- |
| Draw Things 在 Apple Silicon 上有持续、专门的 Metal/量化优化 | 强 | 官方工程文、release、内核与多代设备数据一致 |
| sd.cpp 当前 Metal 对大矩阵仍存在效率问题 | 强 | sd.cpp 当前官方构建文档直接说明 |
| 当前 sd.cpp 官方 macOS release 不应默认视为 Metal 版 | 强 | CMake 默认 OFF，官方 workflow 未启用 |
| Draw Things 大概率快于 sd.cpp 跑 Krea 2 | 中等、待本机验证 | 架构证据支持，但没有 Krea 2/M4 Max 同参直测 |
| Draw Things 比 sd.cpp 快 1.5×、2×或其他具体倍数 | 不成立 | 缺少同机同参数据 |
| M5 Max 官方数值可用于估算 M4 Max 绝对时间 | 弱/不应使用 | M5 有 Neural Accelerators 和 M5 专属优化，口径不同 |

## 本机 M4 Max 可执行 A/B 方案

### 测试矩阵

先跑一个双方已成熟支持、容易对齐的控制模型，再跑目标 Krea 2：

1. **控制组：FLUX.2 klein 4B**，1024×1024，4 steps；
2. **目标组：Krea 2 Turbo**，1024×1024，8 steps；
3. 每组分两条精度 lane：
   - `Exact/BF16`：尽量使用同一原始权重，测 runner/内核差异；
   - `Production-fast`：Draw Things 推荐 8-bit/6-bit 变体对 sd.cpp Q8_0。此 lane 测实际产品配置，但必须标成“系统方案比较”，不是纯 runner 比较。

### 固定变量

- 同一 prompt、negative prompt、seed、sampler、scheduler、CFG、宽高、steps、batch=1；
- 不启用 LoRA、ControlNet、preview、upscale、refiner；
- 两边都记录实际加载的模型 SHA-256、量化、应用/commit、macOS 版本；
- sd.cpp 日志必须确认 Metal backend；Draw Things 记录 Exact/6-bit/8-bit S、Metal FlashAttention 和 Machine Settings；
- sd.cpp 的 `--diffusion-fa` 分别跑 on/off；不要先假设其中一个更快；
- 笔记本接电、固定性能模式、关闭其他 GPU 重负载，记录机型是 14/16-inch 还是 Mac Studio，并记录室温与热状态。

### 冷/热与重复次数

每个配置执行：

1. **Cold ×1**：完全退出进程，重新启动，到 PNG 落盘；
2. **Warm-up ×1**：不计入统计，用于 shader/model cache；
3. **Warm ×5**：同一常驻进程连续生成，报告 median、min、max；
4. **Sustained ×10**：观察热降频，报告最后 5 次 median。

Draw Things 与 sd.cpp 都应分别记录：模型加载、文本编码、sampling、VAE decode、保存、端到端 wall time，以及 peak RSS。若某一方只能提供总时间，也要保留外层 wall-clock，不能用一方 sampling-only 对另一方 end-to-end。

### GPU/ANE 核验

- 运行期间采集 GPU 与 ANE 活动/功耗；若 Draw Things 的 8-bit S 触发 ANE，应作为独立 lane，不与纯 GPU Exact lane混写；
- sd.cpp 当前视为 Metal GPU 路径，除非日志和采样明确证明使用 ANE；
- 第一次 shader 编译/专门化时间只算 cold，不混入 warm median。

### 决策门槛

- Draw Things warm median 至少快 **20%**，且输出质量/身份一致性无明显下降：升级为 Apple Krea 2 首选候选；
- 差距小于 20%：优先考虑可编程 API、常驻服务、模型导入可靠性与运维成本；
- sd.cpp 在某个量化 lane 更快：仅路由该模型/精度组合，不外推到所有模型；
- 任一候选必须经过 20 次稳定性、内存峰值、连续队列与真实角色提示集验证，才能从 candidate 变成 replacement。

## 最终建议

外部证据足以支持“**先在 M4 Max 上把 Draw Things 当速度领先候选，与 sd.cpp 做受控 A/B**”，但不足以支持“**Draw Things 已被证明比 sd.cpp 快 N 倍**”。在本机结果出来前：ComfyUI 保留质量/兼容基线；Draw Things 负责 Apple 原生速度候选；sd.cpp 继续承担 GGUF、跨平台和已验证的专用链路。
