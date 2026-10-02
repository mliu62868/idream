# LTX 2.5 Gemma 4 MLX 编码加速

2026-10-02。LTX 专用 Gemma 4 12B 已接入原生 Comfy 的 `CLIP` 节点。独立编码对照和完整视频通过后，开发库默认 profile 发布为 v4、workflow 发布为 v3，Comfy UI 预设已同步。执行仍由 Gen workflow-native backend 管理，没有恢复已退役的 `mlx` runner。

## 已测量的变化

本机 M4 Max 40 GPU / 128 GB、macOS 26.5.1；实际 video venv 为 Python 3.13 / Torch 2.10.0、MLX 0.32.2、mlx-metal 0.32.2、mlx-lm 0.31.3。Comfy checkout `c645560264062e6a5b0688d25eaf3ee9906a7709`。GPU 实验共用现有 `withGenerationAcceleratorLease("video")`，先检查各原生队列为空并释放闲置模型，按顺序执行。

| 同一正向＋负向提示词 | 模型加载 | 编码 | 加载＋编码 |
| --- | ---: | ---: | ---: |
| 原生 CPU INT8 ConvRot | 1.524 s | 29.733 s | 31.258 s |
| MLX Q8，完整 1024 token | 2.289 s | 5.916 s | 8.206 s |
| MLX Q8，去除无效左 padding | 4.614 s | 0.972 s | 5.586 s |
| CPU INT8 完整视频之后的复测 | 1.567 s | 29.220 s | 30.788 s |
| 最终 MLX Q8 复测（同一模型文件缓存） | 1.932 s | 0.779 s | 2.711 s |

这是独立进程的单次对照，文件系统缓存、初始化与主机负载会影响加载时间，不代表稳定延迟分布，更不能把纯编码倍率当成完整视频倍率。英文正向、英文负向、空提示词、中文提示词、另一英文场景共 5 组对照：tokenizer 输出、conditioning 形状和 metadata 完全一致，全部有限 FP32；平均 token cosine 最低 `0.9995501`、单 token 最低 `0.9989526`，范数比 `0.99923–1.003932`。预设通过门槛为平均 cosine≥0.995、最低≥0.99、范数比 0.9–1.1。量化存在误差，不能称逐位相同或视频无损。

单独比较 Q8 的完整 padding / 去 padding：相对 RMSE `1.33e-6–5.56e-6`、最低 token cosine `0.9999994`。原 tokenizer 仍生成原来的 token；仅执行前删除被 causal mask 排除的左侧零 token。Gemma 使用相对 RoPE，统一平移有效 token 不改变理论注意力关系。

编码 owner 持有约 14.818 GiB MLX 权重。两分支都完成后，显式 `release` 连线触发原有内存 barrier；独立实测释放后的 MLX active memory 为 28 bytes。取消/异常路径也释放 owner 并传播原错误。每个新图执行重新构造 loader，避免缓存被释放的对象。

真实权重取消测试额外发现：仅清空 owner 时，保留的异常 traceback 仍持有已结束的 layer frame，留下 **13,599,178,796 bytes** 活跃内存。清理已结束的异常帧后，同一第二层取消场景（继续保留异常对象）只剩 **28 bytes，cache 0**。CPU weakref 回归先失败再通过。此异常路径修正在完整视频之后追加；正常编码路径未改，并重新运行全部五组真实 conditioning 对照。前后证据为 `cancellation-before.json` / `cancellation-after.json`，视频时点与最终源码 manifest 分开保存。

## 权重来源与精度边界

