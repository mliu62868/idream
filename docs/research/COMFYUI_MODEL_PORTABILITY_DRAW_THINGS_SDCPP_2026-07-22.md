# ComfyUI 模型迁移到 Draw Things / stable-diffusion.cpp

日期：2026-07-22

## 本机运行基线

- ComfyUI 0.28.0 / MPS：可用，但生成较慢。
- Draw Things 1.20260716.0：App 已安装；`draw-things-cli` 不在 `PATH`。
- stable-diffusion.cpp：`sd-cli`，版本 b290693。

## Runner 能力边界

stable-diffusion.cpp 官方支持 Krea2、FLUX.2 Klein 4B/9B、Qwen Image / Image Edit 2511 与 PiD，并支持 safetensors、GGUF。Krea2 还需要 Qwen3-VL 4B 与 Wan 2.1 VAE。

Draw Things 1.20260716 的发布说明只宣称支持 Krea2 系列与 LoRA。官方源码在 commit `12be777`（2026-07-20）才加入 Krea 完整模型导入，因此本机已发布 App 尚无此能力；应等待下一版，或自行构建 HEAD 后测试。

## 本机资产判断

- RedCraft Krea2 BF16：标准 safetensors，430 个张量，跨 runner 基础最好。
- RedMix3 scaled-FP8：包含 256 个 F8 张量、scale 张量与 `comfy_quant` 元数据，不可直接跨 runner。
- DarkBeast FLUX.2 Klein：文件名虽含 `INT8 ConvRot`，实际为 201 个纯 F8_E4M3 张量；配套 `qwen_3_8b_fp8mixed` 则是 Comfy scaled 格式。
- Qwen Rapid BF16 AIO：单包内含 diffusion、Qwen2.5 7B 与 VAE，架构内容齐全，但 AIO 封装兼容性未知。
- PiD BF16：已由 stable-diffusion.cpp 在本机实机跑通。

## 迁移矩阵

| 模型 | Draw Things | stable-diffusion.cpp | 结论 |
| --- | --- | --- | --- |
| RedCraft Krea2 BF16 | 当前发布版不支持完整导入；下一版或 HEAD 候选 | 架构候选，需补 Wan 2.1 VAE，并配 Qwen3-VL 4B | 在 Draw Things HEAD 与 sd.cpp 做双 A/B |
| RedMix3 scaled-FP8 | Comfy scaled-FP8 不可直接迁移 | Comfy scaled-FP8 不可直接迁移 | 两者均先反量化为 BF16，或重新导出 GGUF |
| DarkBeast FLUX.2 Klein | 架构候选 | 架构候选 | 更换官方兼容 companion，并以真实图片验证 |
| Qwen Rapid BF16 AIO | 架构支持，AIO 封装未验证 | 架构支持，AIO 封装未验证 | 优先拆分 diffusion、文本编码器与 VAE 后再接入 |
| PiD BF16 | 无官方支持声明 | 已实机跑通 | 立即用于混合加速 |

## 推荐优先级

1. 立即启用 PiD + stable-diffusion.cpp，作为现有 ComfyUI 流程的混合加速路径。
2. 用 RedCraft BF16 分别在 stable-diffusion.cpp 与 Draw Things HEAD 做双 A/B；sd.cpp 侧补齐 Qwen3-VL 4B、Wan 2.1 VAE。
3. 迁移 DarkBeast，换用官方兼容 companion，并完成真实图片生成验证。
4. Qwen Rapid 最后处理：先拆分 AIO，再验证两个 runner 的加载与出图。

## 来源

- Draw Things 下载与发布说明：https://drawthings.ai/downloads/
- Draw Things Krea 完整模型导入 commit：https://github.com/drawthingsai/draw-things-community/commit/12be7770c
- stable-diffusion.cpp：https://github.com/leejet/stable-diffusion.cpp
- Krea2 文档：https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/krea2.md
- FLUX.2 文档：https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/flux2.md
- Qwen Image Edit 文档：https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/qwen_image_edit.md
- PiD 文档：https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/pid.md
