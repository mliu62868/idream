# Qwen Image FP8 / INT8 在 Apple MPS 上的运行边界

日期：2026-07-24  
范围：Qwen Image / Image Edit，尤其是 Rapid-AIO v23 FP8；只评估运行与转换能力，不改变 iDream 生产路由。

## 结论

1. **FP8 不能直接跑，不只是 ComfyUI 少一个开关。** ComfyUI 已能识别 FP8 权重和 FP8 参数，但 PyTorch MPS 当前没有 Float8 dtype / compute 路径。FP8 tensor 移到 MPS 会直接报 `TypeError`；ComfyUI 源码也明确对 MPS 关闭 FP8 cast/compute。
2. **把 FP8 转成 INT8，并不会自动解决。** Comfy 的 TensorWise INT8 / ConvRot eager 路径最终调用 `torch.int8_mm` 或 `torch._int_mm`；PyTorch 当前只为 `_int_mm` 注册 CPU、CUDA、XPU，没有 MPS dispatch。INT8 文件“能加载”不等于能在 Apple GPU 上执行。
3. **CPU fallback 不是可用加速方案。** 本机 ComfyUI 0.28 / PyTorch 2.10 probe 同时复现了 FP8 move-to-MPS `TypeError` 和 `_int_mm` 无 MPS kernel；同一轮算子级微基准里，CPU fallback 约比 BF16 MPS 慢 `757×`。这是微基准而非端到端出图倍数，但已足以排除生产使用。
4. **当前可靠路径仍是离线恢复到 BF16/FP16，再用 MPS 计算。** 这会得到可运行性，但不会保留 FP8/INT8 的显存、带宽或矩阵乘加速收益。
5. **社区已有 Apple 原生低位宽路线，但它们是独立运行时。** MFLUX/MLX、stable-diffusion.cpp/Metal、Draw Things 都值得独立 A/B；它们的量化格式不是 Comfy FP8 或 INT8 ConvRot，Rapid-AIO v23 也不能靠改扩展名直接复用。

## 不同“支持”的严格区分

| 路径 | 能否处理权重 | Apple 上实际计算 | 对 Rapid-AIO v23 的判断 |
|---|---|---|---|
| ComfyUI 原生 FP8 | 能识别/加载部分 FP8 格式 | **不能原生 MPS FP8** | 当前不可直接跑 |
| CPU 解量化 FP8 → BF16 | 能，plain FP8 可 widening cast；scaled FP8 需应用 scale | BF16 在 MPS 计算 | 可行的兼容路线；v23 本身尚未验证 |
| Comfy INT8 TensorWise / ConvRot | loader、metadata、量化工具已存在 | **不能原生 MPS INT8 matmul**；卡在 `_int_mm` | 不能因为能转换就认为可跑 |
| ComfyUI-GGUF | GGUF 权重按层/按需解量化 | 通常以 FP16/BF16 linear 在 MPS 算 | 主要省存储/驻留内存；不是 MPS INT8 GEMM |
| SDNQ / Optimum Quanto | 可保存量化权重并用 eager fallback | MPS 多为解量化后计算；加速 matmul 主要面向 CUDA 等后端 | 可研究内存收益，不应预报速度收益 |
| Nunchaku | 支持 Qwen Image/Edit 4-bit | CUDA extension，无 macOS arm64/MPS 后端 | 当前 Mac 不可用 |
| TorchAO | 有稳定的 CUDA/XPU 量化路径，也有实验性 Apple 低位宽 kernel | Apple kernel 仍是实验、有限位宽的 weight-only 路线 | 不是 Comfy/Qwen Edit/ConvRot 的即插即用 backend |
| stable-diffusion.cpp | 支持 Qwen Image/Edit、GGUF、Metal | 独立的 GGML/GGUF + Metal 路径 | 强候选；需要正确的 split/GGUF 模型转换与独立 workflow |
| MFLUX / MLX | 支持 Qwen Image/Edit 与 3–8 bit MLX 量化 | Apple 原生 MLX 量化运行时 | 当前最现实的 Mac 8-bit 候选之一；不能直读 Comfy AIO |
| Draw Things | 支持 Qwen Image/Edit 及自有 6/8-bit 变体 | 自有 Metal/Apple 优化运行时 | 可独立验证；Q8P/I8X 不等于 Comfy INT8 ConvRot |

### FP8 native MPS

