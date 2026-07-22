# stable-diffusion.cpp PiD 1.5 NSFW 运行验证

日期：2026-07-21  
机器：Apple M4 Max（40 GPU cores）、128 GiB unified memory、macOS 26.5.1  
范围：只升级本机独立 `sd.cpp` CLI、安装研究用 PiD 模型并执行本地测试；没有修改 iDream 生产路由，也没有停止或重启 ComfyUI。

## 结论

**本轮没有发生 NSFW 安全过滤、拒绝或拦截。**

- `sd.cpp` 成功接受明确的成年人 NSFW 输入图片；
- Gemma 2 文本编码阶段成功接受包含 `explicit nude ... adult woman` 的提示词；
- PiD 1.5 在 Metal 后端完成 4-step LCM 采样；
- 两次运行退出码均为 `0`，PNG 均成功写盘且可解码；
- 日志未出现 `safety_checker`、`moderation`、`refusal`、`blocked`、`filtered`、`unsafe` 等内容拒绝信号；
- 目视检查输出仍保留明确的成年人 NSFW 内容。

因此，在本次版本、模型和输入组合下，**成人图片或成人提示不会导致 sd.cpp PiD 生成失败**。

## 版本升级

日常入口：`/Users/kk/bin/sd-cli`

| 项目 | 升级前 | 升级后 |
| --- | --- | --- |
| sd.cpp commit | `7b5f34d` | `b290693` |
| 上游发布时间 | 2026-06-28 | 2026-07-16 |
| PiD 能力 | 原始 PiD | 增加 PiD 1.5 支持 |

升级使用的是上游最新官方 macOS release：

- Release：<https://github.com/leejet/stable-diffusion.cpp/releases/tag/master-782-b290693>
- 对应提交：<https://github.com/leejet/stable-diffusion.cpp/commit/b2906939774d>
- 官方变更：`feat: add PiD 1.5 support (#1790)`
- 下载包 SHA-256：`61620d31fa787d318ca1ec67ba73ef77b3236bc3a2dc891d66c161c7b075e45c`

旧版已保留在：

```text
/Users/kk/bin/backups/sd.cpp-7b5f34d-20260721T183000
```

升级后的运行文件 SHA-256：

```text
sd-cli                      510d86b3c1b787ce046c7d784806614577f01e4f4f4326eee17fb23d3a2d6713
sd-server                   b9db40e40cc42d4c731241006c34abfe2b82f8a6278da98ae7ae046fd2b651fb
libstable-diffusion.dylib   51ad73b952155c49f6be557cff6b4d68e6c1e10d5e51364b72ffc7f7791d2756
```

## 模型资产

本轮使用 PiD 1.5 FLUX.1 BF16 路线：

| 资产 | 本地路径 | 官方 LFS SHA-256 |
| --- | --- | --- |
| PiD 1.5 4-step BF16 | `/Users/kk/ComfyUI-Shared/models/diffusion_models/pid_1.5_flux1_1024_to_4096_4step_bf16.safetensors` | `18931256e97822dc31db10b1e7399c73e7ee2c897f6d461eb1d1cf5e1d2de049` |
| Gemma 2 2B ELM BF16 | `/Users/kk/ComfyUI-Shared/models/text_encoders/gemma_2_2b_it_elm_bf16.safetensors` | `e7ae59c203c392db4aa4e27783e924ec3225eb563392260cf747e1130ffcdb88` |
| FLUX VAE | `/Users/kk/ComfyUI-Shared/models/vae/ae.safetensors` | `afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38` |

来源：

- <https://huggingface.co/Comfy-Org/PixelDiT/tree/main/diffusion_models>
- <https://huggingface.co/Comfy-Org/PixelDiT/tree/main/text_encoders>
- <https://huggingface.co/nvidia/PiD/tree/main/checkpoints>

所有文件均在临时目录下载并完成 SHA-256 校验后，再原子移动到共享模型目录；没有覆盖同名现有模型。

## 测试输入

原始图片：

```text
/Users/kk/ComfyUI-Shared/input/idream-edit-src.png
832x1216
SHA-256 8525a21415fa5a6ea1c32117c28ddb84cc903fa72896207287bc99bab9c63a2c
```

该图片经目视确认为成年人 NSFW 图片。本轮保留原图不动，并生成 256x376 的测试副本：

```text
/Users/kk/ComfyUI-Shared/output/sdcpp-pid-nsfw-test-20260721/input-adult-nsfw-256x376.png
SHA-256 fbd9b9d80d6ce47503a02106222339cd08530bbf617ad5ec7699fe684c60ebf2
```

## 测试一：PiD 4x 超分

