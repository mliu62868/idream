# FP8 → BF16 与 MPS bring-up 原始记录

记录日期：2026-07-07。

本文保留当时 RedCraft Krea2 与 Qwen Rapid-AIO v19 的格式检查、转换和本机实图观察。当前模型、路由和运行命令以 [Gen 运行说明](../../../packages/gen/README.md) 为准；产品目标见 [角色图片契约](../../product/CHARACTER_IMAGE_GENERATION_SYSTEM.md)。

## 环境与证据范围

当时使用 ComfyUI Desktop `v0.27.0+20`、Apple Silicon MPS，活动实例位于 `~/ComfyUI-Installs/idream (1)/ComfyUI`，共享模型目录为 `~/ComfyUI-Shared/models/`。MPS 实测请求发往本机 `8188`；CPU 对照使用临时 headless `--cpu` 实例 `8199`。

原记录没有绑定 source fingerprint、request/artifact ID、文件 hash 或完整原始日志。以下耗时、文件大小和视觉判断保留为当日观察，不能证明当前服务资格、受控性能分位数、其他模型兼容性或完整身份一致性。当前仓库的 [转换器](../../../packages/gen/scripts/dequant_fp8_to_bf16.py) 可用于核对格式处理规则，本次文档清理未重新执行转换或生成。

## MPS dtype 错误与 CPU 对照

RedCraft Krea2 workflow 在 MPS 的 KSampler 节点抛出：

```text
TypeError: Trying to convert Float8_e4m3fn to the MPS backend but it does not have support for that dtype.
  comfy/ldm/krea2/model.py → comfy_kitchen/tensor/fp8.py::dequantize
```

当时 checkpoint 的 FP8 权重不能直接迁入该 MPS 环境。此前记录的 `17/20` 达标使用 CPU split-node workflow，不是 MPS FP8 出图证据。临时 `--cpu` 对照在 `384×512`、6 步下约 `54s` 产出人像，证明当时图和依赖能够在 CPU 路径执行。

## 格式转换

两种 checkpoint 布局分别处理，不能只按文件名或统一 dtype cast 转换：

| 当时检查的格式 | 权重与 metadata | 转换规则 |
|---|---|---|
| RedCraft RedMix scaled-FP8 | linear `.weight` 为 F8_E4M3，`.weight_scale` 为标量 F32、per-tensor；`.comfy_quant` 是 U8 的 `{"format":"float8_e4m3fn"}` 标签 | `weight.float() * weight_scale` 后转 BF16，移除量化 sidecar，非 FP8 张量保留 |
| Qwen Rapid-AIO v19 plain-FP8 | 2662 个直接存储的 F8_E4M3 权重，无 per-tensor scale；AIO 包含 model/text_encoders/vae 三个命名空间 | FP8 直接 widening cast 为 BF16；`text_encoders.qwen25_7b.logit_scale` 是真实权重，必须保留 |

`torch.Tensor.dequantize()` 只把原始 FP8 转成 F32，没有应用 scaled-FP8 的 scale，不能代替第一行的反量化。判定 `_scale` 为量化 sidecar 时，必须存在对应 FP8 权重；真实模型参数不能因名字含 scale 被删除。

## RedCraft 原始验证

- Diffusion 转换为 `256` 个 FP8→BF16 张量，另保留 `174` 个 BF16 张量，共 `430` 个；产物约 `24GB`，转换约 `31s`。
- `qwen3vl_4b_fp8_scaled` 同法转成 `qwen3vl_4b_bf16`，约 `8.3GB`、`7s`；`qwen_image_vae` 原为纯 BF16，未转换。
- MPS BF16 workflow 在 `832×1216`、10 步下返回 `ok:true`，含 24GB 冷加载约 `145s`。当时肉眼观察为连贯人像、身份与 FP8 对照相近；没有受控身份评分或热态分位数。
- 当时产物名为 `diffusion_models/redcraftKREA2RedMix_krea2Edition-bf16.safetensors` 与 `text_encoders/qwen3vl_4b_bf16.safetensors`；原 FP8 文件保留供 CUDA 使用。这些是旧产物来源记录。

## Qwen v19 原始验证

当时下载 `Phr00t/Qwen-Image-Edit-Rapid-AIO` v19 NSFW，源文件约 `28.4GB`，plain-FP8→BF16 后 AIO 约 `53GB`，由 `CheckpointLoaderSimple` 一次加载。

- t2i：`CheckpointLoaderSimple → TextEncodeQwenImageEditPlus → KSampler`，4 步、CFG 1、`sa_solver/beta`，`768×768`；含冷加载约 `64s`，MPS 产出人像。
- 编辑：以该次 RedCraft 人像为 source，`LoadImage → TextEncodeQwenImageEditPlus{image1, vae}`，要求“换红色晚礼服、保持身份”，约 `72s` 出图。当时肉眼观察为脸、发色、发型、光向和机位保持，仅换装；这是单次编辑观察，不能外推为质量保证。
- 当时验证使用 ComfyUI 原生节点。多图、后续版本及其他 runtime 的资格需独立证据。

## 当时的故障观察

- RedCraft BF16 24GB 驻留后再加载 Qwen 53GB，ComfyUI 进程被 macOS 杀死。记录环境有 128GB 统一内存；该次 OOM 包含驻留模型与激活，不能仅按两份文件大小推算并发容量。
- macOS Python `urllib` 读取系统代理（`_scproxy`）后，本机 `127.0.0.1` 请求返回 `502 Bad Gateway`，同期 curl 请求正常。该次探针的规避方式是 `ProxyHandler({})` 直连；这是一条本机探针故障记录。
