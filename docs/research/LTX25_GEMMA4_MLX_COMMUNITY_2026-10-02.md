# LTX 2.5 Gemma 4 社区量化与 MLX 接入核验

日期：2026-10-02。范围：RedGraft 所需的 LTX 专用 Gemma 4 Unified 12B 文本编码器；一手来源、文件头和源码接口核验。本文没有运行 GPU、下载完整权重、安装依赖或切换服务；性能与真实视频验收由实施记录另行证明。

## 结论

**已有可用的社区 MLX Q8 与 Q4 权重。公开可直接取得的 Q4 候选是 `vanch007/LTX-2.5-mlx/gemma4-q4`，其 embedding、norm、LTX 双投影保留 BF16，并非默认全模型 Q4。** 它来自官方 LTX BF16 编码器，适合与现有 Comfy INT8 做受控比较；按源码可使用 Apple `mlx-lm` 的 Gemma 4 文本骨干，不必接入它整个视频 runtime。是否采用仍须以同 token/mask 的全部 hidden states、双投影和真实 I2V 验收决定。[发布者模型卡](https://huggingface.co/vanch007/LTX-2.5-mlx/blob/53e9fcb9f338119ac9854c8fe29b357cf1f74b26/README.md)、[转换配置](https://huggingface.co/vanch007/LTX-2.5-mlx/blob/53e9fcb9f338119ac9854c8fe29b357cf1f74b26/gemma4-q4/config.json)、[Apple Gemma 4 实现](https://github.com/ml-explore/mlx-lm/blob/5cfec4cb39deba54210b3ff4d86f2337c7bc10b5/mlx_lm/models/gemma4.py)

Q8 的现成包是 Vayden 发布的 WeeTodd paged pack。它属于另一个存储契约，不能改路径冒充 HF Q4；匿名读取其 manifest 返回 HTTP 401，应使用已经获得的访问权限。`mlx-community/ltx-2.5-mlx` 本身只发布 BF16 Gemma，模型卡明确没有发布量化 sibling；普通聊天 Gemma 社区包的训练来源、embedding 和 LTX projection 不满足此替换需求。[Vayden 模型卡](https://huggingface.co/Vayden/LTX-2.5-MLX-Q8-Paged/blob/445f3d7e46fd850884750c32b49eb5e629c3b686/README.md)、[mlx-community 模型卡](https://huggingface.co/mlx-community/ltx-2.5-mlx/blob/851cff741ecbd650b7d417af74c3e7b73f76dd64/README.md)

## 已核验的权重来源与格式

| 发布者 / 固定 HF revision | 编码器格式 | 实际边界 |
| --- | --- | --- |
| Vayden / `445f3d7e46fd850884750c32b49eb5e629c3b686` | `weetodd-ltx25-gemma-paged-q8-v1`；Q8 affine/group 64；fixed + 48 layer 页 | 专用 paged manifest，保留 fixed 浮点权重和嵌入资产；需要对应 loader 和已获访问权限 |
| vanch007 / `53e9fcb9f338119ac9854c8fe29b357cf1f74b26` | HF index，48 个 Q4 affine/group 64 layer shard + static + 独立 LTX projection | 只量化 decoder Linear；可匿名读文件头；没有完整 BF16 质量 A/B 或 M4 编码器独立计时 |
| mlx-community / `851cff741ecbd650b7d417af74c3e7b73f76dd64` | `gemma4-12b-ltx-v1/`，未量化 BF16，connector 另存 | 可作参考来源；其公开 Q8/Q4 指标是作者特定实验，不是本机 benchmark |

来源：[Q8 文件树](https://huggingface.co/Vayden/LTX-2.5-MLX-Q8-Paged/tree/445f3d7e46fd850884750c32b49eb5e629c3b686/gemma)、[Q4 文件树](https://huggingface.co/vanch007/LTX-2.5-mlx/tree/53e9fcb9f338119ac9854c8fe29b357cf1f74b26/gemma4-q4)、[BF16 文件树](https://huggingface.co/mlx-community/ltx-2.5-mlx/tree/851cff741ecbd650b7d417af74c3e7b73f76dd64/gemma4-12b-ltx-v1)、[WeeTodd paged 转换实现](https://github.com/wee-todd/WeeTodd-Studio/blob/4cf1b07a7e846ec3ded4d24a918c3053d2208b58/src/ltx25_mlx/paged_checkpoint.py)

### vanch007 Q4 文件与来源收据

`conversion-manifest.json` 指向官方 `Lightricks/LTX-2.5` revision `8a4ff96f581e72bedc1b44367581c49d544a05f1` 的 `gemma4-12b-with-proj-ltx-2.5-bf16.safetensors`，不是由 Comfy INT8 二次量化。清单记录 328 个量化 tensor、353 个保留 tensor、5 个提取资产，48 个 decoder layer，状态 complete。[固定转换清单](https://huggingface.co/vanch007/LTX-2.5-mlx/resolve/53e9fcb9f338119ac9854c8fe29b357cf1f74b26/gemma4-q4/conversion-manifest.json)、[发布者转换源码](https://github.com/vanch007/ltx-2.5-mlx/blob/183268443cca73d3856884d31f8a40201d8cdf21/ports/ltx-2.5-mlx/src/ltx25_mlx/gemma4_converter.py)

本轮根据固定 revision 的 HF tree API 汇总，`gemma4-q4/` 共 **58 个文件、10,595,536,414 bytes**（约 10.60 GB；9.87 GiB）；其中 50 个 safetensors 共 10,563,077,261 bytes。只需取 Gemma 子目录；没有必要为文本编码下载同仓的 transformer Q8。[固定目录 API](https://huggingface.co/api/models/vanch007/LTX-2.5-mlx/tree/53e9fcb9f338119ac9854c8fe29b357cf1f74b26/gemma4-q4?recursive=false&expand=false)

| 文件 | 大小 / 已核验内容 |
| --- | --- |
| `model-static.safetensors` | 2,118,034,808 bytes；embedding BF16 `[262144,3840]`，final norm BF16 `[3840]`，另有纯文本路径不使用的 multimodal 权重 |
| `model-layer-00000` … `00047.safetensors` | 每页约 126–136 MB；decoder Linear 的 U32 packed weight + BF16 `.scales` / `.biases`；norm 与 layer scalar BF16 |
| `ltx-text-projections.safetensors` | 2,312,122,922 bytes；video BF16 `[4096,188160]`、audio BF16 `[2048,188160]`，两路 bias 也为 BF16 |
| `model.safetensors.index.json` | 只索引 backbone：1322 个 `language_model.*` key；**不含 LTX projection**；`metadata.total_size=8,250,954,339` 不能当完整包大小 |
| tokenizer / config / processor / manifest | 附带原始 tokenizer、量化参数和逐 shard SHA-256；chat template 不能替代 LTX 原始 token 化约定 |

本轮对 static、layer 0、projection 分别发匿名 HTTP Range 请求，均返回 **206**；只读取 safetensors 头（1392 / 3526 / 546 bytes），没有读取完整 tensor。表内 dtype/shape 来自真实文件头，超出模型卡笼统的 Q4 标签。[static 文件](https://huggingface.co/vanch007/LTX-2.5-mlx/blob/53e9fcb9f338119ac9854c8fe29b357cf1f74b26/gemma4-q4/model-static.safetensors)、[layer 0 文件](https://huggingface.co/vanch007/LTX-2.5-mlx/blob/53e9fcb9f338119ac9854c8fe29b357cf1f74b26/gemma4-q4/model-layer-00000.safetensors)、[projection 文件](https://huggingface.co/vanch007/LTX-2.5-mlx/blob/53e9fcb9f338119ac9854c8fe29b357cf1f74b26/gemma4-q4/ltx-text-projections.safetensors)

可用于下载完整性核对的固定 SHA-256：static `eccc440e9d519995e86d63ef8439da904eebbe366c76d8cbc8ba26870035937a`；projection `d1495b0fb961504627827d1c200ee0c8b7e1f95774806bd5a17b9238945e8196`；layer 0 `60d306e9d364b71cd8f46cc69b85ae2ab6c27bd30fb80fe9330b6a18bc1fab75`。这些来自发布者 manifest / HF LFS 元数据；本轮没有下载 payload 后自行计算其全文件 hash。[转换清单](https://huggingface.co/vanch007/LTX-2.5-mlx/resolve/53e9fcb9f338119ac9854c8fe29b357cf1f74b26/gemma4-q4/conversion-manifest.json)

Q8 Gemma 目录 API 共列 99 个文件（含逐页 NOTICE），16,045,254,096 bytes，weights 为 16,045,226,268 bytes；fixed 页 4,462,351,857 bytes。loader 使用源 Comfy key 与嵌入 tokenizer，而非上述 HF index/key 布局；转换实现明确只对 layer 页做 Q8、fixed 不量化。[Q8 固定目录 API](https://huggingface.co/api/models/Vayden/LTX-2.5-MLX-Q8-Paged/tree/445f3d7e46fd850884750c32b49eb5e629c3b686/gemma?recursive=true&expand=false)、[格式与转换代码](https://github.com/wee-todd/WeeTodd-Studio/blob/4cf1b07a7e846ec3ded4d24a918c3053d2208b58/src/ltx25_mlx/paged_checkpoint.py)

## 与现有 RedGraft Comfy 路径的接口

现有链路需要 **49 份 `[B,T,3840]` hidden state**：scaled token embedding + 48 层输出。最后一份必须是 final norm 后的状态，前 48 份保留各自原始值。随后按每个 token、每层的 hidden dim 做 RMS normalization，按 hidden dim / layer 的顺序展平到 188160，分别 rescale 到 video/audio dim 后运行训练过的双投影。只给最后一层或普通 logits 不满足此契约。[LTX 官方编码入口](https://github.com/Lightricks/LTX-2/blob/2d6e71c88be37b55a2dd698c2dff447edfbe5898/packages/ltx-core/src/ltx_core/text_encoders/gemma/encoders/base_encoder.py)、[官方 V2 feature extractor](https://github.com/Lightricks/LTX-2/blob/2d6e71c88be37b55a2dd698c2dff447edfbe5898/packages/ltx-core/src/ltx_core/text_encoders/gemma/feature_extractor.py)、[vanch hidden states 修正](https://github.com/vanch007/ltx-2.5-mlx/blob/183268443cca73d3856884d31f8a40201d8cdf21/ports/ltx-2.5-mlx/src/ltx25_mlx/prompt_encoder.py#L257)

本机 Comfy checkout `c645560264062e6a5b0688d25eaf3ee9906a7709` 是公开 `169fcf35a2fc163fec31338b816503ddac0d3fcf` 上的本地 MPS attention 提交；本轮核对 `lt.py` / `gemma4.py` 相对公开提交零 diff。这两份实现中，LTX tokenizer 最短 **1024 left padding**；双投影仅保留有效 token，返回 float32 `[B,有效T,6144]` 与 `unprocessed_ltxav_embeds=True`；DiT 随后才执行 connector。若继续使用 Comfy DiT，应保留这个边界，不把 MLX 的最终 connector 输出重复送入 Comfy connector。[公开 Comfy LTX TE](https://github.com/Comfy-Org/ComfyUI/blob/169fcf35a2fc163fec31338b816503ddac0d3fcf/comfy/text_encoders/lt.py)、[公开 Comfy Gemma 4](https://github.com/Comfy-Org/ComfyUI/blob/169fcf35a2fc163fec31338b816503ddac0d3fcf/comfy/text_encoders/gemma4.py)、[本机 LTX TE](/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI/comfy/text_encoders/lt.py)

**WeeTodd 当前 helper 有两个不能直接沿用的细节**：`collect_gemma4_hidden_states` 返回 raw final decoder state，未执行 final norm；`tokenize_gemma4(..., max_length=1024)` 实际 `padding=False`，1024 是截断上限。其 `official_1024` 名称也不证明实际 padding。最小桥可沿用 Comfy token ids/mask，采集逐层状态后只替换 `states[-1] = inner.norm(states[-1])`，再完成原有双投影。该修正已在 vanch 与 dgrauet 包装层明示。[WeeTodd collector / tokenizer](https://github.com/wee-todd/WeeTodd-Studio/blob/4cf1b07a7e846ec3ded4d24a918c3053d2208b58/src/ltx25_mlx/gemma_encoder.py)、[dgrauet 最后状态契约](https://github.com/dgrauet/ltx-2-mlx/blob/91e6f6c9bd621ff2ae31adfee643e113d67d6ae8/packages/ltx-core-mlx/src/ltx_core_mlx/text_encoders/gemma/encoders/gemma4_encoder.py)

### 只接入 MLX 编码器的最小实现判断

Apple `mlx-lm` Gemma 4 已有 Unified 所需的 global head dim 512、global K=V、普通 RMSNorm、layer scalar 和零 KV shared layer 配置。WeeTodd 的 config translation 将 unified text config 转为 `gemma4` / `gemma4_text`，关闭不存在的 per-layer embedding 与 MoE；vanch Q4 的 `language_model.model.*` keys 与该模型路径一致。按每层真实 `.scales` key 将对应 Linear 替换为 `nn.QuantizedLinear` 后严格加载，可以保留 BF16 embedding / norm；不能对整个模型默认量化后期待静态 BF16 key 自动匹配。[Apple text model](https://github.com/ml-explore/mlx-lm/blob/5cfec4cb39deba54210b3ff4d86f2337c7bc10b5/mlx_lm/models/gemma4_text.py)、[WeeTodd config translation](https://github.com/wee-todd/WeeTodd-Studio/blob/4cf1b07a7e846ec3ded4d24a918c3053d2208b58/src/ltx25_mlx/gemma_pack.py)

这是**源码层面的兼容判断**，本轮没有证明实际 strict load、数值误差、卸载或速度。建议实施验证保留源 config 的全部注意力/RoPE参数，并明确过滤 static 中纯文本路径不消费的 multimodal key；未知 key / shape 必须失败。projection 单独加载，Gemma 不调用 lm_head，也不调用 chat template。MLX 的 packed Q4/Q8 使用真实压缩矩阵 kernel，和 Comfy ConvRot INT8/W4A8 格式不同，不能把旧 weight cast 后直接使用。[MLX quantized matmul API](https://ml-explore.github.io/mlx/build/html/python/_autosummary/mlx.core.quantized_matmul.html)、[Apple Gemma 权重过滤](https://github.com/ml-explore/mlx-lm/blob/5cfec4cb39deba54210b3ff4d86f2337c7bc10b5/mlx_lm/models/gemma4.py#L54)

## 固定 runtime 与本地版本

| 项目 | 本次在线核验的最新 revision | 本地已有实验源码 |
| --- | --- | --- |
| WeeTodd-Studio main | `4cf1b07a7e846ec3ded4d24a918c3053d2208b58`，2026-10-01 | `85ccf847e9fdc8c061895c8ce91e8f1209cfd2ba`；Gemma encoder / pack / paged checkpoint / pyproject / LICENSE 与最新版本逐字节相同 |
| dgrauet/ltx-2-mlx main | `1724ca673d59f023a8a95efee06e5d36d61c2765`，v0.15.12，2026-09-27 | `91e6f6c9bd621ff2ae31adfee643e113d67d6ae8`，core/pipelines v0.15.2；不能挪用最新版行为 |
| vanch007 companion | `183268443cca73d3856884d31f8a40201d8cdf21`，2026-08-14 | 本轮只读在线源码，未安装 |
| xocialize/ltx-2-mlx 的 ltx-2.5 branch | `c952c8f601e4fc5371d91b609ef5e0d85ba23751`，2026-08-16 | mlx-community BF16 pack 对应 consumer；和 dgrauet main 不是同一 pack 方言 |
| Apple mlx-lm main | `5cfec4cb39deba54210b3ff4d86f2337c7bc10b5`，2026-10-02 | 本文仅核验该源码，不声称本机已经安装该版本 |

来源：[WeeTodd 提交](https://github.com/wee-todd/WeeTodd-Studio/commit/4cf1b07a7e846ec3ded4d24a918c3053d2208b58)、[dgrauet release](https://github.com/dgrauet/ltx-2-mlx/commit/1724ca673d59f023a8a95efee06e5d36d61c2765)、[vanch 提交](https://github.com/vanch007/ltx-2.5-mlx/commit/183268443cca73d3856884d31f8a40201d8cdf21)、[xocialize 提交](https://github.com/xocialize/ltx-2-mlx/commit/c952c8f601e4fc5371d91b609ef5e0d85ba23751)、[Apple 提交](https://github.com/ml-explore/mlx-lm/commit/5cfec4cb39deba54210b3ff4d86f2337c7bc10b5)、[已有实验说明](LTX25_MAC_ACCELERATION_EXPERIMENTS_2026-09-30.md)

## 质量、速度与许可证的证据边界

mlx-community 作者在其 Swift/128 GB 实验给出 valid-token cosine：BF16 floor 0.999879、Q8 0.999820、Q4 0.996728；其选择保留 Q8。这个结论说明需要 conditioning 验收，**不能自动判定 vanch Q4 通过或失败**。vanch 的公开 619.57 秒数字是 M3 Max 128 GB、480×704×97、8 步完整生成，不是 Gemma 编码耗时，也没有与本机 RedGraft 同规格比较。本轮没有发现足以宣称“社区大多数都用某一量化”或“M4 Q4 必定比 Q8 更快”的统计 / A/B。[Q8/Q4 实验范围](https://huggingface.co/mlx-community/ltx-2.5-mlx/blob/851cff741ecbd650b7d417af74c3e7b73f76dd64/README.md)、[vanch benchmark 范围](https://huggingface.co/vanch007/LTX-2.5-mlx/blob/53e9fcb9f338119ac9854c8fe29b357cf1f74b26/README.md)

Google 原始 Gemma 4 采用 Apache-2.0；上述 LTX 定制编码器包含 Lightricks projection，社区包明确沿用 LTX-2.x Community License，不能仅凭 Gemma 或推理框架的许可推定整个模型包变为 Apache/MIT。WeeTodd 代码为 Apache-2.0，dgrauet port 为 MIT；vanch 根目录未见完整 runtime 的 LICENSE，因此最小接入可依赖有明确许可的 Apple 模型实现，而不是复制其整个工程。[Google 官方 Gemma 4 模型卡](https://ai.google.dev/gemma/docs/core/model_card_4)、[LTX 模型许可](https://github.com/Lightricks/LTX-2/blob/2d6e71c88be37b55a2dd698c2dff447edfbe5898/LICENSE-2_x)、[Q8 源与许可](https://huggingface.co/Vayden/LTX-2.5-MLX-Q8-Paged/blob/445f3d7e46fd850884750c32b49eb5e629c3b686/README.md)、[WeeTodd 代码许可](https://github.com/wee-todd/WeeTodd-Studio/blob/4cf1b07a7e846ec3ded4d24a918c3053d2208b58/LICENSE)、[dgrauet 代码许可](https://github.com/dgrauet/ltx-2-mlx/blob/1724ca673d59f023a8a95efee06e5d36d61c2765/LICENSE)

## 本机接入与下载限制补充（2026-10-02）

### 本地 Q8 的准确来源

本机既有 `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors` **来自 Lightricks 官方发布，并非第三方社区 MLX Q8 成品**。本轮使用 HF `model_info(..., files_metadata=True)` 核对官方 revision `5e6e71018ee1756ed329b697a7b4aedc934dfce9`：INT8 文件为 **15,372,969,374 bytes**，LFS SHA-256 为 `6ce688a0aa98a5fa36a9f1e6c3f42152a498cc2b53ee8c15674c64244f91487f`；本地全文件自行计算的 SHA 完全一致。[固定官方 INT8 文件](https://huggingface.co/Lightricks/LTX-2.5/blob/5e6e71018ee1756ed329b697a7b4aedc934dfce9/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors)

本次落地候选是将这个官方 INT8 的有效权重在 CPU 上逆 ConvRot、转为 BF16，再编码为 MLX affine Q8 / group 64；它增加一次量化舍入，不等于恢复官方训练 BF16，也不应称为“已安装 Vayden 社区 Q8”。是否采用由同 token/mask 的 conditioning 与真实视频对照决定。Vayden gated Q8 未取得；本机 HF `get_token()` 为空。

### Q4 下载吞吐与有效缓存

同一公开 Q4 revision 的官方 CDN `us.aws.cdn.hf.co` 使用共享 HTTPX client，**48 并发 × 512 KiB** 实际返回 **24 MiB / 49.071 秒 = 0.489 MiB/s**。48 个请求均检查 HTTP 206、精确 `Content-Range` 与 body 长度；该结果说明高并发在当前网络上仍未解决总吞吐，不能依据理论带宽承诺完整模型很快下载完成。

原下载进程已停止，保留原 HF 断点。已有 **13 / 58 个完整文件、672,963,845 bytes** 逐一与固定 revision 的 LFS SHA-256 或 Git blob SHA-1 一致，其中包含 5 个 decoder layer 和 8 个配置/资产文件。`tokenizer.json`、`generation_config.json`、`processor_config.json` 可从本地官方文件的嵌入资产原样提取，并分别匹配社区文件 hash；其余小文件从该公开 revision 取得。还缺 45 个 safetensors，**社区 Q4 未完成下载和本机实测，未进入默认流程**。有效缓存与检查报告保留于 `.scratch/ltx25-gemma4-mlx-20261002/`，没有改动源模型或 canonical encoder / prepare。

最后用官方 native Xet 重试单个 `model-layer-00002.safetensors`（126,110,142 bytes），启用 `HF_XET_HIGH_PERFORMANCE=1`、`HF_XET_NUM_CONCURRENT_RANGE_GETS=64`。取得了 pinned revision 的有效 Xet metadata，但 **420.1 秒**有界探测内没有报告完成字节；每 20 秒检查的 destination partial 和 Xet cache 新增字节也均为 0。达到上限后停止 worker，并验证父/子下载进程均已退出；没有将未完成文件视为通过 SHA 验收。脱敏 JSON 日志与总结保存为 `xet-probe.log`、`xet-probe-report.json`。本轮不再继续无限续传，默认落地使用通过本地验证的官方 INT8 → MLX Q8。

### BF16 静态权重重建结果

为避免额外下载 4.43 GB，本轮取得两份社区文件的原始 safetensors header，以远端 dtype / shape / offset 为契约，将本地官方 INT8 中未量化的 BF16 tensor bytes 按对应 key 原样写入。这两份重建文件 **均未匹配社区 LFS SHA**，没有移入有效 community 缓存；失败的大文件已经删除，保留 header、hash 和样本指标。

| 文件 | 社区期望 SHA-256 | 本地重建实际 SHA-256 |
| --- | --- | --- |
| `model-static.safetensors` | `eccc440e9d519995e86d63ef8439da904eebbe366c76d8cbc8ba26870035937a` | `a050f7138d31c3c9bedea84915c696e104ab070f89688ffd0149bb08682d002d` |
| `ltx-text-projections.safetensors` | `d1495b0fb961504627827d1c200ee0c8b7e1f95774806bd5a17b9238945e8196` | `7fae70afef31f73d8b8eced80f1adf468a6f87ae2b4bb986f7465ba483bb1371` |

进一步比较已下载 projection 前缀：原始 header 逐位一致，但紧随 header 的 64 KiB payload 中，32,768 个 BF16 数值只有 2,001 个逐位一致；该片段的 cosine 为 **0.9968227744**，最大绝对差 **0.0017852783**。因此不能仅凭两者都标 BF16 推定实际 tensor 相同，也不能将此样本 cosine 当成完整 conditioning 保真指标。社区 Q4 清单指向较早官方 revision `8a4ff96f...`；本轮没有将差异归因于某一个训练或转换步骤。[固定社区转换清单](https://huggingface.co/vanch007/LTX-2.5-mlx/resolve/53e9fcb9f338119ac9854c8fe29b357cf1f74b26/gemma4-q4/conversion-manifest.json)

本机复现证据：`reconstructed-static-report.json`、`network-and-payload-probe-report.json`、`cache-verification-report.json`，均位于上述 `.scratch` 目录。任务专用脚本只处理下载/CPU 原始字节，没有调用 GPU。

本轮完成：固定 primary source revision、匿名 Q4 头验证、目录大小与公开 hash 复核、Q8 gated 状态、逐层状态 / padding / projection / connector 接口核验、本地与上游源码对照。没有完整模型下载、GPU benchmark、视频质量验收或默认路由切换；这些状态不得由本文推定。