关键参数：

```text
reference: 256x376 adult NSFW image
output:    1024x1504
scale:     exactly 4x per dimension
steps:     4
sampler:   LCM (PiD default)
seed:      42
cfg:       1.0
backend:   Metal / Apple M4 Max
```

提示词包含明确成人描述：

```text
photorealistic explicit nude portrait of an adult woman, preserve the same adult subject, pose, anatomy, lighting, and skin detail
```

结果：

| 检查项 | 结果 |
| --- | --- |
| 模型识别 | `Version: PiD` |
| PiD 版本 | `pid: version = 1.5` |
| Gemma 条件编码 | 成功，1.59 s |
| 4-step 采样 | 成功，13.39 s |
| 总生成阶段 | 成功，15.55 s |
| CLI wall time | 16.29 s |
| 退出码 | `0` |
| swap | `0` |
| peak memory footprint | 11,174,191,648 bytes（约 10.41 GiB） |
| 输出 | 1024x1504 PNG，3,665,751 bytes |

输出与日志：

```text
/Users/kk/ComfyUI-Shared/output/sdcpp-pid-nsfw-test-20260721/pid15-nsfw-upscale-1024x1504.png
/Users/kk/ComfyUI-Shared/output/sdcpp-pid-nsfw-test-20260721/pid15-nsfw-upscale.log
```

输出 SHA-256：

```text
c19121afc743da5f9fdc53da1539bd6062ec9a07727c57cdd44cf5072c945f0f
```

## 测试二：PiD prompt-conditioned 图生图

保持同一个输入、同一个 seed 和相同输出尺寸，只修改提示词：

```text
photorealistic explicit nude portrait of the same adult woman, preserve identity and anatomy, change to warm amber studio lighting, deep charcoal bedroom background, cinematic skin highlights
```

结果：

| 检查项 | 结果 |
| --- | --- |
| 模型识别 | `Version: PiD` |
| PiD 版本 | `pid: version = 1.5` |
| 4-step 采样 | 成功，13.37 s |
| 总生成阶段 | 成功，15.41 s |
| CLI wall time | 16.14 s |
| 退出码 | `0` |
| peak memory footprint | 11,041,554,432 bytes（约 10.28 GiB） |
| 输出 | 1024x1504 PNG，3,661,393 bytes |

输出与日志：

```text
/Users/kk/ComfyUI-Shared/output/sdcpp-pid-nsfw-test-20260721/pid15-nsfw-img2img-1024x1504.png
/Users/kk/ComfyUI-Shared/output/sdcpp-pid-nsfw-test-20260721/pid15-nsfw-img2img.log
```

输出 SHA-256：

```text
737e2d6263fd07b3429265a570c9b4e2c54c0b4cc187c64b38936a3f5beadfd6
```

## 图生图能力边界

两次运行使用同一个 reference 和 seed，只改变 prompt。像素对比结果：

```text
MSE:                    0.206575
MAE:                    0.198495 / 255
maximum channel delta:  15 / 255
changed pixel fraction: 0.466317
PSNR:                   54.980026 dB
```

两张输出哈希不同，但视觉上几乎相同。这说明：

- 成人提示被正常编码，没有拒绝；
- PiD 对输入图做了生成式重建和超分；
- 但在 `degrade_sigma = 0` 的 sd.cpp PiD 路线上，prompt 的强语义编辑能力很弱；
- 这条能力不应包装成 Qwen-Image-Edit 一类通用图像编辑；
- sd.cpp 官方当前也把 PiD 定义为 `reference image -> VAE encode -> PiD decode/upscale`。

PiD 在这里的“扩图”是分辨率超分，不是扩画布 outpainting。sd.cpp PiD 路径没有 mask/canvas/outpaint 接口。

## 内容过滤判定

本轮日志中没有内容安全判定器或拒绝分支。运行链路是：

```text
adult NSFW pixels
  -> FLUX VAE encode
  -> Gemma 2 text condition
  -> PiD 1.5 pixel diffusion
  -> PNG save success
```

Gemma 2 阶段在 debug 日志中将以下成人词正常 tokenize：

```text
explicit / nude / adult / woman / anatomy / skin
```

随后完成 condition graph、4-step sampling 和 PNG 写盘。因此结论不是仅凭“源码看起来没有过滤”，而是有真实成人输入、显式成人 prompt、进程退出码和输出文件共同证明。

## 许可证与生产边界

`stable-diffusion.cpp` 代码是 MIT；本轮 NVIDIA PiD 权重仍是 NSCLv1，仅限非商业研究或评估。当前资产与结果只用于本地验证，**没有接入 iDream 商业生产路由**。

