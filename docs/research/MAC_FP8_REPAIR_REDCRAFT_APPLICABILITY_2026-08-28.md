# Mac Apple Silicon FP8 修复与 RedCraft 适用性完整调研

日期：2026-08-28
对象：M4 Max / macOS 26.5.1 / PyTorch 2.13 / ComfyUI 0.34.2 / `Krea2RedMix3.0-fp8-scaled-ComfyUI.safetensors`
范围：只审计本机源码、运行时能力与上游一手资料；没有重启 ComfyUI、没有安装依赖、没有运行长生成。

## 结论先行

1. **我们以前做过的 Mac FP8 修复还在，而且当前 RedCraft 确实在用其中最关键的一段。** 当前启动器把 `ASFP8_ENABLE_ONLY` 固定为 `tensor_to_fp8,int_mm_mps`；`tensor_to_fp8` 会把 MPS 上的 FP8 权重字节通过 GPU LUT 解成 BF16，再交给普通 MPS BF16 GEMM。它解决了 “MPS 无法把 Float8 转成 BF16/FP32” 的兼容问题，也保留了 FP8 的权重存储收益；但它**不是 native FP8 乘加**。[启动器](/Users/kk/code/idream/scripts/start-comfyui-idream.cjs:5)；[插件实现](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/custom_nodes/ComfyUI-AppleSilicon-FP8/_patches/tensor_to_fp8.py:121)；[插件原理说明](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/custom_nodes/ComfyUI-AppleSilicon-FP8/README.md:164)

