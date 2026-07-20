# RedCraft Krea2 RedMix3 MPS 集成记录（2026-07-19）

## 结论与边界

RedMix3 已按独立对比候选接入 iDream 的 workflow-native ComfyUI backend。
当前默认 `redcraft-krea2-comfyui`、`redcraft-krea2-txt2img` 与对应 BF16
权重不变；新 profile 保持 `draft`、`enabled=false`、`rolloutPercent=0`。

这次 Gate 的目标是证明：

1. 精确版本的官方 scaled-FP8 文件可验证；
2. 现有转换器能生成 Apple MPS 可执行的 BF16 diffusion model；
3. 产品 backend seam 能用新 model/workflow 生成并回收真实 PNG；
4. 候选可被运维探针独立审计，同时不影响当前默认和回滚路径。

一次 artifact smoke 不等于角色一致性、生产容量或默认路由切换。

## 精确上游资产

| 字段 | 值 |
| --- | --- |
| Civitai model | `958009` |
| version | `3139241`，`赤佬 3.0 (Krea2)` |
| base model | `Krea 2` |
| FP8 file | `3019490`，`redcraft23INT8INT4FP8_30Krea2.safetensors` |
| expected bytes | `13,141,826,368` |
| expected SHA-256 | `F6088960C0FEBD27CBD372FC758BB07D012F2D8AE3CD10C45C903D48B94409EA` |
| local source | `models/diffusion_models/Krea2RedMix3.0-fp8-scaled-ComfyUI.safetensors` |
| local BF16 | `models/diffusion_models/redcraftKREA2RedMix3.0-bf16.safetensors` |

源文件 safetensors header 为 170,528 bytes、942 tensors：

- `F8_E4M3`: 256；
- `F32`: 256；
- `U8`: 256；
- `BF16`: 174；
- 256 个 FP8 weight 均有匹配的 `weight_scale`；
- 256 个 `comfy_quant` sidecar；
- missing/orphan scale 均为 0。

因此它精确命中
`packages/gen/scripts/dequant_fp8_to_bf16.py` 的 scaled-FP8 路径，不使用
CUDA-only INT8/ConvRot runtime。

## Workflow 与产品路由

新增 descriptor：

- workflow key: `redcraft-krea2-redmix3-txt2img`；
- model id: `redcraft-krea2-redmix3-bf16`；
- ComfyUI UI id: `abea5b3f-6ba1-4bbd-86b0-95e0261a7ee1`；
- graph: 12 steps、Euler、Simple、CFG 1；
- Qwen encoder: `qwen3vl_4b_bf16.safetensors`；
- VAE: `qwen_image_vae.safetensors`。

ComfyUI `userdata` sync/readback 为 9 nodes、9 links，readback 中的
workflowKey/modelId/version 与 descriptor 一致。首轮 graph 不带作者 showcase
LoRA、SeedVR2、sharpen 或 upscaler，先收窄运行变量和依赖面。

当前路由使用 10-step ER-SDE，新候选使用 12-step Euler。配对 smoke 固定 prompt、
seed 和输出尺寸，但保留各版本 recipe，因此用于兼容性和结果对照，不作为
model-weight-only 实验。

## 转换结果

`TO_BE_FILLED_AFTER_CONVERSION`

## MPS artifact smoke

环境：

- ComfyUI `0.28.0`；
- Python `3.13.12`；
- PyTorch `2.10.0`；
- device `mps`；
- Apple unified memory `128 GiB`。

配对输入：

- prompt: `adult East Asian woman, upper-body editorial portrait, short black bob, direct eye contact, dramatic foreground hand perspective, strong window light, natural skin texture, photorealistic`；
- seed: `486071801727172`；
- output: `832x1024`。

| 路由 | recipe | 产物 | bytes | duration | SHA-256 |
| --- | --- | --- | ---: | ---: | --- |
| current `redcraft-krea2-comfyui` | 10-step ER-SDE / Simple / CFG 1 | `/private/tmp/idream-redcraft-current-baseline-mps.png` | `944,208` | `102,381 ms` | `832c8fe7789d9682d257cb5d408468c1a45b593fe808ae3ac0a839ee27af5dfb` |
| candidate `redcraft-krea2-redmix3-bf16` | 12-step Euler / Simple / CFG 1 | `TO_BE_FILLED_AFTER_SMOKE` | `TO_BE_FILLED_AFTER_SMOKE` | `TO_BE_FILLED_AFTER_SMOKE` | `TO_BE_FILLED_AFTER_SMOKE` |

两张图都必须通过 PNG 解码、尺寸检查与 shared generated-image sanity。单样本只支持
runtime compatibility 结论；质量、风格和角色一致性是否提升需要后续样本包与人工
review。

## 验证证据

`TO_BE_FILLED_AFTER_PROBE`

