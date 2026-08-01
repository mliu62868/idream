# ByteDance Lance：MLX、图生视频与成人内容验证可行性

日期：2026-07-30  
范围：官方代码与权重、Apple Silicon / MLX 社区移植、文本生图、首帧图生视频、许可证、资源需求、显式内容过滤、本机运行证据。  
本轮边界：先做一手来源与源码核验，再在独立社区 MLX 克隆上补最小 I2V 路径并实跑；**未修改 iDream 产品代码、生产路由、默认模型或配置**。

## 一句话结论

用户所说的模型准确对应 **ByteDance Intelligent Creation Lab 的 `Lance: Unified Multimodal Modeling by Multi-Task Synergy`**，不是 LanceDB。ByteDance 官方 CUDA 实现支持 `t2i` 和首帧 `i2v`；固定版本的社区 MLX 移植原本没有 I2V pipeline 或 CLI task。

本轮已按官方“首 4 帧经因果 Wan2.2 VAE 编码、固定首个 latent time slice、其余 latent 去噪”的机制，在独立 MLX 克隆上补出最小 I2V 路径并完成真实运行。结果证明：**Lance MLX 权重可以接收明确成年裸体首帧并生成仍保持裸体的有效视频，没有补衣、拒绝或空白输出。** 17 帧 smoke 出现了明显脸部重影；补跑的 49 帧 / 4.08 秒版本没有突发闪烁，但身份逐步变瘦、变老，眼睑和嘴形偏离源图，动作也弱于现有 LTX 2.3 输出。当前补丁只证明能力存在，**不构成上游 MLX 支持或生产可用性证明**。

## 1. 精确身份与版本

