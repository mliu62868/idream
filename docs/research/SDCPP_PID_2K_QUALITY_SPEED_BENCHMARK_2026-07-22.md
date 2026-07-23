# sd.cpp PiD：512 长边扩到 2K 的质量与速度验证（2026-07-22）

## 结论

验证通过。对于当前 Apple M4 Max / MPS 环境：

```text
ComfyUI RedCraft Krea2：352x512，10 steps
  -> sd.cpp PiD 1.5：4x
  -> 1408x2048
```

暖运行端到端中位耗时为 **49.718 秒**；ComfyUI 原生生成 `1408x2048` 的暖运行中位耗时为 **401.933 秒**。两阶段路径约 **8.08x 加速**，耗时减少约 **87.6%**。

质量判断也成立：与上一轮 `208x304 -> 832x1216` 快速路径相比，512 长边底图提供了更可靠的姿态、躯干和手臂结构，PiD 4x 后的块状重建、肢体断裂和局部畸变明显更少。把本轮 2K PiD 图缩到相同的 `832x1216` 显示尺寸后，三组固定 seed A/B 仍然都能看到这项改善。

但 PiD 2K 仍不等价于原生 2K：原生结果的皮肤微纹理、毛发和细小明暗变化更自然；PiD 结果略平滑，部分细节属于重建而非原生高分辨率扩散。当前最合适的定位是“平衡质量/速度”的默认候选，原生 2K 保留为高质量最终资产路径。

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
| PiD 参数 | `--rng cpu --diffusion-fa --steps 4 --cfg-scale 1` |
| seeds | 642100、642101、642102 |
| 小图尺寸 | 352x512 |
| 目标尺寸 | 1408x2048，严格 4x |

两条路径使用同一明确成人提示词和相同 seed 集：

```text
photorealistic explicit nude portrait of an adult woman, cinematic studio lighting,
detailed natural skin, full body, realistic anatomy
```

每次暖运行更换 seed，避免 ComfyUI 节点缓存被误算成生成加速。

## 速度结果

### ComfyUI 352x512 + PiD 4x

| 运行 | ComfyUI 小图 wall | ComfyUI server | PiD wall | 端到端 wall |
| --- | ---: | ---: | ---: | ---: |
| cold | 33.435 s | 30.988 s | 33.186 s | **66.648 s** |
| warm 1 | 18.288 s | 15.869 s | 31.213 s | **49.528 s** |
| warm 2 | 18.295 s | 17.840 s | 31.586 s | **49.907 s** |
| warm 中位数 | 18.292 s | 16.855 s | 31.400 s | **49.718 s** |

PiD cold 运行观察到的峰值 memory footprint 为 `11,528,839,928` bytes，约 `10.74 GiB`；运行期间没有 swap。

### ComfyUI 原生 1408x2048

| 运行 | ComfyUI server | 客户端 wall |
| --- | ---: | ---: |
| cold | 392.740 s | **398.803 s** |
| warm 1 | 377.172 s | **381.879 s** |
| warm 2 | 421.313 s | **421.987 s** |
| warm 中位数 | 399.243 s | **401.933 s** |

主比较使用两条路径的客户端暖运行 wall time：

```text
401.933 / 49.718 = 8.084x
1 - 49.718 / 401.933 = 87.63% 时间减少
```

冷运行同口径比较：

```text
398.803 / 66.648 = 5.984x
```

## 质量 A/B

### 相对上一轮 304 长边底图

上一轮快速路径为：

```text
208x304 -> PiD 4x -> 832x1216
```

本轮把 `1408x2048` PiD 结果缩到 `832x1216`，与上一轮相同 seed 的结果按相同显示尺寸对比。三组样本一致显示：

- 手臂、手部和肩部连接更连贯；
- 躯干、胸腹和骨盆结构更稳定；
- 较少出现大块平滑或方块状重建；
- 光影过渡和身体轮廓更自然；
- 小图阶段已经存在的构图与姿态仍会被 PiD 保留，不能靠 4x 自动纠正。

