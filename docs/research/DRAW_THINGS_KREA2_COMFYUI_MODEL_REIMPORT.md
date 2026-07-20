# Draw Things 重新导入既有 ComfyUI Krea2 模型

更新日期：2026-07-18

## 结论

**目前不要把 RedCraft Krea2 完整 checkpoint 迁成正式 Draw Things 模型。**

推荐做法是：

1. 在 Draw Things 中使用它自己提供的 Krea 2 Turbo / Raw base。
2. 如果“我们的模型”是独立 Krea2 LoRA，则从 LoRA 管理入口导入。
3. 继续保留 ComfyUI 的 RedCraft 完整 checkpoint 通路，不改现有 production
   descriptor。
4. 等官方明确宣布 custom Krea2 **model import**，或公开 `ModelImporter` 完成
   `.krea2` 完整模型写入路径后，再用 BF16 checkpoint 重新迁移。

如果只是验证新版 importer，可以保留旧模型，用 BF16 文件做一次可丢弃的实验导入；
但在它被识别为 `version: "krea_2"` 并完成实图闭环之前，不能把“导入按钮可选文件”
当成完整模型已受支持。

## 为什么现在不直接迁完整模型

Draw Things 官方 1.20260716.0 发布说明明确新增 “Krea 2 series models,
including LoRAs”。本机安装版本也已是 1.20260716.0。[官方发布说明](https://drawthings.ai/downloads/)

这句话证明 Krea2 inference 和 LoRA 支持，但没有声明 custom model import。作为对照，
同一官方发布页对 ERNIE Image、Anima、FLUX.2 Klein 等架构会明确写
“model import”或“import LoRAs and models”。因此不能从“支持 Krea2”推导出
“任意 Krea2 完整 checkpoint 可导入”。

同版本公开源码给出更直接的边界：

- Krea2 已进入 LoRA importer 的权重映射路径；
- 通用完整 `ModelImporter` 在 Krea2 的 conditional length、模型构建和写入校验
  分支仍执行 `fatalError()`。

见 [LoRAImporter.swift](https://github.com/drawthingsai/draw-things-community/blob/eb4bc7f4e287e51d8d1a43ed86908127df536eac/Libraries/ModelOp/Sources/LoRAImporter.swift#L637-L657)
以及 [ModelImporter.swift](https://github.com/drawthingsai/draw-things-community/blob/eb4bc7f4e287e51d8d1a43ed86908127df536eac/Libraries/ModelOp/Sources/ModelImporter.swift#L750-L795)、
[模型构建分支](https://github.com/drawthingsai/draw-things-community/blob/eb4bc7f4e287e51d8d1a43ed86908127df536eac/Libraries/ModelOp/Sources/ModelImporter.swift#L1316-L1327)。

## 2026-07-18 本机实际导入结果

这次不是只看发布说明，而是在本机 Draw Things 1.20260716.0 中实际走了完整模型
导入页。为避免改动 ComfyUI 源模型，两个候选文件都以 APFS clone copy 放进
Draw Things 的 `Documents/Downloads`：

- `redcraftKREA2RedMix_krea2Edition-bf16.safetensors`；
- `redcraftKREA2RedMix_krea2Edition.safetensors`（ComfyUI scaled-FP8）。

实测结果：

| 候选文件 | 导入器表现 | 落盘 / 登记结果 |
| --- | --- | --- |
| BF16 diffusion model | 点击“导入自定义模型”后明确显示“不兼容” | `Models` 无 RedCraft 文件，`custom.json` 未变化 |
| scaled-FP8 checkpoint | 文件可选，但提交后没有启动转换，也没有错误详情 | Draw Things CPU 为 0%，`Models` 无新文件，`custom.json` 未变化 |

因此当前版本的“支持 Krea 2”不能用于把这两个 ComfyUI 完整模型直接导入。
scaled-FP8 文件能出现在选择器中只说明扩展名可选，不代表架构和量化格式已经通过
导入器识别。两个 ComfyUI 源文件均未被移动或修改。

本机新目录缓存已出现正确的 Krea 2 规格：

| 字段 | 当前正确值 |
| --- | --- |
| `version` | `krea_2` |
| 主模型 | `krea_2_turbo_{q8p,q6p,i8x,i6x}.ckpt` 或 `krea_2_raw_*` |
| text encoder | `qwen_3_vl_4b_q8p.ckpt` |
| VAE | `qwen_image_vae_f16.ckpt` |

但 2026-06-29 导入的本机旧条目
`darkBeastKrea2_dbzit9DIMRclaw` 仍被登记为：

| 字段 | 旧条目错误值 |
| --- | --- |
| `version` | `z_image` |
| text encoder | `qwen_3_vl_4b_instruct_q8p.ckpt` |
| VAE | `flux_1_vae_f16.ckpt` |

因此升级应用不会自动修复旧的模型登记；旧条目只能保留作对照或在验证后删除，
不能继续把它当作已正确迁移的 Krea2。它也从侧面证明：架构识别错误时，生成出一个
Draw Things `.ckpt` 并不等于模型已被正确迁移。

## 我们实际有哪些 ComfyUI 资产

iDream 当前 RedCraft workflow 是 split 结构，而不是 AIO checkpoint：

| ComfyUI 资产 | 本机文件 | Draw Things 处理 |
| --- | --- | --- |
| diffusion / UNet | `redcraftKREA2RedMix_krea2Edition-bf16.safetensors` | 完整 Krea2 model import 尚未获官方证明；继续留在 ComfyUI |
| text encoder | `qwen3vl_4b_bf16.safetensors` | **不直接复用**；使用 Draw Things companion |
| VAE | `qwen_image_vae.safetensors` | **不直接复用**；使用 Draw Things companion |
| Krea2 LoRA | 如 `Detailer-KREA2.safetensors` | 在 LoRA 页面**单独导入并转换** |

仓库中的 [`redcraft-krea2-txt2img.json`](../../packages/gen/workflows/redcraft-krea2-txt2img.json)
明确由 `UNETLoader`、`CLIPLoader(type=krea2)`、`VAELoader` 三个节点分别加载这些
组件。Draw Things 没有执行这份 ComfyUI workflow JSON；它执行自己的模型规格和采样配置。

官方文档也把“导入模型”和“导入 LoRA”分成两个入口，并说明外置 VAE 是导入时的
伴随资源，不是共享 ComfyUI 目录。[Draw Things 模型导入文档](https://docs.drawthings.ai/documentation/documentation/2.models/)

## 直接复用与转换边界

| 资产形态 | 能否原地直接复用 | 建议 |
| --- | --- | --- |
| 官方 Krea2 base | 否 | 由 Draw Things 下载并管理自己的 `.ckpt` |
| 自定义 Krea2 完整 checkpoint | 尚未获支持证明 | 暂留 ComfyUI；不要进 production |
| ComfyUI split Krea2 UNet / `diffusion_model` BF16 | 尚未获支持证明 | 只能做可丢弃的实验导入 |
| LoRA safetensors | 否 | 通过 LoRA 入口单独导入 |
| VAE safetensors | 否 | 优先下载 Draw Things 的 Krea2 companion |
| CLIP / T5 / Qwen text encoder safetensors | 否 | 不导入现有 split 文件；使用 Draw Things companion |
| ComfyUI workflow JSON | 否 | 在 Draw Things 中重建采样参数 |

对于 importer 已实现的架构，Draw Things 官方 CLI 会把 checkpoint/safetensors
“import … into Draw Things format”，并把输出登记成内部 `.ckpt`，而不是把源文件
作为运行时模型直接引用。[官方 CLI 导入说明与实现](https://github.com/drawthingsai/draw-things-community/blob/eb4bc7f4e287e51d8d1a43ed86908127df536eac/Apps/DrawThingsCLI/DrawThingsCLI.swift#L287-L300)
但通用 CLI 接受 `.safetensors` 这种容器格式，不代表它已实现 Krea2 架构转换。

Krea2 的官方内部模型目录同时列出 `.ckpt` 主模型、
`qwen_3_vl_4b_q8p.ckpt` 和 `qwen_image_vae_f16.ckpt`，也印证其运行时资产形态与
ComfyUI split safetensors 不同。[官方 ModelZoo 源码](https://github.com/drawthingsai/draw-things-community/blob/eb4bc7f4e287e51d8d1a43ed86908127df536eac/Libraries/ModelZoo/Sources/ModelZoo.swift#L842-L847)

## BF16、scaled FP8 与 INT8 ConvRot

本机有两个可能的未来迁移源：

- `~/Downloads/models/redcraftKREA2RedMix_krea2Edition.safetensors`：ComfyUI
  scaled-FP8；
- `~/ComfyUI-Shared/models/diffusion_models/redcraftKREA2RedMix_krea2Edition-bf16.safetensors`：
  已反量化的标准 BF16。

当前 iDream 的 Mac 通路加载 BF16 产物。即便未来 custom Krea2 model import
获支持，也应先用 **BF16 产物**验证，而不是优先使用 scaled-FP8。

原因：

- Draw Things 当前 Krea2 catalog 的低位宽格式是它自己的 `q8p`、`q6p`、`i8x`
  和 `i6x` `.ckpt`；
- 官方 Krea2 发布说明没有声明支持 comfy-kitchen 的 `.comfy_quant` scaled-FP8；
- 官方源码没有 ComfyUI INT8 ConvRot / `comfy_quant` 导入路径。

因此：

- **BF16 safetensors：** 未来 importer 就绪后的首选迁移源；当前仍不应进 production；
- **scaled-FP8 safetensors：** 不作为首选导入源；
- **INT8 ConvRot safetensors：** 不直接导入 Draw Things；它与 Draw Things 的
  `i8x` 不是同一格式。若需要低位宽，先从 BF16 导入成功，再由 Draw Things 创建
  自己支持的量化版本。

## 未来完整模型导入的验收门槛

官方 importer 就绪后，不要只以“导入成功”作为完成。至少验证：

1. 新条目的 `version` 是 `krea_2`，不是 `z_image` 或 `qwen_image`；
2. text encoder 是 `qwen_3_vl_4b_q8p.ckpt`；
3. VAE 是 `qwen_image_vae_f16.ckpt`；
4. 使用与 ComfyUI 基线相同的 prompt、seed、分辨率、steps、CFG 生成实图；
5. 输出不是白图，人物结构正常，并记录速度与峰值内存；
6. 验收通过后，新增独立 Krea2 Draw Things descriptor 做候选通道，不直接覆盖
   现有 ComfyUI descriptor。

`Qwen-Rapid-AIO-NSFW-v19-bf16.safetensors` 属于 Qwen Image Edit AIO，
不是 Krea2；这次 Krea2 支持更新不能作为它已兼容 Draw Things 的证明，应单独验证。
