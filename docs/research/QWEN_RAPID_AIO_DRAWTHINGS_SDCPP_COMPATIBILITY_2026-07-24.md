# Qwen Rapid-AIO 在 Draw Things / stable-diffusion.cpp 的兼容性

日期：2026-07-24  
范围：Phr00t `Qwen-Image-Edit-Rapid-AIO` v19/v23、Apple Silicon、本机现有 Draw Things 与 stable-diffusion.cpp。只做只读检查和 `--dry-run`，未转换模型、未生成图片、未改变任何生产路由。

## 结论

1. **本机 v19 FP8 与 BF16 AIO 都不能作为 Qwen Image Edit 直接导入 Draw Things。** Draw Things 1.20260716.0 的官方 importer 能识别其 Qwen 主干，但将两者都推断为普通 `Qwen Image`、`modifier: none`，而不是 `qwenimage_edit_2511`。完整导入即使成功写出 `.ckpt`，也缺少 2511 edit 所需的零时间步、视觉编码器和多图条件语义。
2. **Draw Things 确实正式支持 Qwen Image Edit 2511 和 8-bit S/I8X，但这是官方预转换模型支持，不等于支持任意 Rapid-AIO。** 当前 catalog 有 Q8P、I8X、Q6P 及 BF16 变体；本机已有 Q6P 主模型和配套组件。它可以现在就跑“官方 Qwen Edit 2511”，不能证明能忠实运行 Phr00t 的 4-step 合并权重。
3. **对 exact Rapid-AIO，stable-diffusion.cpp 是更可行的首个候选，但也不是把 AIO 单文件直接交给 `-m`。** 应无损拆出 `model.diffusion_model.*`，复用官方 Qwen2.5-VL 与 Qwen VAE 组件，再用 `--diffusion-model`。sd.cpp 原生提供重复 `--ref-image`、`euler_a`、`beta` 和 2511 的 `qwen_image_zero_cond_t=true`，更接近 Phr00t 的实际配方。
4. **v23 比 v19 更适合首先验证 sd.cpp。** Phr00t 说明 v20 起回到 100% Qwen Edit 2511，v23 明确沿用该线；sd.cpp 的 2511 开关有确定语义。v19 是 2509/2511 混合并含 Lightning，虽然作者认为其 edit consistency 最好，但应同时 A/B `qwen_image_zero_cond_t=true/false`，不能先验认定一种设置正确。
5. **INT8 不是兼容性开关。** Draw Things 的 I8X/Q8P 与 sd.cpp 的 GGUF Q8_0 是不同 codec。量化只能在架构、组件和 edit conditioning 已正确之后减少模型存储/带宽；不能修复 importer 将 edit 模型标成 `modifier: none`，也不能修复 AIO 文本编码器命名空间不匹配。

## 本机事实

| 项目 | 观察 |
|---|---|
| Draw Things | App `1.20260716.0` |
| stable-diffusion.cpp | `/Users/kk/bin/sd-cli`，commit `b290693` |
| v19 FP8 AIO | 28,431,843,583 bytes；2,857 tensors：diffusion 1,934、text encoder 729、VAE 194；2,662 个 `F8_E4M3`、194 个 BF16、1 个 F32 |
| v19 BF16 AIO | 56,609,329,632 bytes；相同 2,857 tensors；2,856 个 BF16、1 个 F32 |
| AIO 命名空间 | `model.diffusion_model.*`、`text_encoders.qwen25_7b.*`、`vae.*`；包含 `model.diffusion_model.__index_timestep_zero__` |
| Draw Things 官方 Qwen Edit | 本机有 `qwen_image_edit_2511_q6p.ckpt`（17,629,241,344 bytes）、Qwen2.5-VL 文本/视觉组件和 Qwen Image VAE |
| iDream 当前 Qwen 路由 | ComfyUI workflow 指向 v19 BF16；单图与多图都用 `TextEncodeQwenImageEditPlus`、4 steps、CFG 1、`beta` |

这里的 v19 header 是本机文件的直接读取结果。v23 尚未下载到本机，因此不能把 v19 的精确 tensor layout 无条件外推到 v23；v23 的 “AIO + FP8 + 2511” 身份来自 Phr00t 官方 model card。

## Draw Things：官方支持与 exact AIO 是两回事

### 1. 对本机两个 AIO 的实测 dry-run

使用与本机 App 完全对应的官方 tag `v1.20260716.0` 构建 `draw-things-cli`，在临时空目录执行：

```text
draw-things-cli models import <v19 FP8 AIO> --dry-run --offline --no-download-missing

VERSION        Qwen Image (qwenImage)
MODIFIER       none
TEXT_ENCODER   qwen_2.5_vl_7b_q8p.ckpt
AUTOENCODER    qwen_image_vae_f16.ckpt
IMPORTED_FILE  qwen_rapid_aio_nsfw_v19_f16.ckpt
```