2. **当前这台 M4 Max 能做的是“GPU 解码 FP8 → BF16/FP32，再用 GPU 浮点矩阵乘”；不能做插件所称的 Metal 4.1 native FP8 `matmul2d`。** 本机只有 macOS 26.5.1、SDK 26.5 和 Metal 4.0 语言版本；插件 native FP8 shader 明确使用 `metal_fp8_e4m3_format` 与 MSL 4.1，README 也把门槛写成 macOS 27，实际目标为 M5。M4 支持 Metal 4 API / tensor ops 并不等于具备 M5 才有的每 GPU 核 Neural Accelerator，也不等于当前 SDK 可编译 FP8 tensor format。[native shader](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/custom_nodes/ComfyUI-AppleSilicon-FP8/_patches/fp8_ext/fp8_matmul2d.mm:155)；[插件机器门槛](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/custom_nodes/ComfyUI-AppleSilicon-FP8/README.md:43)；[Apple Metal 可用性](https://developer.apple.com/metal/availability/)；[Apple Metal 4 inline ML](https://developer.apple.com/documentation/metal/running-inline-ml-operations-in-a-shader-with-metal-4)；[Apple WWDC26 Metal 指南](https://developer.apple.com/wwdc26/guides/metal/)

3. **PyTorch 2.13 没有把这个洞补上。** 本机对 `aten::_scaled_mm`、`aten::_scaled_mm_v2`、`aten::_int_mm` 的 MPS dispatch 查询均为 `False`，而 `aten::mm`、`aten::linear` 为 `True`。FP8 在 PyTorch 仍属于 shell/storage dtype；低精度计算需要专用 kernel，PyTorch 的官方低精度 GEMM 设计和支持表也没有列出 MPS FP8。[PyTorch low-precision GEMM RFC](https://github.com/pytorch/pytorch/issues/157950)；[PyTorch FP8 scalar 定义](https://github.com/pytorch/pytorch/blob/main/torch/headeronly/util/Float8_e4m3fn.h)

4. **`ASFP8_ENABLE_ONLY=tensor_to_fp8,int_mm_mps` 确实漏掉了很多补丁，但不能据此直接“全开”。** 它漏掉的有三类：

   - FP8 兼容覆盖：`comfykitchen_fp8`、`scaled_mm_fp8`、`ops_bias_fp8`、`linear_fp8`、`fp8_mps_strided`、`stochastic_round_fp8`；
   - 与 FP8 无关但可能加速 Krea2 的 MPS kernel：`fused_norm_mps`、`rope_fast_mps`、`flash_attn_mtl`；
   - 当前硬件/SDK 不可用的 native FP8：`fp8_linear_kernel_mps` 和 `fp8_ext`。

   当前 RedCraft 的纯推理主链已被 `tensor_to_fp8` 的全局 `.to/.bfloat16` wrapper 托住，所以“漏了”不等于“当前 checkpoint 没跑通”。精确的 Identity Edit full LoRA 也已经生成成功；缺少这些专用补丁意味着对非连续 FP8、raw `F.linear`、其他 comfy-kitchen layout 和 `_scaled_mm` 路径的覆盖不完整，不代表这一个已验证组合失败。[插件补丁总表](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/custom_nodes/ComfyUI-AppleSilicon-FP8/README.md:137)

5. **现在不应加 ComfyUI 的 `--supports-fp8-compute`。** ComfyUI 0.34.2 在非 NVIDIA 平台默认把 FP8 标为 emulated / `_full_precision_mm=True`，因此每层先反量化再做 BF16；强制该开关会让 comfy-kitchen 尝试把每层 activation 从 BF16 量化成 FP8。当前插件的 float→FP8 路径是 **MPS→CPU cast→MPS**，随后 fallback 又把 operands 解回 BF16，容易把每层都变成 CPU 往返，反而更慢。native patch #20 也明确在 `_full_precision_mm=True` 时退出。[ComfyUI FP8 能力判断](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/comfy/model_management.py:1954)；[ComfyUI quant ops 选择](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/comfy/ops.py:1630)；[native patch 的退出条件](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/custom_nodes/ComfyUI-AppleSilicon-FP8/_patches/fp8_linear_kernel_mps.py:159)

## 1. 已核验基线

### 1.1 机器与软件

| 项目 | 本机结果 | 对 FP8 的含义 |
|---|---|---|
| SoC | Apple M4 Max，40-core GPU，128 GB unified memory | 支持 Metal 4；不是 Apple10/M5 Neural Accelerator 代际 |
| 系统 | macOS 26.5.1（25F80） | 低于插件 native FP8 要求的 macOS 27 |
| SDK | Xcode SDK 26.5；只有 `MTLLanguageVersion4_0`，没有 4.1 / `metal_fp8_e4m3_format` | native FP8 shader 当前无法编译 |
| Metal CLI | `xcrun metal --version` 提示未安装独立 Metal Toolchain | 是工具链卫生问题；即使补装，SDK 26.5 缺 MSL 4.1 仍是硬门槛 |
| PyTorch | 2.13.0，git `cf30153c4c131c8164ee7798e5022d810682e2cb` | MPS 可用、`torch.mps.compile_shader` 可用；但无 MPS `_scaled_mm[_v2]` / `_int_mm` |
| ComfyUI | 0.34.2，commit `c645560264062e6a5b0688d25eaf3ee9906a7709` | Krea2 官方 supported compute dtype 仍是 BF16/F16/F32 |
| Apple FP8 插件 | v1.3.1，commit `911294ca35093eef56f7f2695414ff8810e88e50`，worktree clean | 已安装完整；启动时只启用两个 patch |
| 额外依赖 | 有 `comfy-kitchen 0.2.31`；无 `mtlflashattn`、`fp4-fp8-for-torch-mps`、`fp8-mps-metal` | flash patch 当前即使放开也不会加速；旧 FP8 包当前没有参与运行 |

Apple 官方把 M4 列为 Apple9、M5 列为 Apple10；Metal 4 本身支持 M1 及以后，但 Apple 明确把每 GPU core 的 Neural Accelerator 放在 Apple10 及以后。因此“系统显示 Metal 4”只能证明 API 族可用，不能推出 M4 有 M5 native FP8 算力。[Apple GPU family / Metal availability](https://developer.apple.com/metal/availability/)；[Apple inline ML 文档](https://developer.apple.com/documentation/metal/running-inline-ml-operations-in-a-shader-with-metal-4)；[WWDC25 Metal 4](https://developer.apple.com/videos/play/wwdc2025/205/)

### 1.2 RedCraft checkpoint 不是“名字写 FP8”，而是真 FP8-scaled 存储

对 `/Users/kk/ComfyUI-Shared/models/diffusion_models/Krea2RedMix3.0-fp8-scaled-ComfyUI.safetensors` 只读取 safetensors header，得到 942 个 tensors：

- 256 个 `F8_E4M3` 权重；
- 256 个 `F32` `weight_scale`；
- 256 个 `U8` `comfy_quant` 元数据；
- 174 个 BF16 tensors。

因此它是当前 comfy-kitchen `TensorCoreFP8`/scaled-FP8 存储，而不是把 BF16 文件仅改了名字。日志里的 `model weight dtype torch.bfloat16, manual cast torch.bfloat16` 表示 ComfyUI 选择的**计算/手动转换 dtype**，不是说磁盘权重已全部变成 BF16。ComfyUI 0.34.2 对 Krea2 声明的 supported inference dtype 本来也只有 BF16/F16/F32。[Krea2 model config](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/comfy/supported_models.py:1928)；[model dtype 日志来源](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/comfy/model_base.py:170)

## 2. 必须区分的三种“FP8 支持”

### A. FP8 存储兼容

权重在 checkpoint 和内存里保留 8-bit bytes，节省磁盘、加载和常驻权重容量；运行前将其恢复为 BF16/FP32。这里没有 FP8 乘加。这正是当前 RedCraft 的主要收益。

### B. GPU LUT decode → BF16/FP32 GEMM

插件先在 CPU 构建 256 项 “FP8 byte → float” LUT，再将 LUT 放到 MPS；连续 FP8 tensor 在 GPU 上执行 `view(uint8) → long index → LUT gather`，随后调用普通 BF16/float MPS matmul。解码发生在 GPU，不是 CPU；乘加发生在 MPS GPU，但乘加 dtype 是 BF16/FP32，不是 FP8。[LUT 实现](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/custom_nodes/ComfyUI-AppleSilicon-FP8/_patches/_common.py:24)；[插件说明](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/custom_nodes/ComfyUI-AppleSilicon-FP8/README.md:164)

这是当前最实用、最稳定的 Mac FP8 修复，也是 `tensor_to_fp8` 对 RedCraft 起作用的机制。

### C. native FP8 tensor matmul

输入/权重保持 FP8 格式进入 Metal tensor-op kernel，不先展开成 BF16；kernel 直接声明 `metal_fp8_e4m3_format` 并调用 `mpp::tensor_ops::matmul2d`。插件的 `fp8_ext` 和 patch #20 才属于这一类。它需要 MSL 4.1/macOS 27，README 写明 “in practice an M5”；本机当前不具备这一编译与执行条件。[Metal 4.1 FP8 kernel](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/custom_nodes/ComfyUI-AppleSilicon-FP8/_patches/fp8_ext/fp8_matmul2d.mm:155)；[patch #20](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/custom_nodes/ComfyUI-AppleSilicon-FP8/_patches/fp8_linear_kernel_mps.py:1)

“真实 GPU kernel”也要继续细分：旧 `fp4-fp8-for-torch-mps` 的 `fp8_matmul.metal` 确实运行在 GPU，但内部是逐 byte LUT 解码后用 float accumulator 做标量循环；它不是上述 native FP8 tensor operation。[旧包 shader](https://github.com/AppMana/mps-fp8-for-torch-and-comfyui-python-package/blob/v1.0.3/src/fp4_fp8_for_torch_mps/shaders/fp8_matmul.metal)

## 3. 当前 RedCraft 实际执行链

```text
safetensors F8_E4M3 + weight_scale
  -> comfy-kitchen QuantizedTensor（FP8 storage 保留）
  -> ComfyUI 在 MPS 判定 FP8 compute 为 emulated
  -> _full_precision_mm=True
  -> 每层 forward 请求 dequantize / cast 到 BF16
  -> tensor_to_fp8 拦截 FP8 Tensor.to/.bfloat16
  -> MPS 上 LUT gather 解码
  -> MPS BF16 Linear/GEMM
```

ComfyUI 的量化选择代码在 MPS 上关闭 float8 native quant ops，并把 checkpoint 走到 full-precision matmul；mixed precision forward 在 `_full_precision_mm=True` 时每次反量化权重。[quant format 禁用/标记](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/comfy/ops.py:1111)；[mixed precision forward](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/comfy/ops.py:1290)；[op 选择](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/comfy/ops.py:1630)

这也解释了两个看似矛盾的现象：

- 模型“跑通”：因为当前全局 cast patch 正好接住了每层 FP8→BF16；
- 模型“仍慢”：每一步、每一层仍有 FP8 LUT 解码和 BF16 临时权重，Identity Edit 还额外引入参考图/身份 token 的 attention 开销；没有 native FP8 GEMM。

## 4. 插件逐项分类：哪些是 native，哪些只是兼容

| patch / 模块 | 实际工作 | 计算位置 | native FP8? | 当前 RedCraft / M4 判断 |
|---|---|---|---|---|
| `tensor_to_fp8` | 包装 `.to/.float/.half/.bfloat16`；FP8→float 走 LUT；float→FP8 走 CPU | decode 在 MPS；quant cast 在 CPU | 否 | **已启用，当前主兼容链关键** |
| `_common.decode_fp8` | 256 项 LUT + GPU gather | MPS GPU | 否 | 当前主 decode primitive |
| `comfykitchen_fp8` | per-tensor FP8 decode 走 GPU LUT；FP8 quant 走 CPU；NVFP4/MXFP8 block-scale dequant/部分排列整段走 CPU | 混合 | 否 | 未启用；扩大格式覆盖；full LoRA/重重量化更相关 |
| `scaled_mm_fp8` fallback | 两边 FP8 都先 LUT 解成 BF16，再 `a @ b`；应用 scales/bias | MPS GPU | 否 | 未启用；当前 `_full_precision_mm` 路径通常到不了 `_scaled_mm` |
| `ops_bias_fp8` | FP8 weight/bias 先 decode，再普通 Linear | MPS GPU | 否 | 未启用；保护 raw/manual_cast FP8 线性层 |
| `linear_fp8` | 包装 `F.linear`，FP8 operands 先 decode | MPS GPU | 否 | 未启用；保护绕过 comfy ops 的节点 |
| `stochastic_round_fp8` | LoRA 合并后 float weight 重新 cast FP8 | **CPU round-trip** | 否 | 未启用；补齐其他重重量化 seam；当前 full LoRA 已由通用 `tensor_to_fp8` fallback 跑通 |
| `fp8_mps_strided` | non-contiguous FP8 reshape/clone/contiguous | **CPU 数据重排** | 否 | 未启用；NVFP4/MXFP8/某些 LoRA 与低显存流送相关 |
| `int_mm_mps` | int8 operands 转 FP32 后在 MPS 做 `@`，避开 CPU fallback | MPS GPU FP32 | 否；也不是真 int8 MMA | 已启用，但对当前 FP8 RedCraft 主 DiT 基本无直接收益 |
| `fp8_ext` / `scaled_mm` native backend | FP8×FP8 Metal 4.1 `matmul2d` | Metal GPU tensor ops | **是** | 当前 M4/macOS26/SDK26 不可用 |
| `fp8_linear_kernel_mps` | half activation × FP8 weight，native kernel，省去权重 decode | Metal GPU tensor ops | **是** | 当前不可用；且 `_full_precision_mm=True` 时主动退出 |
| `fused_norm_mps` | RMSNorm/modulation/residual 融合 `compile_shader` | Metal GPU | 非 FP8 kernel | M4 可用；是否命中 Krea2 需 trace 验证 |
| `rope_fast_mps` | RoPE 元素操作融合 `compile_shader` | Metal GPU | 非 FP8 kernel | M4 可用；可能减少 dispatch，需 Krea2 trace/A-B |
| `flash_attn_mtl` | `mtlflashattn` Metal attention | Metal GPU | 非 FP8 kernel | 理论上 M4 可走兼容 kernel；当前 venv 缺依赖，现状无效 |
| `conv_im2col_mps` | conv→im2col→Metal tensor matmul | Metal GPU | 非 FP8 kernel | native 路径门槛高且主要针对 VAE/conv3d，不是 Krea2 DiT FP8 主问题 |
| native int8/int4 ext | 真 INT8/INT4 Metal quant kernel | Metal GPU tensor ops | 否，是其他量化格式 | 与 RedCraft FP8 checkpoint 无关 |

分类直接对应插件 README 的补丁表和源码；不能把“代码由 Metal GPU 执行”统称为“native FP8”。[补丁表](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/custom_nodes/ComfyUI-AppleSilicon-FP8/README.md:139)；[FP8 caveats](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/custom_nodes/ComfyUI-AppleSilicon-FP8/README.md:225)

## 5. `ASFP8_ENABLE_ONLY` 到底漏了什么

当前 `/Users/kk/code/idream/scripts/start-comfyui-idream.cjs` 的默认值是：

```text
ASFP8_ENABLE_ONLY=tensor_to_fp8,int_mm_mps
```

运行日志确认插件仍执行了启动前的 allocator watermark 设置，但正式 patch 安装阶段跳过了其余模块。因此这是**人为收窄后的运行配置**，不是插件完整默认能力。[启动器配置](/Users/kk/code/idream/scripts/start-comfyui-idream.cjs:5)

收窄不是无故发生：同一 RedGraft LTX 2.5 checkpoint/workflow/seed 的现场 A/B 中，插件默认全开、关掉 mtlflash、以及全开加 split attention 都发生 stage 2 画面塌缩；只有 `tensor_to_fp8,int_mm_mps + split attention` 恢复 121 帧完整视频。该实验只把责任边界缩到“额外全局 patch 集合”，没有逐项定位某一个罪魁；因此它支持拆分 image/video runner，不支持把所有补丁永久判死。[现场诊断](/Users/kk/code/idream/.tmp/redgraft-ltx25-research/diagnosis.md:9)

### 5.1 对当前 RedCraft 纯推理：漏了冗余保护和潜在优化，但没漏掉跑通所需的核心 cast

RedCraft 当前由 comfy-kitchen 保留 FP8 storage，ComfyUI 请求 BF16 dequant；全局 `tensor_to_fp8` 能拦截 `.to(bfloat16)`。所以 checkpoint 已跑通并不奇怪。`comfykitchen_fp8` 是更靠近权威 seam 的专用修补，`ops_bias_fp8`/`linear_fp8` 则覆盖 raw FP8 与绕过 comfy ops 的其他节点；它们能增强鲁棒性，但不应被宣传为能把当前 matmul 改成 FP8 native。

### 5.2 对当前 Identity Edit full LoRA：已经跑通，且不是每步动态 LoRA

header 实查得到：base checkpoint 有 256 个 `comfy_quant` FP8 Linear；full LoRA 有 256 组 A/B tensors，目标集合与 base 量化层交集为 `256/256`。当前日志又显示模型 `loaded completely ... 12532.86 MB loaded, full load: True`。因此 Comfy 在加载阶段逐层执行 FP8 dequant、LoRA delta 合并，再由 `MixedPrecisionOps.Linear.set_weight()` 重新量化回原 layout；加载完成后 `weight_function` 不再是每步热路径。[Comfy 完整加载与 patch](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/comfy/model_patcher.py:899)；[重新量化](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/comfy/ops.py:1433)

这条 exact full-LoRA 路径已经完成 1-step 与 12-step 真实生成，所以当前 `tensor_to_fp8` 通用 float→FP8 fallback 足以让它运行。`stochastic_round_fp8`、`comfykitchen_fp8`、`fp8_mps_strided` 仍有扩大兼容面的价值，但不能把“没有启用专用 wrapper”误写成当前 full LoRA 未跑通。

full-load LoRA 的 float→FP8 CPU 往返主要增加**加载/合并时间**，不应被算成每步采样开销。当前每个 forward 都 decode 已合并 FP8 权重的直接原因，是 ComfyUI 在 MPS 上 `supports_fp8_compute=false`，从而将量化层置为 `_full_precision_mm=True`。若想消除采样期 decode，要比较 BF16 merged checkpoint 或真正可用的 native FP8 kernel，而不是优化 LoRA 重量化。

### 5.3 漏掉的 speed patch 不等于都应该打开

- `fused_norm_mps`、`rope_fast_mps` 在 M4 上可以编译，属于真正 GPU fused kernel，值得做短 A/B；但它们不是 FP8 修复，必须用实际 Krea2 trace 证明 seam 命中。
- `flash_attn_mtl` 当前 venv 没有 `mtlflashattn`，仅把名字加到 ENABLE_ONLY 不会产生加速。
- `te_device_mps` 在旧 ComfyUI 修复“text encoder 被放 CPU”；当前 ComfyUI 0.34.2 的 `text_encoder_initial_device()` 已对 MPS 做特殊处理，且现有日志已经显示 Krea text encoder load device 为 MPS，因此这项很可能已冗余。[当前 ComfyUI device 选择](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/comfy/model_management.py:1190)
- `fp8_linear_kernel_mps` 当前硬件/SDK 不可用，加入列表只会 capability probe 后保持 inert，不能解决速度。

## 6. 为什么不能靠 `--supports-fp8-compute` 强行进入 FP8

ComfyUI 的 `supports_fp8_compute()` 不是“checkpoint 能不能加载”，而是“后端能不能把 FP8 当 compute dtype 做相关 quantized forward”。在当前版本，非 NVIDIA 默认返回 false，除非用户用 CLI 全局 override。随后量化 loader 将 FP8 标为 emulated，并设置 `_full_precision_mm=True`。[能力判断](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/comfy/model_management.py:1954)；[operations 选择](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/comfy/ops.py:1630)

若当前 M4 强制打开，链路很可能变为：

```text
BF16 activation
  -> 每层 quantize FP8（MPS 不支持 cast，插件走 CPU）
  -> FP8 activation 回 MPS
  -> scaled_mm fallback 把 activation 和 weight 再 LUT decode 成 BF16
  -> BF16 matmul
```

即 “MPS→CPU→MPS 的 activation 量化 + GPU 反解 + BF16 matmul”。这比直接 BF16 activation × 解码权重多做了工作，而且 patch #20 真 native half×FP8 weight 的前置条件又不成立。插件 README 所说的“自动安装全部 patch”并不会自动改变 ComfyUI 0.34.2 的 `_full_precision_mm` 决策，这是两个独立 seam；这是依据两边源码得出的集成结论，不是猜测。

## 7. 以前的 `fp4-fp8-for-torch-mps` 修复，需要重新定性

我们以前测试过 `fp4-fp8-for-torch-mps` v1.0.3。它确实注册了 MPS `_scaled_mm`、`mm`、`matmul`、`addmm`、`linear`、`_to_copy` 等实现，并用 `torch.mps.compile_shader` 执行 Metal shader；它还实现了 MPS 上的 float→FP8 encode 和 FP8→float decode，这一点比当前插件的 float→FP8 CPU fallback 更完整。[旧包 ops 注册](https://github.com/AppMana/mps-fp8-for-torch-and-comfyui-python-package/blob/v1.0.3/src/fp4_fp8_for_torch_mps/ops.py)；[旧包 MPS 实现](https://github.com/AppMana/mps-fp8-for-torch-and-comfyui-python-package/blob/v1.0.3/src/fp4_fp8_for_torch_mps/fp8_mps_native.py)

旧方案的端到端数据也支持这一定性：Qwen plain-FP8 相对 BF16 widening，常驻 RSS `14.95→11.02 GB`、冷启 `128.47→84.20s`，但热跑 `72.24→76.23s`（慢 5.5%），输出 RMSE 为 0。它证明 FP8 storage 可以省内存/冷加载，不证明 Mac FP8 compute 更快。同期 RedCraft scaled-FP8 的 `125.24s/140.13s` 只是普通 T2I；没有 Identity Edit reference tokens、full LoRA 或当前 12-step 工作量。[历史实测](/Users/kk/code/idream/docs/research/QWEN_FP8_ON_APPLE_MPS_LANDED_2026-07-29.md:39)

但源码审计后应纠正一个容易误导的叫法：旧包的 `fp8_matmul.metal` 是**GPU 上的软件模拟 FP8 matmul**，逐字节 LUT decode，再用普通 float 累加；没有 Metal 4.1 FP8 datatype，也没有 `mpp::tensor_ops::matmul2d`。所以它是“真 Metal GPU kernel”，却不是“native FP8 hardware kernel”。[旧包 shader](https://github.com/AppMana/mps-fp8-for-torch-and-comfyui-python-package/blob/v1.0.3/src/fp4_fp8_for_torch_mps/shaders/fp8_matmul.metal)

当前 venv 已没有这个包。**不建议把它和 ComfyUI-AppleSilicon-FP8 同时装回**：两者会覆盖相同 PyTorch/aten/Python dispatch seams，生效顺序脆弱；旧包 scalar FP8 matmul 也不会自动快过当前 BF16 MPS GEMM。若未来确实需要 full LoRA 的高频 on-device float→FP8，应该把“GPU encode primitive”作为隔离实验审计，而不是把整个旧包重新叠加到生产 runner。

## 8. M4 Max / Metal 4 能用什么

| 能力 | 当前 M4 Max + macOS 26 | 条件/说明 |
|---|---|---|
| FP8 tensor 作为 bytes 移到 MPS | 可 | 只代表 storage 可驻留 |
| FP8→BF16/FP32 GPU LUT decode | 可 | 当前已用 |
| BF16/F16/FP32 MPS GEMM | 可 | 当前实际乘加路径 |
| float→FP8 原生 MPS cast | 不可 | 当前插件走 CPU；旧包可用软件 Metal encode |
| `torch._scaled_mm` MPS kernel | 不可 | PyTorch 2.13 dispatch 无注册 |
| `torch._int_mm` MPS kernel | 不可 | 当前 patch 转 FP32 matmul |
| `torch.mps.compile_shader` fused norm / RoPE | 可 | 与 native FP8 无关 |
| Metal flash attention | 条件可 | 先安装并验证 `mtlflashattn`；当前缺依赖 |
| Metal 4.0 INT8/INT4 tensor-op extension | 源码门槛可能满足一部分 | 不是 RedCraft FP8；插件 README 的实测目标仍偏 M5，需独立 build/self-check |
| Metal 4.1 native FP8 tensor op | **不可** | 需要 macOS/SDK 27；插件称实际为 M5 |

Apple 官方对版本演进的表述也支持这个边界：26 代加入 4/8-bit integer 等能力，27 代再增加更多 tensor datatypes / quantized formats；M5 系列才引入新的 Neural Accelerator 路径。[WWDC26 custom ML](https://developer.apple.com/videos/play/wwdc2026/330/)；[WWDC26 Metal guide](https://developer.apple.com/wwdc26/guides/metal/)；[Metal feature set tables](https://developer.apple.com/metal/Metal-Feature-Set-Tables.pdf)

## 9. 插件版本、git 历史和 benchmark 能证明什么

本机插件 worktree clean，位于 commit `911294c` / v1.3.1。与本问题直接相关的最近历史包括：

- `53f4d84`：同时包装 PyTorch 新的 `F.scaled_mm` / `aten::_scaled_mm_v2` seam；
- `3b93b9e`：补齐 `.float/.half/.bfloat16`，因为这些 shortcut 不一定走 `.to()`；
- `cf48f66`：加入 Metal 4.0 INT8/INT4 library；
- v1.3.0/v1.3.1：native kernels 与后续修正。

插件内有 synthetic native matmul benchmark 和 self-check，native FP8 的历史结果主要来自 macOS 27 / M5 环境；README 报告 native FP8 相对 LUT-decode + BF16 的约 1.2–2.1× 局部 GEMM 改善。它们证明 kernel 在作者目标环境可工作，**不能外推成 M4 当前可用，也不能外推成 Krea2 Identity Edit 全链同等加速**。[版本仓库](https://github.com/pawel-mazurkiewicz/ComfyUI-AppleSilicon-FP8/tree/911294ca35093eef56f7f2695414ff8810e88e50)；[scaled_mm v2 修复 commit](https://github.com/pawel-mazurkiewicz/ComfyUI-AppleSilicon-FP8/commit/53f4d84)；[native benchmark](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/custom_nodes/ComfyUI-AppleSilicon-FP8/tests/bench_fp8_native_matmul.py:1)

本次没有跑长 native benchmark，但直接触发了插件真实 extension build seam。构建在 5.25 秒内失败，三处均为 `use of undeclared identifier 'MTLLanguageVersion4_1'`，返回 `module_built=False`；这比 capability banner 更直接地证明当前 SDK 无法编译 native FP8 kernel。插件的 capability/LUT/scaled-mm/linear 定点测试为 `72 passed, 2 skipped`。

## 10. 对 RedCraft FP8 + Krea2 Identity Edit 的行动建议

### 现在应保持

1. **保留 FP8 checkpoint + BF16 compute**。这台 M4 当前最合理的收益是减小权重存储/常驻体积；BF16 GEMM 是快路径。
2. **不要增加 `--supports-fp8-compute`**，否则 activation quantize 很可能引入每层 CPU 往返。
3. **不要把旧 `fp4-fp8-for-torch-mps` 直接与现插件叠装**。
4. 把“模型跑通”准确表述为：**RedCraft scaled-FP8 storage 已经跑通；FP8→BF16 在 MPS GPU LUT 解码；compute 是 BF16，不是 native FP8。**

### 可以做的最小受控实验（本报告没有执行）

1. 建一个 **Krea2 image 专用隔离 runner**，仍保持 `--supports-fp8-compute` 关闭、`ASFP8_FP8_EXT=off`、`ASFP8_FP8_NATIVE=off`；显式逐项 A/B `comfykitchen_fp8`、`ops_bias_fp8`、`linear_fp8`、`fp8_mps_strided`、`stochastic_round_fp8`，不要直接全开。用一次 1-step、固定 latent/像素对比和 op trace 验证命中。LTX video runner 继续保持已验证的最小 patch 集。
2. 若要消除采样期 256 层权重 decode，做“当前已合并并重新量化的 FP8”与“离线 BF16 merged”固定 seed A/B；记录 load/sample/decode、峰值 unified memory 和身份质量。BF16 候选不保证与 FP8 逐像素一致。
3. Identity Edit 的优先速度线仍是 attention backend。隔离实测已经证明 `--use-pytorch-cross-attention` 可从后段约 `50s/step` 降至约 `30–34s/step`；先做身份质量回归，再考虑为独立 runner 安装 `mtlflashattn` 作为下一层实验。
4. 真正 native FP8 只在升级到 macOS/Xcode/Metal 4.1 后重新 probe；仍需实际硬件 kernel self-check。若 M4 即使新系统能编译但性能/功能探测失败，就接受 fallback；不要绕过 capability gate。
5. 若内存和磁盘允许，可离线转换/取得 RedCraft BF16 checkpoint 做对照。它会牺牲 FP8 存储优势并可能与原 FP8 输出不同，但能去掉每层 LUT decode；这是当前 M4 上最可能真正改善 DiT GEMM 前处理的 FP8 相关 A/B。

## 最终判断

我们之前的 Mac FP8 修复**没有丢**；当前模型也确实借它跑通了。问题在于它一直是“让 MPS 能消费 FP8 权重”的兼容层，而不是把 M4 变成有 native FP8 tensor cores 的修复。

当前 ENABLE_ONLY 对共享多模型 runner 很保守，但 exact RedCraft + full Identity LoRA 已跑通；问题不是“缺补丁所以不能运行”，而是每层仍走 emulated FP8 decode，并且为了 LTX 正确性关掉了潜在的 MPS 优化。简单全开或强制 FP8 compute 都不是正确解法。对当前 M4 Max，合理架构仍是：**FP8 做存储，GPU LUT 做解码，BF16 做矩阵乘；image/video 使用不同受控 patch profile；把 attention 与 fused elementwise 优化作为速度主线。**