PyTorch MPS 的 dtype 映射当前没有 Float8；ComfyUI 当前 `supports_cast()` 在检查 Float8 之前就对 MPS 返回 `False`，`supports_fp8_compute()` 也只认可受支持的 NVIDIA 设备。`--fp8_e4m3fn-unet` 等 CLI 参数证明的是 ComfyUI 有 FP8 loader/storage 逻辑，不证明 Apple GPU 能计算 FP8。

来源：

- [PyTorch MPS dtype mapping](https://github.com/pytorch/pytorch/blob/9214bab82ff483d1795d45a33670a474d255d832/aten/src/ATen/native/mps/OperationUtils.mm)
- [ComfyUI model management](https://github.com/Comfy-Org/ComfyUI/blob/45ffd5430beeccf63682b5f8b569faad45fd60e1/comfy/model_management.py#L1239-L1254)
- [ComfyUI FP8 compute gating](https://github.com/Comfy-Org/ComfyUI/blob/45ffd5430beeccf63682b5f8b569faad45fd60e1/comfy/model_management.py#L1870-L1892)
- [ComfyUI 官方 MPS FP8 discussion #13273](https://github.com/Comfy-Org/ComfyUI/discussions/13273)

### CPU dequant workaround

FP8 可以先在 CPU 上恢复为 BF16：

- plain FP8：Float8 tensor widening cast 为 BF16；
- scaled FP8：先按 checkpoint 的 scale/metadata 解量化，再存成 BF16；
- 之后模型以 BF16 在 MPS 上执行。

这属于**离线格式恢复**，不是 FP8 MPS。运行时逐层 CPU fallback 会产生设备搬运与 CPU 算力瓶颈，本机微基准已显示它不适合作为 serving 路径。

### INT8 ConvRot MPS

ComfyUI / comfy-kitchen 已实现 TensorWise INT8、ConvRot metadata 和 CUDA 快速路径，但：

- `supports_fast_matmul()` 以 CUDA capability（最低 SM 7.5）为条件；
- eager INT8 会量化 activation，然后调用 `torch.int8_mm` / `torch._int_mm`；
- PyTorch `_int_mm` dispatch 当前只有 CPU、CUDA、XPU。

因此升级 ComfyUI 或仅做 `FP8 → INT8` 都不能补出 MPS kernel。ConvRot 还包含 scale、group size、Hadamard rotation 和布局 metadata，不能用普通 dtype cast 正确转换；若离线逆旋转并还原 BF16，得到的仍是 BF16 路径。

来源：

- [comfy-kitchen TensorWise INT8 layout](https://github.com/Comfy-Org/comfy-kitchen/blob/44a5b94a027e054beecfe425f42dc9552367ea0a/comfy_kitchen/tensor/int8.py#L46-L65)
- [comfy-kitchen eager `_int_mm` path](https://github.com/Comfy-Org/comfy-kitchen/blob/44a5b94a027e054beecfe425f42dc9552367ea0a/comfy_kitchen/backends/eager/quantization.py#L748-L753)
- [PyTorch `_int_mm` dispatch](https://github.com/pytorch/pytorch/blob/9214bab82ff483d1795d45a33670a474d255d832/aten/src/ATen/native/native_functions.yaml#L4168-L4178)
- [Comfy 官方 comfy-quants](https://github.com/Comfy-Org/comfy-quants)

### GGUF on-the-fly dequant

ComfyUI-GGUF 的核心价值是以 GGUF 低位宽存储权重，并在使用时解量化到目标 dtype 再做 linear。它可以明显降低模型文件和部分驻留内存，但这不是 PyTorch MPS 的 INT8/FP8 matrix multiply；是否更快必须实测，逐层解量化也可能增加开销。

来源：[ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF/tree/6ea2651e7df66d7585f6ffee804b20e92fb38b8a)、[dequant implementation](https://github.com/city96/ComfyUI-GGUF/blob/6ea2651e7df66d7585f6ffee804b20e92fb38b8a/dequant.py)、[Qwen Edit compatibility issue #317](https://github.com/city96/ComfyUI-GGUF/issues/317)。

### stable-diffusion.cpp / Metal 与其他社区路线

- **stable-diffusion.cpp** 已正式支持 Qwen Image/Edit、GGUF 与 Metal。它是独立 Apple-native runner；需要匹配的组件、GGUF 转换和 Qwen-specific 参数，不能把 Rapid-AIO safetensors 改名后使用。它比 ComfyUI-GGUF 更接近“独立 GGUF/Metal 执行”，但速度与质量仍须本机同参 A/B。
- **MFLUX** 已支持 Qwen Image/Edit 和量化缓存，使用 MLX 原生运行。其输入期望 Hugging Face/diffusers 组件目录，不是 Phr00t Comfy AIO single-file。
- **Draw Things** 已支持 Qwen Image/Edit 和自有低位宽模型。它的 Q8P、8-bit S/I8X 是 Draw Things codec/runtime，不是 Comfy ConvRot。
- **Nunchaku** 的 Qwen 4-bit 是 CUDA 路线，不支持当前 Mac/MPS。

来源：

- [stable-diffusion.cpp Qwen Image Edit](https://github.com/leejet/stable-diffusion.cpp/blob/87a01773be23b996e38217a6a574c2de08ac560f/docs/qwen_image_edit.md)
- [stable-diffusion.cpp Metal build](https://github.com/leejet/stable-diffusion.cpp/blob/87a01773be23b996e38217a6a574c2de08ac560f/docs/build.md)
- [MFLUX Qwen](https://github.com/filipstrand/mflux/blob/97ac5e6280e8c65e48a609722229eb9d03ef2cbe/src/mflux/models/qwen/README.md)
- [Draw Things Qwen support](https://releases.drawthings.ai/p/introducing-qwen-image-support)
- [Draw Things Qwen edge optimization](https://engineering.drawthings.ai/p/optimizing-qwen-image-for-edge-devices)
- [Nunchaku](https://github.com/nunchaku-ai/nunchaku/tree/8f41840596bd516d434a1f88ac16c86fdb64e74f)

## iDream：已实现、已验证与仅设计

| 项目状态 | 事实 |
|---|---|
| **已实现** | `packages/gen/scripts/dequant_fp8_to_bf16.py` 同时处理 scaled FP8 与 plain FP8，并断言输出不再含 FP8 tensor |
| **已实现并在正式 workflow 使用** | Qwen Rapid-AIO v19 的 BF16 checkpoint 已被 `qwen-image-edit-img2img.json` 引用 |
| **已在 MPS 实图验证** | Qwen Rapid-AIO v19 plain-FP8 → BF16 的 t2i/edit；RedCraft scaled-FP8 → BF16 也已跑通，但 RedCraft 是 Krea2，不能替代 v23 验证 |
| **已有 backend seam** | `packages/gen` 有 ComfyUI、sd.cpp、可选 Draw Things adapter；sd.cpp 的 PiD 与 Draw Things 的 Krea2 候选实验不能外推成 Qwen v23 支持 |
| **尚未实现/验证** | Rapid-AIO v23 的文件布局检查、BF16 转换、实图质量、INT8 ConvRot、ComfyUI-GGUF、MFLUX Qwen Edit、sd.cpp Qwen Edit、Draw Things Qwen Edit |
| **不应声称已完成** | “v23 已能以 FP8/INT8 在 MPS 加速”“把 v23 转 INT8 即可接现有 workflow”“社区 loader 支持等于 iDream 已支持” |

本地证据：

- [`dequant_fp8_to_bf16.py`](../../packages/gen/scripts/dequant_fp8_to_bf16.py)
- [`qwen-image-edit-img2img.json`](../../packages/gen/workflows/qwen-image-edit-img2img.json)
- [`2026-07-07-image-generation-redesign-design.md`](../superpowers/specs/2026-07-07-image-generation-redesign-design.md)
- [`REDCRAFT_KREA2_INT8_INT4_CONVROT_2_UPDATE_EVALUATION.md`](./REDCRAFT_KREA2_INT8_INT4_CONVROT_2_UPDATE_EVALUATION.md)
- [`DRAW_THINGS_REDCRAFT_KREA2_CONVERSION_2026-07-22.md`](./DRAW_THINGS_REDCRAFT_KREA2_CONVERSION_2026-07-22.md)

## 对 Rapid-AIO v23 的建议

1. 不改变当前 BF16 ComfyUI 生产路由。
2. 若 v23 画质值得验证，先检查 safetensors header、dtype、scale 与 `.comfy_quant` metadata；按真实布局做 **v23 → BF16** 候选，并跑 MPS 实图，不要先转 INT8。
3. 若目标是内存/速度，另立三个互不混用格式的候选：MFLUX 8-bit、stable-diffusion.cpp Q4/Q8 GGUF、Draw Things 自有 6/8-bit。
4. 使用相同参考图、prompt、seed、尺寸、steps 做 A/B；分别记录冷启动、暖运行、常驻模型、峰值内存与端到端 wall time，并审查身份一致性、提示遵循、皮肤和手部。
5. 只有候选通过文件完整性、真实设备出图、后端 seam、质量/速度受控对比后，才讨论升级；“能下载、能加载、能转换”都不是替换生产模型的证据。