BF16 AIO 的结果相同，只是目标名为 `qwen_rapid_aio_nsfw_v19_bf16_f16.ckpt`。`--dry-run` 明确报告没有写入文件。

这说明：

- importer 能从 `transformer_blocks.59.txt_mlp` 识别 Qwen Image 架构；
- importer 固定赋值 `modifier = .none`，并以 `referenceSequenceLength: 0`、`zeroTimestepForReference: false` 编译普通 Qwen Image；
- 它没有使用 AIO 内嵌的 `text_encoders.qwen25_7b.*` 和 `vae.*`，而是声明 Draw Things 官方 companion；
- 导入目标是 F16 `.ckpt`，当前 CLI 没有把任意导入模型直接转成 I8X 的选项。

因此，“能被 inspector 识别”不等于“能作为 Qwen Image Edit 正确运行”。

### 2. 官方 Qwen Edit 为什么可以

Draw Things 的官方 Qwen Edit 2511 catalog 明确设置：

- `modifier: .qwenimageEdit2511`
- `clipEncoder: qwen_2.5_vl_7b_vit_f16.ckpt`
- 每层 activation projection / FFN scaling
- 2511 多图 rotary embedding 和 reference zero timestep

运行时只有 `modifier == .qwenimageEdit2511` 才追加 `zero_cond_t` 并为 reference 使用零时间步。官方 catalog 同时提供：

- Q8P（默认）
- I8X / “8-bit S”
- Q6P
- 上述三种 BF16 主干变体

所以 Draw Things 的 8-bit 支持是真实的，但它支持的是**按 Draw Things 规格转换和登记的权重**。Rapid-AIO 若要走这条路，需要额外实现/验证：

1. 只导入 Phr00t 合并后的 diffusion 权重；
2. 手工登记 `qwenimageEdit2511`、vision encoder 和 activation scaling；
3. 使用 Draw Things 自身的 Q8P/I8X writer 重新量化，而不是把 FP8 改扩展名；
4. 做 4-step Lightning 与 Draw Things sampler 的实图验证。

此外，当前官方 CLI 的 image input 是单个 `--image` 字段；iDream 的 Draw Things adapter 也明确限制最多一个 `source_image`，并声明 `referenceImages: false`、`edit: false`。Draw Things App 内部已有多图 Qwen 2511 逻辑，但当前 CLI/iDream seam 还没有暴露完整的多 reference edit。

## stable-diffusion.cpp：更接近 exact Rapid 配方

### 1. 已有的 Qwen Edit 能力

当前官方 sd.cpp 文档明确支持 Qwen Image Edit、2509 和 2511。2511 必须加：

```text
--model-args qwen_image_zero_cond_t=true
```

官方警告不加会显著降低 edit 质量。当前源码和本机 binary 还具备：

- 可重复的 `-r/--ref-image`；
- `--sampling-method euler_a`；
- `--scheduler beta`；
- Metal、GGUF 和离线 Q8_0 转换。

iDream 的 sd.cpp adapter 已能把多个 reference 展开成重复 `--ref-image`，多图时还加 `--increase-ref-index`。不过当前 capability 仍把 `edit` 标为 false，新增 Qwen edit workflow 前要先补正确的 descriptor/参数和集成测试。

### 2. 为什么完整 AIO 仍不能直接跑

sd.cpp 的 Qwen conditioner 使用 `text_encoders.llm.*`，外部 `--llm` 也加载到这个命名空间；本机 AIO 内嵌的是 `text_encoders.qwen25_7b.*`。当前 tensor name conversion 没有这条映射。官方 Qwen Edit 示例也一贯使用拆分的 diffusion、LLM 和 VAE，而不是 Comfy AIO checkpoint。

sd.cpp 可以读取 plain FP8 safetensors，但源码将 `F8_E4M3/F8_E5M2` 映射为 F16 并在加载时解码，所以这不是原生 FP8 Metal 执行：直接加载仍会扩大内存。更合理的实验路径是：

1. 从 AIO 无损提取 `model.diffusion_model.*`，保留 Phr00t 已合并的 Lightning/LoRA 权重；
2. 使用官方兼容的 Qwen2.5-VL 和 Qwen Image VAE；
3. 先用未量化 diffusion 跑通，再离线转换该 diffusion 为 GGUF Q8_0；
4. v23 使用 `qwen_image_zero_cond_t=true`；v19 对 true/false 都做控制组；
5. 用 4 steps、CFG 1、Euler A + beta 起步，并对 `flow-shift` 做受控验证，而不是直接照搬默认值。

示意命令（尚未执行，路径仅表示组件职责）：

```sh
sd-cli \
  --diffusion-model rapid-v23-diffusion.safetensors \
  --llm qwen_2.5_vl_7b.safetensors \
  --vae qwen_image_vae.safetensors \
  --model-args qwen_image_zero_cond_t=true \
  --sampling-method euler_a --scheduler beta \
  --steps 4 --cfg-scale 1 \
  -r reference-1.png -r reference-2.png \
  -p "<prompt>"
```

跑通后才转换：

