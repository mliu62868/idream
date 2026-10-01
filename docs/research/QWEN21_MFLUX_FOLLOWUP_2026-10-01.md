# REDQW21 V2：MFLUX 实测与 Mac 后端核对

日期：2026-10-01。目标是当前 **REDQW21 V2 / Qwen-Image-2.1 指令式参考编辑**，硬件为本项目 M4 Max 128 GiB / macOS 26.5.1。本文包含只读的一手来源核对和随后执行的 GPU 实验。沿用已存在的隔离 MLX runtime、模型和固定源码，没有新增安装或下载大权重。

**已实际跑通完整 MFLUX 2.1 编辑及 BF16 / Q4 / Q8 混合采样。完整 Q8 出图约 81–89 秒；混合 BF16 采样约 44–45 秒，比本轮 Q4 / Q8 快。尚未复现 16 秒。以下采样结果不是完整请求耗时，实验没有替换正式工作流。**

## 本轮实际结果

所有实验均使用同一 REDV2 BF16 diffusion 权重、未合并 Viggle v0.3 六步 r128 / strength 1、CFG 1、832×1216、单参考、seed 42，要求给成年女性加红围巾并保持人物、绿衬衫、白杯与海滩背景。最终 SIGMAS 为 `[1, 0.9675271511, 0.9329053760, 0.8563011885, 0.6651411653, 0.3983554840, 0]`，MLX / native 直接比较通过。

混合实验复用实际 native 社区 ConvRot INT8 编码结果、修复后的原尺寸 VAE 参考 latent、Comfy 噪声与 SIGMAS；MLX 仅加载 diffusion 和 LoRA，FP32 Euler 留在采样器外。每个模型子进程连续执行两遍，下面的“首次 / 重复”不表示清空操作系统文件缓存，也不能等同产品冷 / 热请求。

| 路径 | 六步纯采样，首次 / 同进程重复 | 完整出图 | 实际量化证据 |
| --- | --- | --- | --- |
| 正式 native MPS 基线 | 约 57.6 秒 | 90.47 秒 provider；native 90.07 秒 | 社区 ConvRot INT8 encoder + BF16 diffusion |
| MFLUX hybrid Q8，未编译 | 65.05 / 70.97 秒 | 本项只测 sampler | 228 个 QuantizedLinear，全部 8 bits |
| MFLUX hybrid Q4，未编译 | 48.75 / 53.37 秒 | 本项只测 sampler | 228 个 QuantizedLinear，全部 4 bits |
| MFLUX hybrid BF16，未编译 | 43.73 / 44.95 秒 | 本项只测 sampler | 232 个 Linear，无 QuantizedLinear |
| MFLUX hybrid Q8，编译 target blocks | 50.16 / 57.89 秒 | 本项只测 sampler | 实际 Q8；10 次 compiled target 调用 |
| MFLUX hybrid BF16，编译 target blocks | 49.86 / 49.46 秒 | 本项只测 sampler | 实际 BF16；10 次 compiled target 调用 |
| 完整 MFLUX Q8 编辑 | 68.82 / 78.64 秒 transformer 合计 | 80.89 / 89.24 秒 generate_image；另计一次构造 4.05 秒 | diffusion 228 个 Q8、text/vision 342 个 Q8；VAE 238 个 FP32 tensors |

完整 MFLUX Q8 是另一种编码器量化实验：已有 BF16 Qwen3-VL 转为 MLX affine Q8，**不等于用户指定的社区 ConvRot INT8**。其随机噪声来自 MLX，Euler 更新后回到 BF16，与保留 Comfy 噪声及 FP32 state 的混合 sampler 不构成逐像素对照。两次完整输出的 PNG SHA 相同，人工查看确认红围巾编辑生效，人物、绿衣、杯子与海滩构图保留；没有完成双参考或全面身份保真验收。

完整 Q8 首次编码 4.16 秒、参考 VAE 0.51 秒、采样 68.82 秒、decode 7.35 秒；重复分别约 2.94 / 2.81 / 78.64 / 4.81 秒。原始 `sampling_reported_seconds` 字段来自 upstream `generation_time`（76.17 / 83.46 秒），其读数还包含 decode，**不能用它当纯采样计时**；上表使用同步测得的六次 transformer 合计。MLX peak memory：hybrid Q8 约 13.0 GiB、Q4 9.7 GiB、BF16 19.1 GiB，完整 Q8 29.8 GiB，均为 MLX allocator 口径，非整机内存。

