# Qwen-Image 2.1：Viggle Turbo 与 REDQW21 / NV DLSS_NR

调研日期：2026-10-01。只核对一手模型页、公开 API 与组件源码；本次没有安装权重、执行生成、修改正式配置或重启服务。

结论：保留已经验收的 `REDV2 BF16 + 社区 ConvRot INT8 编码器 + Viggle v0.3 r128 六步`。Viggle 提供少步采样加速；独立 RED LoRA 的额外速度收益未确认；NV DLSS_NR 是 Windows / RTX 后处理组件。

## Viggle/Qwen-Image-2.1-viggle-turbo

[Viggle 作者模型卡](https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo) 当前为 2026-09-29 发布的 v0.3：以少步蒸馏将基座的 40 步缩至六步，CFG 为 1。作者宣称相对 40 步基座约五倍端到端加速；这个基准不能直接换算成本机现有流程的额外收益。

本项目已经采用作者 ComfyUI 配方：r128、未合并、强度 1，Euler / BasicGuider，raw sigmas `[1,.9375,.875,.75,.5,.25]` 按输出分辨率动态 shift，关闭 terminal stretch 并追加零。实际实现见 [turbo.py](../../packages/gen/comfyui_nodes/idream_qwen21/turbo.py) 与 [单图工作流](../../packages/gen/workflows/qwen-image-edit-img2img.json)。

已有 M4 Max 128 GiB 验收中，两笔 832×1024 单图编辑从 Job 创建到完成分别为 58.117 与 48.337 秒，已经包含 Viggle 的加速收益。这是两笔受控样本，双参考仍保留 16 步 / CFG 2，未完成新的极速质量验收。[实施与交付记录](QWEN21_MAC_ACCELERATION_IMPLEMENTATION_2026-10-01.md)