```sh
sd-cli -M convert \
  -m rapid-v23-diffusion.safetensors \
  -o rapid-v23-diffusion-q8_0.gguf \
  --type q8_0
```

## 质量与速度：目前不能下结论

Phr00t 自己的结论是 v19 倾向最佳 edit consistency、v23 倾向最佳 prompt adherence；v23 推荐 `euler_ancestral/beta`。这是模型作者经验，不是本机 Draw Things/sd.cpp A/B。

当前没有以下证据：

- exact v19/v23 在 Draw Things 正确 edit 登记后的实图；
- exact v19/v23 在 sd.cpp 拆分后的单图/多图实图；
- FP8/BF16/Q8_0/I8X 在同一台 Mac 上的同参冷启动、热运行、峰值内存和质量；
- NSFW/SFW 两个 v23 文件的完整性、license 附带文件及输出边界验证。

量化通常减小权重和内存压力，但在 Apple Metal 上不保证比 BF16/F16 更快；I8X 与 Q8_0 也可能产生不同的细节、身份和肤质偏移。不能用此前 Krea2 的速度结果外推 Qwen Edit。

## 推荐决策

| 目标 | 推荐 |
|---|---|
| 现在就用 Draw Things 跑 Qwen Edit | 用官方 Qwen Image Edit 2511 Q6P/I8X/Q8P；把它当独立 baseline，不宣称是 Rapid-AIO |
| 保留 Phr00t v23 的 exact 合并主干 | 首选 sd.cpp：lossless split diffusion + 官方组件 + 2511 zero-cond + Euler A/beta |
| 保留 Phr00t v19 的 edit consistency | 同样先走 sd.cpp，但必须 A/B zero-cond true/false；v19 混合血统比 v23 风险更高 |
| 把 Rapid-AIO 放进 Draw Things | 第二阶段工程候选：修 importer/spec、接 vision encoder、写 I8X/Q8P、扩 CLI 多图后再验证 |
| 替换 iDream 生产路由 | 暂不允许；先完成候选完整性、实图、质量/速度和 backend seam 闭环 |

最小验收矩阵应固定相同 prompt、相同 reference 集、相同尺寸、4 steps、CFG 1，并分别记录：

- 单 reference edit、双 reference identity + source、四 reference；
- 身份一致性、prompt adherence、构图漂移、手脸/文字、NSFW 边界；
- 冷启动、同进程热运行、峰值内存、输出像素 sanity；
- Comfy BF16 v19、sd.cpp 未量化、sd.cpp Q8_0、Draw Things 官方 Q6P/I8X baseline。

## 一手来源与代码证据

- [Phr00t Rapid-AIO model card](https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO/blob/main/README.md)
- [Phr00t Rapid-AIO v23 files](https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO/tree/main/v23)
- [Draw Things ModelImporter at current source](https://github.com/drawthingsai/draw-things-community/blob/79b4362633ecd2c0705a9e6ec1b66c47c15a6ea5/Libraries/ModelOp/Sources/ModelImporter.swift)
- [Draw Things Qwen Edit 2511 catalog](https://github.com/drawthingsai/draw-things-community/blob/79b4362633ecd2c0705a9e6ec1b66c47c15a6ea5/Libraries/ModelZoo/Sources/ModelZoo.swift#L1400-L1477)
- [Draw Things Qwen runtime zero-timestep logic](https://github.com/drawthingsai/draw-things-community/blob/79b4362633ecd2c0705a9e6ec1b66c47c15a6ea5/Libraries/SwiftDiffusion/Sources/Models/UNetProtocol.swift#L1488-L1505)
- [Draw Things CLI image input](https://github.com/drawthingsai/draw-things-community/blob/79b4362633ecd2c0705a9e6ec1b66c47c15a6ea5/Apps/DrawThingsCLI/DrawThingsCLI.swift#L564-L576)
- [stable-diffusion.cpp Qwen Image Edit](https://github.com/leejet/stable-diffusion.cpp/blob/87a01773be23b996e38217a6a574c2de08ac560f/docs/qwen_image_edit.md)
- [stable-diffusion.cpp quantization/GGUF](https://github.com/leejet/stable-diffusion.cpp/blob/87a01773be23b996e38217a6a574c2de08ac560f/docs/quantization_and_gguf.md)
- [stable-diffusion.cpp FP8 safetensors handling](https://github.com/leejet/stable-diffusion.cpp/blob/87a01773be23b996e38217a6a574c2de08ac560f/src/model_io/safetensors_io.cpp#L78-L97)
- [`qwen-image-edit-img2img.json`](../../packages/gen/workflows/qwen-image-edit-img2img.json)
- [`qwen-image-edit-multi-reference.json`](../../packages/gen/workflows/qwen-image-edit-multi-reference.json)
- [`drawthings.ts`](../../packages/gen/src/backend/drawthings.ts)
- [`sdcpp-reference-images.ts`](../../packages/gen/src/sdcpp-reference-images.ts)