纯 target 整体编译最初在实际 LoRA 下于第 2 步报 `IndexError: unordered_map::at: key not found`，已保存失败记录并回收 child。CPU 小模型复现表明裸 LoRALinear 可编译，而包含时间 / modulation 的 target trace 失败。最终实验把 img_in、time、modulation 与 norm scale 保持 eager 并 materialize，再编译无 eval / append / StepCache 的 32 个 target blocks 和输出；首步 prefix extraction 保持 stock，未改变量化、LoRA、attention 或 scheduler。Q8 与 BF16 的真实最终 normalized latent 均与各自未编译结果逐元素相同。

CPU 数值检查中的 LoRA 两层 / 32 层案例通过且 prefix K/V 不变；无 LoRA 的随机 32 层 Q8 stress case 在一个 timestep 的 relative RMSE 为 0.010073，超过既有 0.01 断言，检查仍返回失败，没有放宽阈值。该边界不被实际固定 LoRA 的 latent 相等结果覆盖，因此本实验不能称为通用无损编译方案。MLX 早期出现过同文报错，但不能据此把当前失败直接归因为已修复的旧版本问题。[MLX 旧 issue 与修复](https://github.com/ml-explore/mlx/pull/2871)

Q8 编译试验连仍走 stock 的首步也比其前一轮基线更快，因此不能把总时长下降全部归因为 compile。随后在同一进程执行 BF16 **stock → compiled → compiled → stock** 交叉对照：42.75 / 44.37 / 45.70 / 56.99 秒。四遍 normalized latent 的 SHA 均为 `46fead1bf263d8e7defa4af23d2ce38cdeecc122db18eb52a932ecf92116b380`，逐元素相同；首步始终未编译，却从 10.82 变到 14.39 秒，证明对照本身存在明显速度漂移。这些数据没有证明可重复的编译加速，因此没有切换生产默认路径。只比较 44.37 与最后的 56.99 秒并宣称加速会遗漏首遍 stock 的 42.75 秒。

所有测量串行持有现有 Gen accelerator lease，产品队列先通过 PM2 wrapper drain / pause，运行前检查三个 native queue 空闲并释放其模型；child 有 600 秒上限，正常及失败退出都等待回收。测试未创建产品 Job、未调用按量 API、未扣 Dreamcoin。随后以 native VAE 解码 Q8 / Q4 / BF16 latent，完整 decode / PNG 下载约 2.52 / 2.02 / 2.02 秒；三张画面均确认红围巾、面部、手持白杯和海滩构图保留，Q4 围巾纹理有变化。这是单个受控样本的目视检查，未证明全面画质等价。正式工作流仍采用 native MPS + 社区 ConvRot INT8 + Viggle 六步。

本轮为受控本地实验，主机其余工作负载未被隔离。取样时主机接 AC 电源、CPU 约 85% idle、空闲内存约 56 GiB；系统已有约 22 GiB swap 使用量，单凭存量不能证明正在换页或解释慢速。不能从这些次数估算稳定生产 P50/P95，也不能把 M5 Pro 的 16 秒直接当同规格结论。

证据目录：`.scratch/qwen21-mflux-followup/`。主要文件为 `capture.json`、`native-baseline*.json`、`q8-stock.json`、`q4-stock.json`、`bf16-stock.json`、`q8-compiled-repaired.json`、`bf16-compiled.json`、对应 `.modules.json` / `-host.json`、`full-q8.json` / `full-q8-0.png`、两份 `*-compile-latent-comparison.json`、CPU `compiled-target-audit.json` 和 `compile-lora-isolation.json`。保留原始失败和未通过断言；没有将研究建议写成生产可用声明。

## 版本事实与新增上游变化

| 对象 | 本次核对的固定版本 | 与当前任务的关系 |
| --- | --- | --- |
| 本地 MFLUX 原型源码 | `83f4d1dee103674da5f2385251e7794cd7285ba5` | 已含真正的 2.1 instruction-edit；源码 manifest 记录 859 个小体积源文件，无权重 |
| MFLUX 当前 main | `b276a6ab0f851c1951a5bae826e41f47fb74da21`，2026-10-01 08:45:54 UTC | 比本地源码多一个提交；改视觉回复缓存与验证，不改普通编辑采样 |
| MFLUX 最新发布 / PyPI | `v.0.20.0` / `0.20.0`，2026-09-21 | 发布的是 2.1 T2I 与 strength-based latent img2img；最新 instruction-edit 在 main，不能直接使用已装 0.20.0 的旧入口 |
| 本地 MLX | `0.32.2` | 本文不因在线文档显示更新版本而替换本地 runtime |

来源：[MFLUX 固定提交](https://github.com/mflux-community/mflux/commit/83f4d1dee103674da5f2385251e7794cd7285ba5)、[新增提交与 diff](https://github.com/mflux-community/mflux/commit/b276a6ab0f851c1951a5bae826e41f47fb74da21)、[0.20.0 发布说明](https://github.com/mflux-community/mflux/releases/tag/v.0.20.0)、[PyPI 版本元数据](https://pypi.org/pypi/mflux/json)。本地固定来源见 `.scratch/qwen21-mlx-prototype/source-manifest.json`。

新提交将 auto-mask、prompt rewriting、verification 使用的贪心视觉回复按指令及图像摘要缓存，并修复验证文本的字段解析、裁剪图片的验证元数据。这些选项关闭时，不会减少普通编辑的六次 transformer 计算。它没有加入编辑编译，也没有解决下文两个已有接线缺口。[固定提交 diff](https://github.com/mflux-community/mflux/commit/b276a6ab0f851c1951a5bae826e41f47fb74da21)

## 必须使用 2.1 的编辑实现

当前入口是 `mflux-generate-qwen-2.1-edit` / `QwenImage21Edit`，不是 `mflux-generate-qwen-edit` / 旧 `QwenImageEdit`，也不是 `mflux-generate-qwen-2.1 --image-path` 的 latent img2img。2.1 编辑加载 Qwen3-VL 的语言与视觉 tower、DeepStack、64 通道 RGBA VAE和新的 block-causal 参考布局；可使用最多十张参考图，并将静态 text/reference K/V 缓存在本次采样内。[2.1 编辑契约](https://github.com/mflux-community/mflux/blob/b276a6ab0f851c1951a5bae826e41f47fb74da21/src/mflux/models/qwen21/reference/README.md)、[实际编辑源码](https://github.com/mflux-community/mflux/blob/b276a6ab0f851c1951a5bae826e41f47fb74da21/src/mflux/models/qwen21/variants/edit/qwen_image_21_edit.py)

模型目录必须包含 `transformer`、`text_encoder`、`vae` 的 config 和权重，以及编辑 processor/tokenizer。T2I 导出的 checkpoint 缺视觉 tower，不能当完整编辑模型。REDV2 单文件不能直接当这个目录传入：须用严格 mapper 保留其权重，并与 2.1 config 配对，校验全部 key/shape，而不是改用官方 base。现有原型已对 REDV2 transformer 297 keys、BF16 encoder 750 keys、VAE 238 keys 做构造期严格核对；这证明可准备本地 checkpoint，尚不证明完整 pipeline 的数值与编辑质量。[上游 initializer](https://github.com/mflux-community/mflux/blob/b276a6ab0f851c1951a5bae826e41f47fb74da21/src/mflux/models/qwen21/qwen_image21_initializer.py)、[本地原型记录](../../.scratch/qwen21-mlx-prototype/README.md)

当前已有两个必要的本地 overlay：

1. **六步 scheduler 参数贯通。** 官方 CLI 校验 `viggle_turbo`，但 `generate_image` 未接收 scheduler，构造 `Config` 时也未传入；`Config` 默认 `linear`。因此仅打印 `--scheduler viggle_turbo` 仍可能实际使用线性节点。现有 overlay 把 CLI → generate → Config 贯通，新提交没有修复这一点。[CLI](https://github.com/mflux-community/mflux/blob/b276a6ab0f851c1951a5bae826e41f47fb74da21/src/mflux/models/qwen21/cli/qwen21_edit_generate.py#L135)、[generate / Config](https://github.com/mflux-community/mflux/blob/b276a6ab0f851c1951a5bae826e41f47fb74da21/src/mflux/models/qwen21/variants/edit/qwen_image_21_edit.py#L46)、[Config 默认值](https://github.com/mflux-community/mflux/blob/b276a6ab0f851c1951a5bae826e41f47fb74da21/src/mflux/models/common/config/config.py)
2. **参考尺寸保持。** 官方按 `output_resolution` 面积预算重采样每张参考，显式输出宽高不会阻止它。与现有 Comfy 原尺寸参考对比时，须使用 overlay 的 `preserve_reference_size=True`，并记录真正进入 VAE 的尺寸。否则采样 token 数、编码条件和编辑难度同时改变。[参考预处理](https://github.com/mflux-community/mflux/blob/b276a6ab0f851c1951a5bae826e41f47fb74da21/src/mflux/models/qwen21/variants/edit/qwen_image_21_edit.py#L108)

本地补丁为 `.scratch/qwen21-mlx-prototype/mflux-edit-fixes.patch`；本次没有修改它。

## 量化与 Viggle v0.3 的兼容边界

完整编辑实现的 `quantize=8` 会量化可量化的 transformer 和 text/vision encoder 层，VAE 则保持 FP32；T2I 的旧“text encoder 保持 BF16”说明不适用于这个新编辑实现。量化会排除 modulation、time embedding、norm_out 和不满足维度条件的层。实际 bits、module 类型和层数必须从已加载对象取证，不能只记录 CLI 参数。[编辑 weight definition](https://github.com/mflux-community/mflux/blob/b276a6ab0f851c1951a5bae826e41f47fb74da21/src/mflux/models/qwen21/weights/qwen_image21_weight_definition.py)、[实际量化代码](https://github.com/mflux-community/mflux/blob/b276a6ab0f851c1951a5bae826e41f47fb74da21/src/mflux/models/common/weights/loading/weight_applier.py)

**MLX affine Q8 与已指定的社区 ConvRot INT8 是不同格式及运算路径。** 现有混合 sampler 保留社区 `qwen3vl_8b_int8_convrot.safetensors`，没有更换编码器。完整 MLX 实验若从 BF16 组件转为 affine Q8，结果须标成“MLX Q8 encoder 实验”，不能称复用了社区 INT8，也不能未经验收替换当前默认配置。官方 loader 没有 ConvRot 文件的直接导入分支。[组件定义](https://github.com/mflux-community/mflux/blob/b276a6ab0f851c1951a5bae826e41f47fb74da21/src/mflux/models/qwen21/weights/qwen_image21_weight_definition.py)、[本地格式与映射核对](../../.scratch/qwen21-mlx-prototype/README.md)

Viggle v0.3 r128 应保持 `rank=alpha=128`、strength 1、未合并，使用 raw sigma `[1, 0.9375, 0.875, 0.75, 0.5, 0.25]`，按实际 target token 数执行一次动态 shift，再追加零，关闭 terminal stretch，CFG 1。不能只把默认步数改成六。作者明确要求未合并；MFLUX 构造默认 `bake_lora=True`，实验必须显式 `bake_lora=False` / `--no-bake-lora`，并核对 454 个 A/B tensors、227 个 target 全部映射。[固定作者配方](https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo/blob/009a44a895ef85f7e643c80fdca9543795248867/README.md#rules-that-matter)、[MFLUX LoRA loader](https://github.com/mflux-community/mflux/blob/b276a6ab0f851c1951a5bae826e41f47fb74da21/src/mflux/models/common/lora/mapping/lora_loader.py)、[2.1 LoRA mappings](https://github.com/mflux-community/mflux/blob/b276a6ab0f851c1951a5bae826e41f47fb74da21/src/mflux/models/qwen21/weights/qwen21_lora_mapping.py)

上游已具备作者六节点的 `ViggleTurboScheduler`；其注释仍写 v0.2.1，但 v0.3 的该组六节点相同。scheduler 存在不等于编辑入口已正确使用，验收应直接保存最终 shifted sigma 数组。[固定 scheduler](https://github.com/mflux-community/mflux/blob/b276a6ab0f851c1951a5bae826e41f47fb74da21/src/mflux/models/qwen21/model/qwen21_scheduler.py)

## 实验选择与实现边界

前轮同机 832×1216 / 单参考 / 六步的混合 sampler Q8 采样约 51.37 秒、Q4 约 50.78 秒，没有优于当时 native 约 41 秒；Q8 fused Q/K 冷请求亦未改善。早期 Q4 未独立记录实际层 bits，本轮已补齐，并实际跑了完整 MLX Q8 pipeline、BF16 diffusion 和 target blocks 编译。前后轮的绝对时长不能直接当加速倍数。[前轮实施证据](QWEN21_MAC_ACCELERATION_IMPLEMENTATION_2026-10-01.md)、[原型与边界](../../.scratch/qwen21-mlx-prototype/README.md)

| 优先级 | 实验 | 固定条件 / 需要证明什么 |
| --- | --- | --- |
| 1 | 混合 sampler Q8 / BF16 未编译与编译对照：已执行 | 社区 INT8、native VAE、原始噪声与作者 SIGMAS 保留；BF16 另完成同进程 ABBA，没有可重复加速证据 |
| 2 | 完整 MFLUX edit，MLX Q8：已执行两遍 | encoder、VAE、sampling、decode、load 分段计时；明确是 MLX affine Q8 encoder |
| 3 | BF16 diffusion：混合路径已执行；完整 BF16 encoder 未执行 | 混合 BF16 较 Q4 / Q8 快，但没有证据要求把社区 INT8 编码器一并换掉 |
| 4 | 实际 Q4：已执行；Q4 编译 / first-block StepCache 未执行 | 当前 BF16 更快，已满足精度对照；没有继续为理论跳步制造额外生成或更改画质 |

官方 `Qwen21Transformer` 的 T2I `_forward` / `_image_forward` 已使用 `mx.compile`，但编辑入口调用 `forward_reference`，其中每层 `mx.eval(x)`，首步还有 `cache.append`，StepCache 读取并修改 Python 状态。**不能直接编译整个现有编辑函数。** [T2I 编译入口和 reference 路径](https://github.com/mflux-community/mflux/blob/b276a6ab0f851c1951a5bae826e41f47fb74da21/src/mflux/models/qwen21/model/qwen21_transformer/qwen21_transformer.py#L181)

最小候选是首步继续原 extract pass，materialize 32 层 K/V；后五步使用没有 eval、append、StepCache 的纯 target 函数，显式传 target、timestep、KV tuple、RoPE / mask，保留未合并 LoRA和外部 FP32 Euler。每个 child 只创建一次 compiled 对象，固定 shape/dtype，按步同步计时。MLX 编译会捕获非参数输入为常量，形状/类型变化可能重新编译；placeholder 不能在函数内 eval。需比较相同输入的未编译 / 编译 noise 或 latent 数值，并将首次 tracing/compilation 纳入冷请求。[MLX 官方编译契约](https://ml-explore.github.io/mlx/build/html/usage/compile.html#pure-functions)

MFLUX 的 T2I fused Q/K prologue 也没有自动用于 reference attention；cached target attention 已用 maskless SDPA。因此不能声称“编辑完全没有 fast attention”，也不能把已经失败的 fused Q/K 与编译收益混成一个变量。[reference attention 与 T2I projection](https://github.com/mflux-community/mflux/blob/b276a6ab0f851c1951a5bae826e41f47fb74da21/src/mflux/models/qwen21/model/qwen21_transformer/qwen21_attention.py#L67)

本轮实际结果未证明稳定的编译加速倍数。完整 MLX 与 PyTorch RNG 不同，同 seed 不会保证同一张图；保留 native noise 的混合实验适合数值比较。当前完整 pipeline 完成单参考局部编辑检查，不能代替多参考与身份保真验收。[上游重现限制](https://github.com/mflux-community/mflux/blob/b276a6ab0f851c1951a5bae826e41f47fb74da21/src/mflux/models/qwen21/reference/README.md#quantized-checkpoints-and-reproducibility)

## 其他 Mac 后端的实际适用性

| 后端 / 固定版本 | 已有明确支持 | 当前 REDV2 + v0.3 的缺口 |
| --- | --- | --- |
| Draw Things `b35f56f95fc009c25cc27c3778b1f8107b956400` | 原生 2.1 多参考、RGBA、固定 prefix / target graph、量化及 separate LoRA | 公开 converter 的 2.1 分支为 `fatalError()`；REDV2 自定义权重导入与作者六 sigma 未验收，不能直接作为现有模型的等价测速 |
| qwen-image-cplus `027bff8c68ddce06cb7fb318c8c79748b68b1f35` | 原生 Metal、十参考、QIPACK、v0.2.1 六步 rank256 sidecar | sidecar 验证固定 r256，与当前 v0.3 r128 不同；需补 REDV2 pack / 精度 / LoRA 契约。本机未运行 |
| stable-diffusion.cpp `3f8527a46c54ecf4cb4ed6003da8e8982283c73c` | 2.1 编辑、重复 `-r`、prefix K/V、社区 safetensors 或 GGUF；项目提供 Metal 构建 | 当前组合的未合并 v0.3 / 作者 sigma / ConvRot 在 Metal 的实际执行与收益仍待核对；不把文档中的 Windows CLI 或 CUDA INT8 优化当 Mac 实测 |
| Core ML port `7ea4838a3ec8c8b97d91d22590b1a2271855a3b3` | 固定 1024² / 最多 64 prompt tokens 的 FP16 T2I | 作者明确未实现编辑与 CFG；现成包不适合本轮图生图，不下载 14.74 GB 包当作可直接替换的后端 |

Draw Things 证据：[2.1 prefix 与 LoRA 验证](https://github.com/drawthingsai/draw-things-community/blob/b35f56f95fc009c25cc27c3778b1f8107b956400/Libraries/SwiftDiffusion/Tests/QwenImage2_1.md#L57)、[公开转换入口](https://github.com/drawthingsai/draw-things-community/blob/b35f56f95fc009c25cc27c3778b1f8107b956400/Apps/ModelConverter/Converter.swift#L160)。这不排除其 App 内部另有 importer，只限定目前可验证的公开接入路径。

qwen-image-cplus 的标题 38–39 秒是 M1 Max **四步 T2I**；固定报告的六步 Eiffel 编辑约 102.3 秒，仍是 v0.2.1。Linux RTX 2060 的较快 W4A4 编辑表不是 Mac 结果。[作者实际模型与硬件](https://github.com/netdur/qwen-image-cplus/blob/027bff8c68ddce06cb7fb318c8c79748b68b1f35/README.md)、[六步编辑与优化报告](https://github.com/netdur/qwen-image-cplus/blob/027bff8c68ddce06cb7fb318c8c79748b68b1f35/docs/performance.md#L300)

stable-diffusion.cpp 的编辑功能与组件格式见 [固定 2.1 文档](https://github.com/leejet/stable-diffusion.cpp/blob/3f8527a46c54ecf4cb4ed6003da8e8982283c73c/docs/qwen_image_2.1.md)，Metal 构建见 [固定主 README](https://github.com/leejet/stable-diffusion.cpp/blob/3f8527a46c54ecf4cb4ed6003da8e8982283c73c/README.md)。这是另一个可做源码/编译核对的候选，尚无当前完整配方的 M4 速度证据。

Core ML 作者的 2.4–2.6 倍比较来自 M5 32 GB，分母为 PyTorch BF16/MPS，计时只含 denoising；完整 40 步约 221–250 秒，未包括 text encoding、loading、prefix。不能把该倍数乘到当前 M4 / 六步参考编辑上，也没有完整 ANE 编辑验收。[作者固定 README 与限制](https://github.com/devin-lai/Qwen-Image-2.1-Coreml/blob/7ea4838a3ec8c8b97d91d22590b1a2271855a3b3/README.md#limitations)

## 验收口径

本轮证据包含固定 source/runtime、模型来源、参考/输出 geometry、encoder 格式、实际层 bits、LoRA 映射与最终 sigma、分段耗时、实际输出与 child 回收记录。新候选只有产生稳定收益后，才继续做真实双参考质量、GPU 中途取消、跨图像/视频内存释放和产品交付验收。接入继续使用 Gen workflow-native backend 与已有 accelerator lease；不恢复退役的 `mlx` / `external` / `pipeline` runner。

既有部署、真实交付及 49.5–85.3 秒冷运行波动见 [正式方案实施记录](QWEN21_MAC_ACCELERATION_IMPLEMENTATION_2026-10-01.md)。MFLUX 本轮结果见顶部；其余后端仍是源码与契约核对，不是本机速度实测。最终服务、队列与临时节点清理检查保存在 `.scratch/qwen21-mflux-followup/runtime-verification.json`。