采用 [Lightricks 官方 INT8 文件](https://huggingface.co/Lightricks/LTX-2.5/blob/5e6e71018ee1756ed329b697a7b4aedc934dfce9/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors)，源 SHA-256 `6ce688a0aa98a5fa36a9f1e6c3f42152a498cc2b53ee8c15674c64244f91487f`。这就是此前本地使用的量化来源。本地转换使用其实际 ConvRot inverse，恢复有效权重至 BF16，再将 328 个 decoder Linear 转成 MLX affine Q8 / group 64。embedding、norm 和已训练双 projection 保持原有 BF16。转换有额外舍入，未恢复原始训练 BF16，也不是第三方发布的 MLX Q8 成品。

生成文件 `/Users/kk/ComfyUI-Shared/models/text_encoders/gemma4-12b-ltx-v1-mlx-q8.safetensors`，15,940,470,042 bytes；SHA-256 `dcb072acbec50ea10ca22d3dcc24667f1a85b6788dc6f9ed8e4da4edff8c7790`。保留原 tokenizer JSON 和完整来源 metadata。

公开社区 `vanch007/LTX-2.5-mlx` Q4 和受限 Q8 的核查见[社区来源研究](LTX25_GEMMA4_MLX_COMMUNITY_2026-10-02.md)。Q4 的完整下载与 conditioning / 视频验证没有完成，因此没有默认采用。当前 128 GB 主机的 Q8 已将编码降到秒级，并可在采样前释放权重；更低 bit 的潜在加载/内存收益需要另外验证。

## 实现与复现

- `packages/gen/comfyui_nodes/idream_gemma4_mlx/encoder.py` 使用 Apple `mlx-lm` 的 Gemma 4 层，保留 49 个状态（embedding＋48 层，最后一层经过 final norm）。全部激活采用 FP32，projection 按 hidden-major / layer-minor 展平，在 hidden 维做 RMS 后执行原训练双 projection。输出保持 Comfy 的 `unprocessed_ltxav_embeds=True` 契约，不重复执行 DiT connector。
- 同目录 `prepare.py` 校验源文件 SHA，拒绝覆盖已有模型，记录转换来源。Q4 下载路径按固定 revision 和 LFS SHA 校验；下载成功不等于质量验收。
- `idream_memory_lifecycle` 调用 owner 的 `release_completed()`；其余活跃的 Torch diffusion/VAE 保留原有生命周期。

在现有 video Comfy venv 中安装 `packages/gen/comfyui_nodes/idream_gemma4_mlx/requirements.txt` 的三项固定依赖。此次先检查 dependency resolver，再用 `pip install --no-deps` 安装，没有改变已有 Torch/Transformers。准备 Q8：

```sh
'/Users/kk/ComfyUI-Installs/idream (1)/ComfyUI/.venv/bin/python3' \
  packages/gen/comfyui_nodes/idream_gemma4_mlx/prepare.py \
  --source-comfy-int8 /Users/kk/ComfyUI-Shared/models/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors \
  --destination /Users/kk/ComfyUI-Shared/models/text_encoders/gemma4-12b-ltx-v1-mlx-q8.safetensors
```

固定发布的模型按完整文件 SHA 校验。新准备的文件必须重新核验；不自动接受不同 hash 的重建文件。原生服务变更使用 `bun run comfyui:restart`，产品服务/工作者使用 README 中的 PM2 wrapper。

证据目录 `.scratch/ltx25-gemma4-mlx-20261002/`：`baseline-report.json`、`q8-full-report.json`、`q8-trim-report.json`、`padding-comparison.json`、各实际 conditioning 张量、`native-source-manifest.json`。完整视频的日志与结果另外保存，不把数值单测当成真实视频或 Main 交付证明。

## 完整视频与发布

原生 prompt `6ba75cfd-eb60-4ca1-a346-87250482aa79`，节点缓存为空，实际执行文本、两阶段采样、latent upscale、视频/音频 VAE 与 MP4 保存。输入沿用已审阅成年人物 `ltx23-gtanimation-alexa-reeves.webp`，seed `2026082801` / refiner `2026082802`。完整墙钟 **735.826 秒（12 分 16 秒）**。WebSocket 节点观测：Gemma 加载 3.142 秒、正负编码合计 1.552 秒、两个采样阶段合计 674.314 秒、视频解码 42.289 秒；极短节点的异步事件时间不当作精确 CPU profiling。日志明确记录 barrier 丢弃 15,171 MB MLX owner。

`ffprobe` 确认 H264、768×1152、24 fps、121 帧、5.041667 秒；AAC、48 kHz、双声道、5.01 秒。全量解码无错误；音频 mean −21.3 dB / peak −1.4 dB。抽查首帧、逐秒和末帧，人物身份、游艇背景、挥手与说话动作连续，没有黑/绿/冻结帧；手部运动有局部模糊。没有验证台词逐字正确、精确口型或多 seed 保真。本次没有同环境的完整 CPU Gemma 视频 A/B，不能把编码的约 30 倍加速外推成整段视频倍率。

输出 `.scratch/ltx25-gemma4-mlx-20261002/q8-full-video.mp4`，SHA-256 `b22cf1066cfac66a5096653f88da0a951b082d6d1ca995478fb933f239263dd1`，详情为 `backend-report.json`、`backend-history.json`、`media.json`、`contact-sheet.png`、`audio-check.log`。实测 Python 源码 SHA 保存在 `native-source-manifest.json`；验收图与 canonical 图仅运行输入、输出前缀和展示 metadata 有差异，Gemma/采样接线相同。

开发库目标已核对为 `localhost:5433/idream_runtime_20260812`。通过 PM2 wrapper 暂停/排空并停止应用，执行 `db/sql/2026-10-02-redgraft-gemma-mlx.sql`，发布 `profile_video_redgraft_ltx25_v1-gemma-mlx-v4`；历史 v2 原参数与任务保留。原 v3 参数选项草稿复制为 **v5，仍为 disabled draft**，原草稿归档；当前 draft importer 对齐 v5。Main/Gen 的选项版本共用 recipe 的 `optionsProfileVersion`，不修改价格或自动开放新参数。

发布后实际数据库行通过 Main authority 判断，且 Comfy UI 预设保存成功。workflow fingerprint 为 `202540439940175d626936875092f608e74a108f6c3ba5b183a7c3b5bf2a7b46`。preflight 检查 10 个 descriptors、75 种节点、29 个模型引用和 13 个完整模型 byte hashes，0 问题。应用恢复后的进程、revision、队列状态记录在同目录 `runtime-verification.json`。本次真实运行范围为原生 backend；Main 交付、持久化、额度与参数组合只做自动化回归，未冒充完整真实产品验收。

相关回归共 119 项通过：Gemma Python 6、内存生命周期 9、Gen 60、Shared 19、Main profile 10、Main 数据库/视频序列 15。Main 与 Gen typecheck、修改的 Main 文件 ESLint 通过。组合运行暴露视频序列测试删除 Job 后遗留 queued Attempt，已将该套件的未完成 fixture 清理补齐，发布守卫保持严格拒绝真实待处理任务。未运行全仓 CI 或多 seed 真实视频套件。
