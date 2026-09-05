# LTX 2.5 Gemma 4 Q4 社区最佳实践调研

日期：2026-09-05。范围：LTX 专用文本编码器，Apple M4 Max / 当前 ComfyUI；只读调研与文档记录，没有下载权重、切换模型或修改服务。

## 结论

**Q4 值得做受控实验，最值得争取的是“独立 GPU 文本编码 + 合适的量化内核”，不能把换成小文件直接等同加速。** 当前工作流明确指定 CPU 编码；先测现有 INT8 在 CPU/MPS 的差异，再测 MLX Q8/Q4，才能区分设备收益和量化收益。社区已经有 LTX 专用 Gemma 4 Q4 成功生成案例，同时也有因 conditioning 偏差拒绝 INT4 的案例，因此不存在“所有 Q4 都可无损替换”的共识。

## 当前本机起点

本轮主任务核对：Apple M4 Max；仓库 revision `bae20386f636bfb59389829d8574063f5339263d`；8188 listener PID 9353。

- `packages/gen/workflows/redgraft-ltx25-i2v.json:664` 的 `CLIPLoader` 选择 `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors`，`device=cpu`；同文件 748 行附近在 conditioning 后执行 `IDreamUnloadOffDeviceModels`。
- 本机 ComfyUI `comfy/text_encoders/lt.py` 取 `layer=all`，投影输入维数为 `hidden_size * (num_hidden_layers + 1)`，使用 video/audio 双投影，tokenizer 最短 padding 为 1024。普通 Gemma 聊天模型、只输出最后一层的服务不满足该契约。
- 本机 `ComfyUI-GGUF/loader.py` 的 `TXT_ARCH_LIST` 没有 `gemma4`；`ops.py` 先 `dequantize_tensor` 再 `F.linear`。GGUF 是格式，此路径不能等同于 llama.cpp 的原生 Q4 matmul。

## 社区方案与证据

| 方案 | 已核验内容 | 对本机的判断 |
| --- | --- | --- |
| Winnougan W4A8 ConvRot | HF 文件目录实际只有 `gemma4-12b-with-proj-ltx-2.5-w4a8_convrot.safetensors`，10,604,323,186 bytes；模型卡列出的独立 INT4 encoder 本次未见文件 | 最接近当前 Comfy 原生量化路线，但没有 M4 encoder 速度/质量 A/B |
| Rootport GGUF Q4_K_M | 9,231,374,624 bytes，328 个 Q4_K、2 个 Q6_K，其余 356 个保留原精度 | 真正的 Q4 社区发布，但目标是 Nz-Videomni `engine25`；不推定直接兼容 ComfyUI |
| elix3r GGUF Q5_K_M | 9,514,920,864 bytes，包含 LTX 双投影与 tokenizer；配套 ComfyUI-GGUF patch | 有 RTX 4070 Ti SUPER 端到端兼容证据，可作为 GGUF 接口参考；没有 BF16 质量对照 |
| vanch007 MLX Q4 | `gemma4-q4` affine 4-bit/group 64 + DiT Q8，M3 Max 128 GB 的 480×704×97 / 8 步报告 619.57 秒、17.05 GiB 峰值、零 swap | 证明 Apple Silicon 上此路线能生成；并未隔离 encoder 耗时，也没有 Q8/Q4 同配置对照 |
| mlx-community / xocialize | encoder INT8 group64、保留 embedding BF16；作者特定实验拒绝 INT4 | 提供质量校准方法；否决结论仅限该实验，不能覆盖 GGUF、ConvRot 或所有 MLX Q4 |
| WeeTodd-Nodes MLX | 提供 `convert_ltx25_paged_q8.py gemma` 与阶段卸载/MLX Comfy 节点 | 可借鉴单独编码器的加载与回收；整套 Q8 paging 数据不能冒充 Gemma Q4 加速数据 |