因此，“先把底图提高到 512 长边，再扩到 2K”相较 304 长边快速草稿，质量明显更好。

### 相对原生 2K

三组相同 seed 对比中：

- PiD 2K 的整体构图、解剖连续性和主体完整度已经接近可用成图；
- 原生 2K 的皮肤微纹理、毛发、局部材质和细小明暗变化更自然；
- PiD 结果略平滑，无法恢复底图中不存在的真实微细节；
- 相同 seed 不代表两种分辨率路径会得到相同像素或完全相同构图。

结论不是“PiD 质量超过原生 2K”，而是以较小的可见微细节代价，获得约 8 倍的端到端速度提升。

## 输出健康与过滤验证

六张最终 `1408x2048` PNG 全部通过仓库现有 `assertGeneratedImageSanity`：

```text
PASS direct2k_cold_1408x2048.png
PASS direct2k_warm1_1408x2048.png
PASS direct2k_warm2_1408x2048.png
PASS pipeline2k_cold_pid_1408x2048.png
PASS pipeline2k_warm1_pid_1408x2048.png
PASS pipeline2k_warm2_pid_1408x2048.png
TOTAL 6
```

像素统计范围：

| 路径 | 灰度 entropy | Laplacian variance | 近黑像素比例 |
| --- | ---: | ---: | ---: |
| 原生 2K，3 张 | 7.3510–7.4842 | 32.820–42.340 | 0.182%–0.306% |
| PiD 2K，3 张 | 7.3471–7.4850 | 34.886–45.048 | 0.200%–3.111% |

所有图片均可解码、不是全黑或近似常量图。明确成人内容在 ComfyUI 小图、PiD 扩图和原生 2K 三条结果中都正常保留，没有出现安全过滤、拒绝、替换图或生成失败。

三次 PiD 日志均确认：

```text
rng_type: cpu
diffusion_flash_attn: true
1/1 images saved
```

验证结束时 ComfyUI `/queue` 的 running 与 pending 均为空；`/system_stats` 确认当前执行设备为 MPS。

## 生产分层建议

| 档位 | 路径 | 暖运行中位耗时 | 适合用途 |
| --- | --- | ---: | --- |
| draft | 208x304 -> PiD -> 832x1216 | 20.631 s | 批量草稿、构图筛选 |
| balanced | 352x512 -> PiD -> 1408x2048 | **49.718 s** | 默认预览、候选资产、交互式生成 |
| premium | ComfyUI 原生 1408x2048 | **401.933 s** | 角色主图、身份锚点、最终发布资产 |

建议把 `352x512 -> PiD 2K` 作为新的平衡档候选做角色参考集 A/B，而不是把 PiD 直接当成无损放大。选择逻辑应由资产等级决定：大量候选优先 PiD，最终高价值资产保留原生 2K 或独立高质量精修。

PiD 权重仍受 NVIDIA NSCLv1 非商业许可证约束。

## 证据目录

```text
/Users/kk/ComfyUI-Shared/output/sdcpp-pid-2k-benchmark-20260722/
```

关键文件：

```text
pipeline2k_cold_small_352x512.png
pipeline2k_cold_pid_1408x2048.png
pipeline2k_warm1_pid_1408x2048.png
pipeline2k_warm2_pid_1408x2048.png
pipeline2k_cold_downsample_832x1216.png
pipeline2k_warm1_downsample_832x1216.png
pipeline2k_warm2_downsample_832x1216.png
direct2k_cold_1408x2048.png
direct2k_warm1_1408x2048.png
direct2k_warm2_1408x2048.png
pipeline2k_cold_pid.log
pipeline2k_warm1_pid.log
pipeline2k_warm2_pid.log
```

上一轮 304 长边快速路径证据：

```text
/Users/kk/ComfyUI-Shared/output/sdcpp-pid-speed-benchmark-20260721/
```
