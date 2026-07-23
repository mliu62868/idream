# sd.cpp PiD 两阶段生图加速验证（2026-07-21）

## 结论

在当前 Apple M4 Max / ComfyUI 0.28.0 / MPS 环境中，下面的两阶段路径能够显著缩短生成时间：

```text
ComfyUI RedCraft Krea2：208x304，10 steps
  -> sd.cpp PiD 1.5：4x
  -> 832x1216
```

热运行中位数从直接生成 `832x1216` 的 **108.205 秒**降到 **20.631 秒**，约 **5.24x 加速**，耗时减少约 **80.9%**。

这证明 PiD 可以作为生成流水线的加速后处理阶段。但它不能等价替代原生高分辨率扩散：208x304 小图中的构图和解剖缺陷会被保留或重建放大，皮肤微纹理和肢体细节通常不如直接大图。因此当前适合独立的“快速/草稿”候选，不应直接替换质量优先的默认路径。

本轮只做运行时验证，没有修改生产路由。

## 固定条件

| 项目 | 值 |
| --- | --- |
| 机器 | Apple M4 Max，40 GPU cores，128 GB unified memory |
| ComfyUI | 0.28.0，MPS |
| sd.cpp | commit `b290693` |
| ComfyUI 模型 | `redcraftKREA2RedMix_krea2Edition-bf16.safetensors` |
| ComfyUI workflow | `redcraft-krea2-txt2img` |
| ComfyUI steps | 10 |
| PiD | PiD 1.5 FLUX.1 4-step BF16 |
| seeds | 642100、642101、642102 |
| 目标尺寸 | 832x1216 |
| 小图尺寸 | 208x304，宽高严格 1/4 |

同一个明确成人提示词用于两条路径：

```text
photorealistic explicit nude portrait of an adult woman, cinematic studio lighting,
detailed natural skin, full body, realistic anatomy
```

每次热运行都更换 seed，避免 ComfyUI 节点缓存被误算成生成加速。

## 结果

### 直接生成基线

| 运行 | 尺寸 | ComfyUI server | 客户端 wall |
| --- | --- | ---: | ---: |
| cold | 832x1216 | 130.613 s | 未记录；首个轮询脚本变量冲突后从 server history 恢复 |
| warm 1 | 832x1216 | 103.934 s | 105.796 s |
| warm 2 | 832x1216 | 108.695 s | 110.613 s |
| warm 中位数 | 832x1216 | 106.315 s | **108.205 s** |

### ComfyUI 小图 + PiD 4x

PiD 使用以下 MPS 关键参数：

```text
--rng cpu --diffusion-fa --steps 4 --cfg-scale 1
```

| 运行 | ComfyUI 小图 wall | PiD wall | 端到端 wall |
| --- | ---: | ---: | ---: |
| cold | 25.191 s | 11.408 s | **36.599 s** |
| warm 1 | 9.145 s | 11.440 s | **20.585 s** |
| warm 2 | 9.192 s | 11.485 s | **20.677 s** |
| warm 中位数 | 9.169 s | 11.463 s | **20.631 s** |

主比较使用两条路径的客户端 warm wall time：

```text
108.205 / 20.631 = 5.244x
1 - 20.631 / 108.205 = 80.9% 时间减少
```

冷运行因为直接路径只恢复到 ComfyUI server time，不能与客户端 wall 完全同口径。即使用两阶段完整 wall time 作保守比较，`130.613 / 36.599 = 3.57x`。

## 输出有效性与质量

三张两阶段结果都满足：

- sd.cpp 退出码为 0；
- 输出尺寸为 832x1216；
- PNG 可解码；
- 不是全黑或近似常量图；
- 明确成人内容正常保留；
- 目视可见完整构图、主体和细节重建。

与直接大图相比，两阶段结果的主要质量代价：

- 208x304 阶段已经决定构图，PiD 不会重新解决低分辨率阶段的姿态问题；
- 手臂、手部、胸部对称和下腹解剖更容易出现重建痕迹；
- PiD 能增加边缘和局部纹理，但无法恢复小图里不存在的真实微细节；
- 同 seed 不再代表与直接大图相同的像素或构图结果。

因此这是一条真实的“速度换质量”路径，而不是无损加速。

## MPS 必须参数与假成功保护

验证过程中，首次重建命令遗漏了：

```text
--rng cpu --diffusion-fa
```

sd.cpp 当时仍然退出 0、记录 `save result ... (success)`，但输出是全黑 PNG：

```text
mean = 0
std = 0
black pixel ratio = 1.0
```

加入两个参数后，同一输入立即生成正常图片，PiD 单段时间也从约 16-25 秒下降到目标尺寸约 11.4 秒。

仓库现有 `assertGeneratedImageSanity` 已实机验证能够拒绝该黑图，并接受修正后的正常输出。因此若接入两阶段流水线，以下都必须保持：

1. MPS 参数固定为 `--rng cpu --diffusion-fa`；
2. 不能只检查进程退出码和文件存在；
3. PiD 输出必须经过现有像素健康检查后才能成为资产。

## 决策建议

建议新增独立候选，而不是替换默认路径：

```text
quality/default：ComfyUI 直接 832x1216
speed/draft：ComfyUI 208x304 -> PiD 4x -> 832x1216
```

在进入生产路由前，再做固定人物参考集、多姿态和手脸近景 A/B，决定哪些资产类型允许使用快速路径。角色主图、身份锚点和发布资产仍应保留质量优先路径，直到人物一致性与解剖通过率达到同一验收门槛。

PiD 权重仍受 NVIDIA NSCLv1 非商业许可证约束。

## 证据目录

```text
/Users/kk/ComfyUI-Shared/output/sdcpp-pid-speed-benchmark-20260721/
```

关键文件：

```text
direct_cold_832x1216.png
direct_warm1_832x1216.png
direct_warm2_832x1216.png
exact_pipeline_cold_pid_832x1216.png
exact_pipeline_warm1_pid_832x1216.png
exact_pipeline_warm2_pid_832x1216.png
exact_pipeline_cold_pid.log
exact_pipeline_warm1_pid.log
exact_pipeline_warm2_pid.log
invalid_208_no_cpu_rng_no_fa_832x1216.png
invalid_208_no_cpu_rng_no_fa.log
```