作者列出的主要取舍是小字、复杂多参考及身份编辑更容易出错，v0.3 的细纹理略软。九步模式面向细节与文字质量，作者称耗时约为六步的 1.4–1.5 倍；本项目没有执行该模式的新测评。[作者限制与九步说明](https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo#known-limitations)

## REDQW21 UNLOCKED LoRA (with NV DLSS_NR)

可确定：这个名称来自 RED 作者 AiMetatron 的演示说明，不能据此当作第二个少步加速器。其配套 NV DLSS_NR 是实际调用 NVIDIA 运行时的图像后处理；当前组件要求 Windows / RTX，不能直接用于现有 M4 Max。独立 RED LoRA 的权重、版本及强度尚未定位，不能因此推断该 LoRA 本身只能运行在 NVIDIA，也不能把它直接叠到已经使用 REDV2 的正式流程。

### 名称与作者的准确关联

AiMetatron 的 [Civitai Accelerator LoRAs 原页](https://civitai.com/models/1063735) 的当前 [公开 API](https://civitai.com/api/v1/models/1063735) 明确说明：演示同时使用 Viggle Turbo 与 REDQW21 UNLOCKED LoRA，并提到 NV DLSS_NR。这是作者的组合声明，没有说明 RED LoRA 的来源版本、合并关系、强度、rank 或 hash。

该 API 当前唯一 Qwen 版本是 [3351025：TURBO(Viggle)QW21 v0.2.1](https://civitai.com/models/1063735?modelVersionId=3351025)，基座字段 `Qwen 2.1`，发布时间 2026-09-23。公开文件只有 Viggle r64 四步、v0.2.1 r128 / r256 六步权重，没有独立命名的 REDQW21 LoRA 文件。

该页仍混有 v0.1 的四步预览说明，不能用其笼统的 4–16 步 / CFG 1 标题替代 Viggle 当前版本的参数。Viggle 的最新配置应以 [Viggle 作者仓库](https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo) 为准。

本次 [AiMetatron 公开 LoRA 清单](https://civitai.com/api/v1/models?username=AiMetatron&types=LORA&limit=100) 返回 11 项，只有 `1063735` 显示 Qwen 版本；[RedCraft Exported LoRAs（964312）](https://civitai.com/api/v1/models/964312) 也没有独立 REDQW21 版本。这个覆盖结果不证明权重不存在或没有其他访问渠道。

### 当前 REDV2 是什么

用户指定的 [REDQW21 原页（452459）](https://civitai.red/models/452459/redqw21-unlocked-v2-ti2i-or-redgpt-k2t) 的 [当前 API](https://civitai.com/api/v1/models/452459) 将 `3370753` 标为 `REDQW21(UNLOCKED)v2 TI2I`，基座 `Qwen 2.1`，发布时间 2026-09-30。两项文件均为 `Diffusion Model`，不是 LoRA。现有 BF16 diffusion 对应其中原始 SHA256 `0efb5aeb2b372025042e320c2e35c66ec6681ef54ad5de88a652ab19cc63ad92` 的转换；文件与验收证据见 [现有实施记录](QWEN21_MAC_ACCELERATION_IMPLEMENTATION_2026-10-01.md)。

作者将 REDQW21 定位为 fine-tune；本轮未取得独立 RED LoRA 的完整采样器、步数、sigma 曲线和后期配置，无法为它指定可复现的四步 / 六步参数或宣称额外提速。[作者模型 API](https://civitai.com/api/v1/models/452459)

REDV2 说明关联 [579280@3344213 的 DLSS5 工作流](https://civitai.com/models/579280?modelVersionId=3344213)，把 v3 追加功能描述为 NVIDIA 光影、材质增强与 LUT，并指向 `lisitskyaa/ComfyUI-DLSS5-NR`。其 [工作流 API](https://civitai.com/api/v1/models/579280) 将原生 Cache、RTX VSR 超分、批量 LoRA 控制器分别列出。这些是不同环节，不能合并当作 RED LoRA 的少步蒸馏能力。

### NV DLSS_NR 的实际含义与 Mac 适用性

[ComfyUI-DLSS5-NR 作者仓库](https://github.com/lisitskyaa/ComfyUI-DLSS5-NR) 是非官方、实验性的 DLSS 5 Neural Rendering 接入。当前 v0.3.1 接收已生成的 `IMAGE`，经 CPU staging / D3D12 bridge 调用 `nvngx_dlssnr.dll`（NGX feature 18），返回同尺寸图片。它处理光照、色调和纹理，不减少 Qwen 采样次数，也不是 DLSS Super Resolution。

其 [nodes.py](https://github.com/lisitskyaa/ComfyUI-DLSS5-NR/blob/main/nodes.py) 明确拒绝非 Windows；节点只接收 / 返回 `IMAGE`，不接收 Qwen `MODEL`、LoRA 或 sigma。作者要求 Windows 10/11 x64、RTX、兼容驱动及 NVIDIA DLL。RED 作者所称 RTX 20–50 系支持仍受具体 GPU / 驱动 / DLL 组合约束，不能当成全面实测。

| 对象 | 可确定作用 | 当前 Mac 判断 |
| --- | --- | --- |
| Viggle Turbo v0.3 | 六步蒸馏采样、CFG 1 | 单图已集成，现有两笔 48–58 秒结果已含该收益 |
| REDQW21 V2 diffusion | Qwen 2.1 的模型微调，现有正式底模 | 已有原生 BF16 运行和交付证据 |
| 演示中的 REDQW21 UNLOCKED LoRA | 作者宣称与 Viggle 同时使用；独立权重与训练目的未确认 | 不能仅因 `with NV DLSS_NR` 判断 LoRA 不能运行；尚无独立兼容或速度证据 |
| NV DLSS_NR 组件 | 输出图片的光照、材质和纹理后处理 | 当前实现硬性要求 Windows / RTX，不能接入当前 M4 Max |
| RTX VSR / LUT | 作者工作流另列的超分 / 色彩后期环节 | 不应算作 Qwen 六步采样的加速收益 |

**叠加边界：**作者的演示声明不能证明再给当前 `REDV2 BF16 + Viggle v0.3 r128` 挂 RED LoRA 会加速。如果该 LoRA 重复表达 REDV2 的微调，可能改变模型行为；这是推断，本次未定位权重或实验确认。DLSS_NR 本身增加后处理计算，没有当前 Mac 的等效实现或端到端提速证据。

### 证据与未确认项

- 当前 Civitai HTML 原页经浏览工具不可读；公开 API 经只读请求成功读取，以上作者身份、模型 ID、版本、文件类型与描述均来自该站自身 API，未用聚合站作结论证据。
- 当前 API 描述与本地此前保存的 `.scratch/qwen21-acceleration-diagnosis/author-3370753.json` 一致地将 NVIDIA DLSS5 放在工作流追加的光影 / 材质后期中。
- 未定位独立 RED LoRA 的文件、SHA256、版本、rank、推荐强度、蒸馏训练声明或 Apple Silicon 实测。不能确认其与 REDV2 的参数关系，也不能把 `with NV DLSS_NR` 解释为训练图片经过 DLSS、DLSS 蒸馏进权重，或 DLL 随 LoRA 一起运行。
- 未获取该演示的完整当前生成图：其公开 gallery 元数据请求返回 HTTP 503。没有据此补猜采样器、步数、CFG、节点顺序或测速结果。