来源：[Winnougan 模型卡](https://huggingface.co/Winnougan/ltx-2.5-w4a8-convrot-int4-convrot-Winnougan-Blessing/blob/main/README.md)、[实际文件目录](https://huggingface.co/Winnougan/ltx-2.5-w4a8-convrot-int4-convrot-Winnougan-Blessing/tree/main/text_encoders)、[Rootport](https://huggingface.co/Rootport/Nz-Gemma4-12B-LTX25)、[elix3r](https://huggingface.co/elix3r/gemma4-12b-with-proj-ltx-2.5-GGUF/blob/main/README.md)、[vanch007](https://huggingface.co/vanch007/LTX-2.5-mlx)、[mlx-community](https://huggingface.co/mlx-community/ltx-2.5-mlx)、[WeeTodd-Nodes](https://github.com/wee-todd/WeeTodd-Nodes)。

Winnougan 的做法是只量化 decoder 的 attention/MLP 大矩阵，保留 embedding、norm、vision、LTX projection 等；需要 `AsymW4A8Int8Layout` 支持。作者明确没有独立确认 INT8 保护名单在 INT4/W4A8 下最优。文件 SHA-256 为 `720a028bed0b776a31ceacbdfcf52edb54a9a4ab203c9a3b148299d147d0b4d5`。模型卡“fastest”不是 M4 性能报告。

mlx-community 的同一指标给出 BF16 floor 0.999879、INT8 0.999820、INT4 0.996728；INT8 encoder resident 24.42→14.20 GB。其警告特别针对默认 `mlx_lm.convert -q` 会量化 `embed_tokens`，以及部分 mixed 配方把 tied embedding 降到 3-bit。该数值属于 conditioning 保真证据，不等于每个 prompt 都能感知到退化，也不是 INT4 不会提速的证据。[实验说明](https://huggingface.co/mlx-community/ltx-2.5-mlx)

elix3r 的 35.94 秒是刻意绕开正常 1024 padding 的单 token CPU forward；不能用来预计真实短 prompt 延迟。模型卡给出 Gemma4 allowlist 及 companion DiT 原始 BF16 参数处理 patch；不得把架构伪装成 Gemma3。其测试版本为 ComfyUI `2f35f4a08176d993cded35dac3332be4f7287f41`、ComfyUI-GGUF `6ea2651e7df66d7585f6ffee804b20e92fb38b8a`。[兼容说明](https://huggingface.co/elix3r/gemma4-12b-with-proj-ltx-2.5-GGUF/blob/main/README.md)

## 速度最佳实践：优先设备、内核与生命周期

一手作者 shino 使用相同 Q5 encoder 拆分 sd.cpp 编码和 ComfyUI 采样，在 AMD 780M 报告 CPU ComfyUI 20 分 45 秒 → sd.cpp CPU 151 秒 → sd.cpp GPU 37 秒。主要收益来自 GPU 独占编码阶段和引擎差异，不能称为 Q8→Q4 收益，更不能照搬为 M4 数字。该方案依赖未合并分支和两个补丁；输出必须传递 `unprocessed_ltxav_embeds` 让 ComfyUI 继续执行 DiT 内 connector，否则维数、有限值都正确也能生成棕色噪声。[作者复现记录](https://shino.dev/posts/ltx25-split-pipeline/)

AppleSilicon-FP8 的 INT4 ConvRot MPS 路径曾因无效 activation 量化比 INT8 慢约 2 倍；修复采用 W4A16，仍先解包权重到 BF16。作者将其定位为内存收益；重型低精度内核限制在 M5，不能把结果外推 M4。该证据针对 ConvRot/MPS 与扩展内核，不否认 MLX 压缩权重内核的价值。[实现说明](https://github.com/pawel-mazurkiewicz/ComfyUI-AppleSilicon-FP8/blob/main/README.md)

“mixed”也需要看具体含义：W4A8 是权重/activation 精度；Q4_K_M 是块量化混合规则；逐层 Q4/Q8 敏感度校准又是另一回事。tsolful 报告用 BF16 校准保留敏感层，但讨论针对 LTX DiT，并非经过验证的 Gemma4 mixed recipe，不应挪用成文本编码器结论。[作者说明](https://huggingface.co/tsolful/LTX_2.5_INT4_W4A8_ConvRot/discussions/2)

## 推荐的最小实验顺序

以下是研究建议，未在本轮执行：

1. **现有 INT8 CPU/MPS 对照**：只改实验工作流的 encoder device，记录冷加载、warm encode、卸载、峰值 RSS/MPS、swap；使用相同 1024 padding 与同一 prompt。此项回答当前 CPU 放置是否才是主要瓶颈，先核实为何现有配置选 CPU。
2. **MLX Q8/Q4 encoder 独立对照**：保留 RedGraft DiT 与采样，从同一 LTX BF16 encoder 生成量化。先复用已实现所有 hidden states 的 LTX MLX 路径，保护 embedding/norm/双投影；建立 Q8 控制组，再试 Q4 与按实测敏感层保留 Q8 的混合方案。避免从现有 INT8 再量化以叠加误差。
3. **Comfy 原生 W4A8 候选**：确认本机 comfy-kitchen 的 layout 与执行 device，再与同 device INT8 比较；用实际节点耗时证明，不能仅靠加载成功。
4. **GGUF 作为后续候选**：elix3r Q5 用于有据可依的兼容路径，Rootport Q4 需先验证 tensor names、tokenizer、metadata、全部层与双投影的加载契约。若目标是 sd.cpp/Metal 原生 Q4，先验证 LTX 2.5 分支和 conditioning 交接，不能直接照搬 AMD Vulkan 补丁。

验证先做无采样的编码器对照：有效 token 分层余弦/误差、mask、两路 projection、完整 conditioning。通过后再选择少量固定 seed 的真实 I2V，核对人物、动作、镜头、音画及 prompt 遵从。测试至少包括短/长 prompt、中文/英文、多主体和包含对话的描述。速度报告必须分开 encoder 与完整视频，总耗时包含权重加载、编码、卸载、采样与解码；GPU 测量同步，区分 cold/warm/cache hit。不能缩短 padding 后把质量变化混进 Q4 比较。

采用门槛应是同一 M4 Max 上可重复的总延迟收益，且实际业务画面质量可接受；内存下降但时间不降应明确记为内存优化。当前没有找到满足上述条件的 LTX Gemma4 Q4 / INT8 M4 隔离 A/B，因此不承诺倍数。