| 对象 | 精确版本（截至 2026-07-30） | 权威来源 |
| --- | --- | --- |
| ByteDance 官方代码 | `bytedance/Lance` main commit `4baeee086648996f6ab12e673cbe461b0b149997`，2026-07-14；官方未发布 tag/release | [固定 commit](https://github.com/bytedance/Lance/tree/4baeee086648996f6ab12e673cbe461b0b149997) |
| ByteDance 官方权重 | `bytedance-research/Lance` revision `7395315758865e6f56ab87ad06a88c7ac172f056`，2026-05-28 | [固定 revision](https://huggingface.co/bytedance-research/Lance/tree/7395315758865e6f56ab87ad06a88c7ac172f056) |
| 论文 | arXiv `2605.18678`，2026-05-18 | [论文](https://arxiv.org/abs/2605.18678) |
| 官方项目页 | Intelligent Creation Lab, ByteDance | [Lance 项目页](https://lance-project.github.io/) |
| 主要 MLX 移植代码 | 社区 `xocialize/lance-mlx` main commit `f8ecc5a86d28b94bd8dc688c200c3e22ffafff4a`，2026-06-21；不是 ByteDance 或 Apple 官方实现 | [固定 commit](https://github.com/xocialize/lance-mlx/tree/f8ecc5a86d28b94bd8dc688c200c3e22ffafff4a) |
| MLX 图像权重 | `mlx-community/Lance-3B-bf16` revision `5590eab019ab7c18bfce6b0c8dffa19f1d2052df` | [固定 revision](https://huggingface.co/mlx-community/Lance-3B-bf16/tree/5590eab019ab7c18bfce6b0c8dffa19f1d2052df) |
| MLX 视频权重 | `mlx-community/Lance-3B-Video-bf16` revision `b70ba0a53c14eef573570fe65b31e295bd8216af` | [固定 revision](https://huggingface.co/mlx-community/Lance-3B-Video-bf16/tree/b70ba0a53c14eef573570fe65b31e295bd8216af) |

版本坑：官方 Hugging Face 模型卡停在 2026-05-28，早于 GitHub 在 2026-05-29 加入 I2V，因此旧模型卡的 task 列表没有 `i2v`。能力事实应以固定后的 GitHub main 与官方 I2V changelog 为准；权重仍来自同一个官方 Hugging Face repo。[官方 I2V changelog](https://github.com/bytedance/Lance/blob/4baeee086648996f6ab12e673cbe461b0b149997/assets/docs/changelog/2026-05-29.md)

## 2. 模型与能力

Lance 是 3B active parameter 的原生统一多模态研究模型，使用统一上下文、理解/生成双路径与 staged multi-task training，覆盖图像和视频的理解、生成、编辑。[论文摘要](https://arxiv.org/abs/2605.18678)；[官方 README](https://github.com/bytedance/Lance/blob/4baeee086648996f6ab12e673cbe461b0b149997/README.md)

官方当前任务表：

| task | 能力 | checkpoint |
| --- | --- | --- |
| `t2i` | 文本生图 | `Lance_3B` |
| `image_edit` | 图像指令编辑 | `Lance_3B` |
| `x2t_image` | 图像理解/VQA | `Lance_3B` |
| `t2v` | 文本生视频 | `Lance_3B_Video` |
| `i2v` | 首帧图片 + 文本提示生成视频 | `Lance_3B_Video` |
| `video_edit` | 视频指令编辑 | `Lance_3B_Video` |
| `x2t_video` | 视频理解/VQA | `Lance_3B_Video` |

来源：[官方 README 的 supported tasks 与命令](https://github.com/bytedance/Lance/blob/4baeee086648996f6ab12e673cbe461b0b149997/README.md#inference)；[官方 `TASK_DEFAULT_CONFIGS`](https://github.com/bytedance/Lance/blob/4baeee086648996f6ab12e673cbe461b0b149997/inference_lance.py)。

I2V 不是把图片 prompt 偷换成 T2V。官方定义是：

```text
first-frame image + text prompt
  -> input image remains the visual anchor
  -> prompt conditions the motion
  -> temporally coherent generated video
```

输入 JSON 的权威格式为 `interleave_array: [prompt, image_path]`，类型为 `["text", "image"]`。[官方 I2V changelog](https://github.com/bytedance/Lance/blob/4baeee086648996f6ab12e673cbe461b0b149997/assets/docs/changelog/2026-05-29.md)；[官方 I2V 示例](https://github.com/bytedance/Lance/blob/4baeee086648996f6ab12e673cbe461b0b149997/config/examples/i2v_example.json)。

官方明确将本次发布定位为研究 artifact，而非成熟产品；训练覆盖到 768×768 图像、480p/12 FPS 视频，质量会随 prompt、分辨率、时长、运动复杂度与编辑场景变化。[官方 README 顶部说明](https://github.com/bytedance/Lance/blob/4baeee086648996f6ab12e673cbe461b0b149997/README.md)

## 3. 官方 CUDA 与 MLX 的能力边界

### ByteDance 官方实现

- Python 3.10+；
- CUDA 12.4+，明确标为 required；
- 推理至少 40GB VRAM；
- 官方验证组合为 A100 + PyTorch 2.8.0/cu126/flash-attn 2.8.3，或 PyTorch 2.5.1/cu124/flash-attn 2.6.3；
- 图像推荐 768×768；
- 视频训练/发布口径为 480p、12 FPS，脚本允许最多 121 帧。

来源：[官方 Installation 与参数表](https://github.com/bytedance/Lance/blob/4baeee086648996f6ab12e673cbe461b0b149997/README.md#installation)。

官方权重仓库的主要大文件：

| 文件 | 十进制大小 | 二进制大小 | SHA-256 |
| --- | ---: | ---: | --- |
| `Lance_3B/model.safetensors` | 12.37GB | 11.52GiB | `a2cfed3992486699aa550c1ea9b3519bd19dde475a0992daf2249f2486b268a3` |
| `Lance_3B_Video/model.safetensors` | 14.21GB | 13.24GiB | `7f0550e1d1511b29a4740a67c1e18e176302a4ecb3177c8a5850ff5fe6447c25` |
| `Qwen2.5-VL-ViT/vit.safetensors` | 1.34GB | 1.25GiB | `78714e560781576a00c030e60383db3c71698083d0c5d493dc628c10dc1a9094` |
| `Wan2.2_VAE.pth` | 2.82GB | 2.63GiB | `20eb789667fa5e60e7516bf509512f6cb61f01b0aa0695eadaea930c13892b36` |

全套四个大权重合计约 30.74GB / 28.63GiB。只计算 I2V 的 video + ViT + VAE 约 18.37GB / 17.11GiB；磁盘文件大小不等于运行峰值，官方运行口径仍是至少 40GB VRAM。文件事实可在[固定 HF revision](https://huggingface.co/bytedance-research/Lance/tree/7395315758865e6f56ab87ad06a88c7ac172f056)复核。

### MLX 社区实现

MLX 路径来自社区 `xocialize/lance-mlx` 与 `mlx-community` 权重转换，不是 ByteDance 官方 backend。[MLX 源码 README](https://github.com/xocialize/lance-mlx/blob/f8ecc5a86d28b94bd8dc688c200c3e22ffafff4a/README.md)；[MLX 权重合集](https://huggingface.co/collections/mlx-community/lance-mlx)。

固定 commit 的 CLI 只允许：

```text
t2i
t2v
image_edit
video_edit
x2t_image
x2t_video
```

源码只有 `t2i.py`、`t2v.py`、`image_edit.py`、`video_edit.py` 和 understanding pipeline；没有 `i2v.py`，CLI dispatch 也没有 `i2v`。[固定 CLI 源码](https://github.com/xocialize/lance-mlx/blob/f8ecc5a86d28b94bd8dc688c200c3e22ffafff4a/src/lance_mlx/__main__.py)；[固定 pipeline 目录](https://github.com/xocialize/lance-mlx/tree/f8ecc5a86d28b94bd8dc688c200c3e22ffafff4a/src/lance_mlx/pipeline)。

因此：

| 目标 | 现成 MLX 状态 |
| --- | --- |
| Lance 文本生图 | 支持，使用 `Lance-3B-bf16` |
| Lance 文本生视频 | 支持，使用 `Lance-3B-Video-bf16` |
| 成人首帧图片 → Lance 视频 | 上游固定版本不支持；本轮本地实验补丁已实跑成功 |
| 把首帧当作视频编辑输入 | 不是已验证的 I2V 等价路径，不采用 |

另一个独立社区 port `RockTalk/Lance-3B-Video-MLX` 的模型卡只把 T2V/T2I 标为 working；text+image→video edit 仍是 “architecture in place, untested”，同样不是可用、已验证的 I2V 路径。[RockTalk 模型卡](https://huggingface.co/RockTalk/Lance-3B-Video-MLX)

MLX bf16 bundle：

| bundle | 大权重合计 |
| --- | ---: |
| `Lance-3B-bf16` 的 model + ViT + VAE | 15.12GB / 14.08GiB |
| `Lance-3B-Video-bf16` 的 model + ViT + VAE | 15.62GB / 14.55GiB |

文件与 revision：[图像 bundle](https://huggingface.co/mlx-community/Lance-3B-bf16/tree/5590eab019ab7c18bfce6b0c8dffa19f1d2052df)；[视频 bundle](https://huggingface.co/mlx-community/Lance-3B-Video-bf16/tree/b70ba0a53c14eef573570fe65b31e295bd8216af)。

MLX port 的实测/自报边界需要保留：

- 参考平台是 M5 Max 128GB，不是当前 M4 Max 128GB；
- `LIMITS.md` 的测量结论是 8GB 不应尝试，16GB 是可加载和低规格运行的现实下限；
- 256²×121 帧在 16GB 上 lossless decode 约 8.05GB，端到端约 9.8GB；
- 512²×61 帧 lossless decode 约 12.64GB；
- 768²×13/25 帧 lossless decode 超过约 21GB，下限仍未精确测得；16GB 只能使用有损 decode；
- 该 port 声称的可用质量包络是 `n_lat <= 16,128`，例如 480×704×17 帧；
- 480×848×121 帧约落在 `n_lat >= 30k` 的已知 mesh-artifact 退化区，不能把官方 CUDA 的完整 480p/121 帧规格照搬到 MLX；
- 当前 M4 Max 128GB 内存充足；本轮已获得本机 I2V 速度、内存和画质数据，但使用的是未上游化的本地实验补丁。

来源：[固定 `LIMITS.md`](https://github.com/xocialize/lance-mlx/blob/f8ecc5a86d28b94bd8dc688c200c3e22ffafff4a/LIMITS.md)；[MLX video 模型卡的 hardware/quality envelope](https://huggingface.co/mlx-community/Lance-3B-Video-bf16)。

## 4. 许可证

| 资产 | 许可证 | 证据 |
| --- | --- | --- |
| `bytedance/Lance` 代码 | Apache-2.0 | [官方 LICENSE](https://github.com/bytedance/Lance/blob/4baeee086648996f6ab12e673cbe461b0b149997/LICENSE) |
| `bytedance-research/Lance` 权重 | Hugging Face card metadata 标记 Apache-2.0 | [官方模型页](https://huggingface.co/bytedance-research/Lance) |
| `xocialize/lance-mlx` 代码 | Apache-2.0 | [MLX port LICENSE](https://github.com/xocialize/lance-mlx/blob/f8ecc5a86d28b94bd8dc688c200c3e22ffafff4a/LICENSE) |
| `mlx-community` Lance bf16 转换权重 | 模型卡标记 Apache-2.0，并保留 Lance/Wan/Qwen provenance | [图像模型卡](https://huggingface.co/mlx-community/Lance-3B-bf16)；[视频模型卡](https://huggingface.co/mlx-community/Lance-3B-Video-bf16)；[port NOTICE](https://github.com/xocialize/lance-mlx/blob/f8ecc5a86d28b94bd8dc688c200c3e22ffafff4a/NOTICE) |

许可证允许本地研究与商业集成，但许可证不证明成人内容能力、质量或生产 readiness。

## 5. 是否有显式成人内容过滤

### 已确认

对 ByteDance 固定 commit 的全部 Python/shell/JSON/Markdown/YAML 做了以下源码扫描：

```bash
git grep -niE \
  'nsfw|porn|sexual|nude|nudity|moderation|content_filter|underage|csam|blacklist|blocked' \
  4baeee086648996f6ab12e673cbe461b0b149997 -- \
  '*.py' '*.sh' '*.json' '*.md' '*.yaml' '*.yml'
```

没有发现用于本地推理的 prompt 拒绝、输出图/视频审核或成人关键词 blacklist。官方推理入口直接把本地配置中的 prompt/media 送入模型。[官方 inference entrypoint](https://github.com/bytedance/Lance/blob/4baeee086648996f6ab12e673cbe461b0b149997/inference_lance.py)。

`ENHANCE_PROMPT` 默认是 `false`。只有显式打开后，代码才会把 T2V/I2V prompt（I2V 还包括首帧图片）送往用户配置的 OpenAI-compatible rewrite service；第三方服务可以自行改写或拒绝请求。[官方 prompt rewrite 源码](https://github.com/bytedance/Lance/blob/4baeee086648996f6ab12e673cbe461b0b149997/common/utils/caption_rewrite.py)；[官方参数说明](https://github.com/bytedance/Lance/blob/4baeee086648996f6ab12e673cbe461b0b149997/README.md#parameters)。

为隔离 Lance 权重本身，成人能力探针应固定：

```text
ENHANCE_PROMPT=false
local inference only
adult-only source asset
same image / prompt / seed / frame count across retries
```

### 仍未确认

- 官方模型卡、README、论文与源码没有成人内容 benchmark；
- 没有官方 “uncensored/NSFW” checkpoint；
- 本轮只有一个固定 prompt / seed 的 17 帧 smoke 和 49 帧长程探针，不能证明跨角色、跨 seed 的稳定性；
- 本轮已经观察到脸部身份漂移，因此不能把“17/17 和 49/49 帧保留裸体”外推为角色一致性或生产质量。

所以“没有显式代码过滤”与“本轮成功生成”合起来，只能证明该固定权重和本地运行路径**可以**生成成人裸体 I2V；不能证明它能稳定、高质量地生成所有成人内容。

## 6. 最小可复现命令

6.1、6.2 是固定官方源码的参考命令，本轮没有 CUDA 执行；6.3 保留上游 MLX smoke 命令。本轮真实 MLX I2V 命令和结果见第 7 节。

### 6.1 ByteDance 官方 CUDA：T2I

自定义 `t2i_test.json`：

```json
{
  "000000.png": "<adult-only test prompt>"
}
```

执行：

```bash
git clone https://github.com/bytedance/Lance.git
cd Lance
git checkout 4baeee086648996f6ab12e673cbe461b0b149997

bash inference_lance.sh \
  --TASK_NAME t2i \
  --MODEL_PATH downloads/Lance_3B \
  --CONFIG_PATH /absolute/path/to/t2i_test.json \
  --RESOLUTION image_768res \
  --VIDEO_HEIGHT 768 \
  --VIDEO_WIDTH 768 \
  --ENHANCE_PROMPT false \
  --SAVE_PATH_GEN results/t2i-test
```

来源：[官方 T2I 命令](https://github.com/bytedance/Lance/blob/4baeee086648996f6ab12e673cbe461b0b149997/README.md#text-to-image)；[官方 T2I JSON 示例](https://github.com/bytedance/Lance/blob/4baeee086648996f6ab12e673cbe461b0b149997/config/examples/t2i_example.json)。

### 6.2 ByteDance 官方 CUDA：现有首帧 I2V

自定义 `i2v_test.json`：

```json
{
  "0001": {
    "interleave_array": [
      "<motion prompt grounded in the input image>",
      "/absolute/path/to/adult-only-first-frame.png"
    ],
    "element_dtype_array": [
      "text",
      "image"
    ],
    "istarget_in_interleave": [
      0,
      0
    ]
  }
}
```

执行：

```bash
bash inference_lance.sh \
  --TASK_NAME i2v \
  --MODEL_PATH downloads/Lance_3B_Video \
  --CONFIG_PATH /absolute/path/to/i2v_test.json \
  --RESOLUTION video_480p \
  --NUM_FRAMES 61 \
  --VIDEO_HEIGHT 480 \
  --VIDEO_WIDTH 848 \
  --ENHANCE_PROMPT false \
  --SAVE_PATH_GEN results/i2v-test
```

61 帧 / 12 FPS 约为 5.08 秒。先跑官方 61 帧示例，不应第一枪就拉到 121 帧。来源：[官方 I2V 命令与参数](https://github.com/bytedance/Lance/blob/4baeee086648996f6ab12e673cbe461b0b149997/README.md#image-to-video)；[官方 I2V JSON](https://github.com/bytedance/Lance/blob/4baeee086648996f6ab12e673cbe461b0b149997/config/examples/i2v_example.json)。

### 6.3 MLX：当前可跑的 T2I/T2V smoke

```bash
git clone https://github.com/xocialize/lance-mlx.git
cd lance-mlx
git checkout f8ecc5a86d28b94bd8dc688c200c3e22ffafff4a
uv sync

uv run lance-mlx generate \
  --task t2i \
  --prompt "<adult-only test prompt>" \
  --weights mlx-community/Lance-3B-bf16 \
  --resolution 768 \
  --steps 30 \
  --seed 42 \
  --output outputs/lance-t2i

uv run lance-mlx generate \
  --task t2v \
  --prompt "<adult-only motion prompt>" \
  --weights mlx-community/Lance-3B-Video-bf16 \
  --resolution 256 \
  --frames 16 \
  --fps 12 \
  --steps 30 \
  --seed 42 \
  --output outputs/lance-t2v
```

来源：[固定 MLX README quick start](https://github.com/xocialize/lance-mlx/blob/f8ecc5a86d28b94bd8dc688c200c3e22ffafff4a/README.md#quick-start-after-pypi-release)；[固定 CLI](https://github.com/xocialize/lance-mlx/blob/f8ecc5a86d28b94bd8dc688c200c3e22ffafff4a/src/lance_mlx/__main__.py)。

MLX I2V：

```text
上游固定 commit 没有可复现命令；本轮命令依赖第 7 节记录的本地实验补丁。
```

## 7. 本机 MLX I2V 实跑

### 7.1 实验实现

独立克隆：`/Users/kk/code/lance-mlx`  
基线：`xocialize/lance-mlx@f8ecc5a86d28b94bd8dc688c200c3e22ffafff4a`

本轮只修改该独立克隆：

- `src/lance_mlx/pipeline/t2v.py`：可选加载 Wan2.2 VAE encoder；将输入图重复到首 4 个因果帧并编码；首个 latent time slice 使用 `t=0`、不参与 velocity update，并在每一步重新注入；
- `src/lance_mlx/__main__.py`：增加实验性 `--task i2v`，并允许视频宽高分别指定；
- `tests/test_i2v.py`：覆盖 I2V 必须加载 VAE encoder，以及输入缩放/归一化形状与范围。

这不是 `video_edit` 包装，也不是上游已发布功能。实现依据是 ByteDance 官方 I2V 对首个 latent time slice 的固定策略；仍缺少官方 CUDA 输出的数值 parity oracle。

验证：

```text
pytest: 118 passed, 2 skipped, 2 warnings
python -m compileall -q src: pass
git diff --check: pass
CLI help: i2v / --height / --width 可见
```

### 7.2 权重与设备

设备：

```text
Apple M4 Max
128GB unified memory
macOS 26.5.1 arm64
```

实际使用 `mlx-community/Lance-3B-Video-bf16@b70ba0a53c14eef573570fe65b31e295bd8216af`，I2V 不加载 ViT：

| 文件 | 字节 | 实际 SHA-256 |
| --- | ---: | --- |
| `model.safetensors` | 12,874,477,622 | `2d9cacd1879c24e757e9dc6382942bb4faace0ec27a9d712a265f149c1278ace` |
| `vae.safetensors` | 1,409,401,642 | `707e20bb83bdffff77774e04275d64b5ee8660f98390ce362538078d020b6807` |

两个哈希均与固定 Hugging Face revision 的 LFS OID 一致。

### 7.3 成人首帧

iDream 当前 Qwen Rapid-AIO NSFW v19 路径生成了新的明确成年虚构女性裸体首帧：

```text
路径: /Users/kk/code/idream/output/lance-nsfw-probe/qwen-v19-source.png
尺寸: 832x1216
seed: 73921
steps: 4
耗时: 99.727 秒
SHA-256: 0c6bd429d8ec0f7341961385ddee07234946338148c5fc8d0a008b80c09899e7
```

生成成功，无拦截、替换图或衣物补全。

### 7.4 I2V 命令

```bash
uv run lance-mlx generate \
  --task i2v \
  --image /Users/kk/code/idream/output/lance-nsfw-probe/qwen-v19-source.png \
  --prompt "A steady cinematic portrait of the same clearly adult fictional woman. She takes a slow breath, subtly shifts her weight, blinks naturally, and her dark wavy hair moves gently in warm morning air. Keep her nude body, face, anatomy, bedroom, and lighting consistent. Stable camera, natural restrained motion, no scene cut." \
  --weights /Users/kk/models/Lance-3B-Video-bf16 \
  --height 560 \
  --width 384 \
  --frames 17 \
  --fps 12 \
  --steps 30 \
  --seed 4242 \
  --output /Users/kk/code/idream/output/lance-nsfw-probe
```

先行 VAE 探针：

```text
输入: (1, 4, 560, 384, 3), range [-1.0, 0.97647]
首帧 latent: (1, 1, 35, 24, 48)
latent mean/std: -0.03745 / 0.57948
耗时: 0.383 秒
```

### 7.5 17 帧 smoke 结果

```text
路径: /Users/kk/code/idream/output/lance-nsfw-probe/i2v_4242.mp4
编码: H.264 yuv420p
尺寸: 384x560
帧率/帧数: 12 FPS / 17
时长: 1.416667 秒
文件大小: 361,459 bytes
SHA-256: 465c806e7d2f1cc6c36cc85a9dfbadd683fa194d798926135142e104f058980a
模型加载: 9.5 秒
端到端实时时间: 220.29 秒
预解码 MLX peak: 16.39GB
VAE decode MLX peak: 24.24GB
swap: 0
```

首帧保持：

```text
源图缩放到 384x560 后与视频首帧：
SSIM: 0.990213
PSNR: 44.349791 dB

视频首帧与尾帧：
SSIM: 0.955446
```

内容与画质检查：

- 17/17 帧均保留明确成年裸体，没有补衣、拒绝、空白帧或场景切换；
- 身体、四肢、床铺、光照与构图总体稳定，存在轻微非静态运动；
- 第 1–5 帧脸部接近源图；
- 从约第 6 帧的眨眼阶段开始出现明显眼部不对称、鼻口重影和年龄感漂移，后续没有完全恢复；
- 动作幅度偏小，尚未证明大动作、长时长或多 seed 稳定性。

### 7.6 49 帧 / 4.08 秒长程结果

用户指出 17 帧视频过短后，使用同一首帧、prompt、seed、分辨率、FPS 和 30 steps，把 latent 序列扩展到 49 帧。由于 latent 数量不同，相同 seed 不代表前 17 帧与短视频逐像素一致。

```text
路径: /Users/kk/code/idream/output/lance-nsfw-probe/49f-seed4242/i2v_4242.mp4
编码: H.264 yuv420p
尺寸: 384x560
帧率/帧数: 12 FPS / 49
时长: 4.083333 秒
文件大小: 1,150,646 bytes
SHA-256: 3d1ed785489c8e9d89430f178a55031309833d25f0e62ba5cf72565ccfce2b3c
模型加载: 6.1 秒
端到端实时时间: 790.76 秒
预解码 MLX peak: 18.22GB
VAE decode MLX peak: 24.80GB
swap: 0
```

首帧与变化：

```text
源图缩放后与视频首帧 SSIM: 0.990184
视频首帧与尾帧 SSIM: 0.635026
```

逐帧检查：

- 49/49 帧均保留明确成年裸体，没有补衣、拒绝、空白帧或场景切换；
- 身体、四肢、床铺、构图和光照稳定，姿态与视线有连续变化；
- 49 个脸部帧之间没有 17 帧 smoke 中的突发重影或明显闪烁；
- 身份仍逐步变瘦、变老，眼睑和嘴形偏离源图，尾段没有恢复；
- 动作仍偏克制，动态表现明显弱于现有 768x1152、97 帧、3.88 秒的 LTX 2.3 GTAnimation 实跑。

长程结果修正了“Lance 从第 6 帧后必然严重重影”的过度概括，但没有改变当前模型选择：Lance 能稳定承载成人裸体内容，角色身份与运动质量仍落后于现有 LTX 2.3 路径。

### 7.7 最终判定

```text
Lance 官方 T2I：有
Lance 官方 I2V：有
Lance 官方 Apple/MLX：没有
社区 MLX T2I/T2V：有
社区 MLX 上游 I2V：没有
本轮实验性 MLX I2V：真实运行成功
显式本地成人过滤：未发现
成人裸体保持：17/17 与 49/49 帧成功
身份/脸部质量：短 smoke 有重影，长片连续但持续漂移，不达到生产标准
当前效果排序：LTX 2.3 GTAnimation 优于 Lance MLX
产品路由/default：未接入、未变更
```

结论：Lance 在 Apple Silicon MLX 上生成成人裸体 I2V **技术上可行**；当前本地补丁足以证明能力，但不足以成为 iDream 生产候选。下一阶段如果要评估候选资格，应先补官方 CUDA parity、至少 5 个 seed / 3 个角色、61 帧规格，以及脸部一致性与闪烁评分。
