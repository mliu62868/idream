# Pocket TTS 与 oMLX 兼容性核验

> 核验日期：2026-07-23  
> 证据范围：只使用 oMLX 官方仓库/源码/API、oMLX 固定依赖的 `mlx-audio` 官方源码、Hugging Face 官方模型仓库/API，以及本机 oMLX 0.5.3 端到端运行结果。未使用博客、论坛或第三方教程。  
> oMLX 基线：官方最新稳定版 [`v0.5.3`](https://github.com/jundot/omlx/releases/tag/v0.5.3)；同时复核了 2026-07-23 的 `main` 快照 [`d508490`](https://github.com/jundot/omlx/commit/d50849071ccc1b798a80228f7e2009ee1c8c18d1)。两者在本文涉及的 Pocket TTS 路径上结论一致。

## 结论

| 问题 | 结论 | 置信边界 |
|---|---|---|
| oMLX 是否支持 Pocket TTS？ | **支持；本机已用 `mlx-community/pocket-tts-4bit` 完成预设声音和参考音频克隆。** | oMLX 0.5.3 端到端确认。 |
| 能否用 oMLX 下载 `kyutai/pocket-tts`？ | **下载器可以发起下载；该仓库当前是 gated，必须提供已有访问权的 HF token。** | 下载成功不等于能在 oMLX 中加载。 |
| `kyutai/pocket-tts` 下载后能否直接服务？ | **不能按当前仓库形态直接服务。** 它没有 oMLX/`mlx-audio` 加载路径必需的顶层 `config.json`，并且是原始 Pocket TTS 权重仓库，不是完整 MLX 模型目录。 | 由官方 HF 模型 API、oMLX 发现逻辑和固定版 `mlx-audio` 加载逻辑共同确认。 |
| Pocket TTS 是显式实现还是依赖“任意自定义架构”？ | **显式实现。** oMLX 固定依赖的 `mlx-audio` 中存在专用 `pocket_tts` 模型模块。oMLX/`mlx-audio` **没有**任意远程自定义 TTS 架构的通用加载承诺。 | 新架构必须进入 `mlx_audio.tts.models`，或由已存在模块/映射识别。 |
| 是否支持 Pocket TTS 预设声音？ | **支持。** `voice` 会传给 Pocket TTS；固定版实现列出 8 个预设声音。 | 本机 HTTP 200、有效 WAV。 |
| 是否支持 Pocket TTS 声音克隆？ | **支持请求级克隆。** oMLX API 接收参考音频，Pocket TTS 后端会编码参考音频作为说话人条件。 | 本机 HTTP 200、有效 WAV；API 要求同时提交 `ref_text`。 |
| 是否有持久化声音注册表？ | **没有。** 只有静态声音查询和请求内 `ref_audio`；没有创建/删除声音的 API。 | 克隆音频写临时文件并在请求结束后删除。 |

最重要的操作性结论是：

```text
不要把 kyutai/pocket-tts 直接作为 oMLX 运行目录。
使用 mlx-community/pocket-tts-4bit。
```

## 1. 当前官方 oMLX 能力边界

### 1.1 官方仓库、版本与 Audio API

官方仓库是 [`jundot/omlx`](https://github.com/jundot/omlx)。最新稳定版为 [`v0.5.3`](https://github.com/jundot/omlx/releases/tag/v0.5.3)。

`v0.5.3` 把 `mlx-audio` 固定在提交 `51753266e0a4f766fd5e6fbc46652224efc23981`，并提供 `audio` extra；这意味着兼容性应以这个确切依赖快照为准，而不是以任意最新 `mlx-audio` 为准。[来源：oMLX `pyproject.toml`](https://github.com/jundot/omlx/blob/v0.5.3/pyproject.toml#L132-L137)

当 `mlx-audio` 已安装时，oMLX 会注册 Audio 路由；没有安装时不会注册这些端点。[来源：oMLX `server.py`](https://github.com/jundot/omlx/blob/v0.5.3/omlx/server.py#L529-L540)

TTS 官方端点是：

```text
POST /v1/audio/speech
```

请求模型包含 `model`、`input`、`voice`、`ref_audio`、`ref_text`、采样参数、输出格式与流式参数。[来源：oMLX `audio_models.py`](https://github.com/jundot/omlx/blob/v0.5.3/omlx/api/audio_models.py#L32-L48) 路由只接受真正加载为 `TTSEngine` 的模型，并支持 WAV、MP3、Opus、FLAC、PCM；流式模式当前只允许 WAV。[来源：oMLX `audio_routes.py`](https://github.com/jundot/omlx/blob/v0.5.3/omlx/api/audio_routes.py#L649-L755)

### 1.2 “Model Registry”不是兼容模型目录

oMLX 源码中的 `omlx/model_registry.py` 只是运行时模型所有权注册器，用于避免多个引擎共享同一个模型时发生 KV cache 冲突；它不是 Pocket TTS 等模型家族的兼容性清单。[来源：oMLX `model_registry.py`](https://github.com/jundot/omlx/blob/v0.5.3/omlx/model_registry.py#L3-L14)

Audio 模型兼容性实际来自动态发现：

1. oMLX 读取已安装 `mlx-audio` 的 `MODEL_REMAPPING`；
2. 同时扫描 `mlx_audio/{stt,tts,sts}/models/` 下已有的架构模块目录；
3. 把命中的顶层 `config.json.model_type` 分类为 `audio_tts`。

[来源：oMLX `model_discovery.py`](https://github.com/jundot/omlx/blob/v0.5.3/omlx/model_discovery.py#L244-L313) [来源：模型类型判定](https://github.com/jundot/omlx/blob/v0.5.3/omlx/model_discovery.py#L695-L727)

因此，官方兼容性判断不是“仓库名字里有 `tts` 就能跑”，而是：

```text
可发现的 MLX 模型目录
  + 可识别的顶层 config.json
  + 固定版 mlx-audio 中存在对应架构模块
  + 权重形状/名称能被该模块加载
```

## 2. Pocket TTS 是显式支持，不是泛化推断

oMLX 的 `TTSEngine` 明确委托 `mlx_audio.tts.utils.load_model()` 加载模型。[来源：oMLX `tts.py`](https://github.com/jundot/omlx/blob/v0.5.3/omlx/engine/tts.py#L98-L146)

在 oMLX 固定的 `mlx-audio` 提交 `5175326` 中，确实存在完整的专用实现目录：

- [`mlx_audio/tts/models/pocket_tts/`](https://github.com/Blaizzy/mlx-audio/tree/51753266e0a4f766fd5e6fbc46652224efc23981/mlx_audio/tts/models/pocket_tts)
- `ModelConfig.model_type` 明确为 `pocket_tts`。[来源：Pocket TTS config](https://github.com/Blaizzy/mlx-audio/blob/51753266e0a4f766fd5e6fbc46652224efc23981/mlx_audio/tts/models/pocket_tts/config.py#L147-L167)
- 实现包含 Flow LM、Mimi、流式生成与声音条件路径。[来源：Pocket TTS model](https://github.com/Blaizzy/mlx-audio/blob/51753266e0a4f766fd5e6fbc46652224efc23981/mlx_audio/tts/models/pocket_tts/pocket_tts.py#L28-L53)

该实现的官方合入记录 [`mlx-audio` PR #381](https://github.com/Blaizzy/mlx-audio/pull/381) 明确把原始模型写为 `kyutai/pocket-tts`、转换模型写为 `mlx-community/pocket-tts`，并给出了后者成功生成音频的命令与输出。本次又在 oMLX 0.5.3 上对其 4-bit 版本完成了本机端到端复核。

这不是对“任意自定义架构”的泛化支持。`mlx-audio` 的加载器会把模型类型解析为本地 Python 模块 `mlx_audio.<category>.models.<model_type>`；模块不存在就明确报“不支持”。[来源：`get_model_class`](https://github.com/Blaizzy/mlx-audio/blob/51753266e0a4f766fd5e6fbc46652224efc23981/mlx_audio/utils.py#L254-L313) 加载过程还要求本地存在 `config.json`，再由配置选择内置模型类并加载本地 safetensors/NPZ 权重。[来源：`load_config`](https://github.com/Blaizzy/mlx-audio/blob/51753266e0a4f766fd5e6fbc46652224efc23981/mlx_audio/utils.py#L152-L190) [来源：`base_load_model`](https://github.com/Blaizzy/mlx-audio/blob/51753266e0a4f766fd5e6fbc46652224efc23981/mlx_audio/utils.py#L316-L402)

所以准确表述是：

- **已确认：** Pocket TTS 已有专用 MLX 实现；
- **不成立：** oMLX 可以仅凭 Hugging Face `trust_remote_code` 运行任意自定义 TTS 架构；
- **新增架构的实际要求：** 把架构实现加入 `mlx-audio` 的本地模型模块/映射，并提供符合其加载约定的 MLX 仓库。

## 3. `kyutai/pocket-tts`：可以下载，但不能直接服务

### 3.1 下载能力

oMLX Admin 下载器接受任意合法的 `owner/model` 仓库 ID，并接受可选 `hf_token`；没有硬编码只允许某些模型家族。[来源：oMLX `HFDownloader.start_download`](https://github.com/jundot/omlx/blob/v0.5.3/omlx/admin/hf_downloader.py#L620-L662)

下载器会：

- 下载到 `<model-dir>/<owner>/<model>`；
- 调用 Hugging Face `snapshot_download`；
- 对 gated 仓库把 token 传给 HF API；
- 没有访问权时明确返回 gated 错误。

[来源：oMLX 下载实现](https://github.com/jundot/omlx/blob/v0.5.3/omlx/admin/hf_downloader.py#L800-L960)

Hugging Face 官方模型 API 当前把 `kyutai/pocket-tts` 标记为 `gated: "auto"`。[来源：HF 模型 API](https://huggingface.co/api/models/kyutai/pocket-tts) 因此：

- 已接受访问条件并提供有效 token：**oMLX 可以下载**；
- 未获访问权或未提供 token：**下载会失败**。

### 3.2 为什么下载后仍不能直接在 oMLX 中运行

HF 官方 API 当前列出的 `kyutai/pocket-tts` 顶层文件包括 `README.md`、`tokenizer.model`、`tts_b6369a24.safetensors` 等，但没有 `config.json`。[来源：HF 模型 API 文件列表](https://huggingface.co/api/models/kyutai/pocket-tts)

而 oMLX 的 `serve` 命令明确要求每个模型子目录包含有效 `config.json` 和 safetensors 文件。[来源：oMLX CLI](https://github.com/jundot/omlx/blob/v0.5.3/omlx/cli.py#L788-L815) 固定版 `mlx-audio` 的加载器也会在缺少 `config.json` 时直接抛出 `FileNotFoundError`。[来源：`load_config`](https://github.com/Blaizzy/mlx-audio/blob/51753266e0a4f766fd5e6fbc46652224efc23981/mlx_audio/utils.py#L152-L173)

因此，`kyutai/pocket-tts` 的结论必须拆开：

```text
HF snapshot 下载：有条件支持
oMLX 自动发现：不支持当前原始仓库形态
oMLX TTS 加载：不支持当前原始仓库形态
```

## 4. 已实测仓库：`mlx-community/pocket-tts-4bit`

`mlx-community/pocket-tts-4bit` 是 `mlx-audio` Pocket TTS 实现对应的 4-bit MLX 仓库。它当前：

- 非 gated；
- 包含 `config.json`；
- 包含 `model.safetensors`；
- `config.json.model_type` 为 `pocket_tts`；
- 配置为 4-bit affine quantization、group size 64；
- HF 元数据声明 `library_name: mlx-audio`，并含 `mlx`、`voice cloning` 标签；
- 声明基座为 `kyutai/pocket-tts`。

[来源：HF 模型 API](https://huggingface.co/api/models/mlx-community/pocket-tts-4bit) [来源：4-bit config](https://huggingface.co/mlx-community/pocket-tts-4bit/blob/59592598c532759d2b66a3d8905a612dcbe8419c/config.json) [来源：4-bit 模型卡](https://huggingface.co/mlx-community/pocket-tts-4bit/blob/59592598c532759d2b66a3d8905a612dcbe8419c/README.md)

该配置与 oMLX 的动态 Audio 发现规则、固定版 `mlx-audio` 的 `pocket_tts` 模块完全对齐，所以这是当前可确认的 oMLX 运行入口。

### 4.1 本机端到端结果

本机 oMLX 0.5.3 的完整结果：

| 阶段 | 结果 |
|---|---|
| Admin 下载 | `completed`，下载 `89,316,161` bytes |
| 自动发现 | `model_id=pocket-tts-4bit` |
| 引擎分类 | `engine_type=audio_tts` |
| 配置识别 | `config_model_type=pocket_tts` |
| 预设声音请求 | HTTP 200，WAV `192,044` bytes，音频 `4.00s`，请求耗时 `0.98s` |
| 参考音频克隆请求 | HTTP 200，WAV `195,884` bytes，音频 `4.08s`，请求耗时 `1.08s` |

这组结果证明了实际链路：

```text
Admin 下载
  -> 模型刷新与 audio_tts 自动发现
  -> Pocket TTS 4-bit 权重加载
  -> /v1/audio/speech
  -> 预设声音 WAV
  -> ref_audio 克隆 WAV
```

## 5. 预设声音与声音克隆

### 5.1 预设声音

固定版 Pocket TTS 实现内置 8 个声音名：

```text
alba, marius, javert, jean, fantine, cosette, eponine, azelma
```

这些预设引用 `kyutai/pocket-tts-without-voice-cloning` 中的声音 embedding。[来源：Pocket TTS voices](https://github.com/Blaizzy/mlx-audio/blob/51753266e0a4f766fd5e6fbc46652224efc23981/mlx_audio/tts/models/pocket_tts/utils.py#L8-L24)

oMLX 会检查后端 `generate()` 的签名，并把 API `voice` 参数传给具有 `voice` 参数的 TTS 后端。[来源：oMLX `TTSEngine`](https://github.com/jundot/omlx/blob/v0.5.3/omlx/engine/tts.py#L218-L248)

### 5.2 声音克隆

oMLX 的 `/v1/audio/speech` 接受 base64 编码的 `ref_audio`。一旦提交参考音频，API 同时要求 `ref_text`；base64 字符串上限为 20 MiB，源码注释估计约等于 60 秒音频。[来源：oMLX 参考音频校验](https://github.com/jundot/omlx/blob/v0.5.3/omlx/api/audio_routes.py#L37-L38) [来源：解码与 `ref_text` 要求](https://github.com/jundot/omlx/blob/v0.5.3/omlx/api/audio_routes.py#L142-L168)

oMLX 只在后端 `generate()` 明确包含 `ref_audio` 时转发参考音频。[来源：oMLX `TTSEngine`](https://github.com/jundot/omlx/blob/v0.5.3/omlx/engine/tts.py#L225-L248)

Pocket TTS 的 MLX 后端确实具有 `ref_audio` 参数；它读取参考音频、用 Mimi 编码，再投影为说话人条件并写入生成状态。[来源：Pocket TTS `generate`](https://github.com/Blaizzy/mlx-audio/blob/51753266e0a4f766fd5e6fbc46652224efc23981/mlx_audio/tts/models/pocket_tts/pocket_tts.py#L234-L250) [来源：参考音频条件编码](https://github.com/Blaizzy/mlx-audio/blob/51753266e0a4f766fd5e6fbc46652224efc23981/mlx_audio/tts/models/pocket_tts/pocket_tts.py#L138-L158)

因此声音克隆是**完整、连通的源码路径**：

```text
HTTP ref_audio(base64)
  -> oMLX 临时 WAV
  -> TTSEngine ref_audio
  -> Pocket TTS Mimi encode
  -> speaker conditioning
  -> speech generation
```

限制：

- 不能用 `kyutai/pocket-tts-without-voice-cloning` 的去克隆权重期待声音克隆；
- 应使用 `mlx-community/pocket-tts-4bit` 这类包含声音克隆能力的 MLX 转换；
- 本机已经验证参考音频请求能够返回有效 WAV；生产质量仍应使用目标声音样本做听辨和相似度门槛评估。

### 5.3 没有持久化 voice registry

oMLX 当前只有只读的：

```text
GET /v1/audio/voices?model=<model-id>
```

它只读取模型目录中的静态 `voices/` 文件或 `config.json` 里的 speaker table，不创建任何声音资产。[来源：oMLX voices route](https://github.com/jundot/omlx/blob/v0.5.3/omlx/api/audio_routes.py#L585-L625)

官方 Audio 路由没有 `POST /v1/voices`、`DELETE /v1/voices/{id}`，也没有对应的 `/v1/audio/voices` 写入/删除端点。声音克隆仅存在于单次 `/v1/audio/speech` 请求中：

1. 客户端每次提交 base64 `ref_audio` 和 `ref_text`；
2. oMLX 把音频写入临时 WAV；
3. 推理完成后在 `finally` 中删除临时文件。

[来源：临时文件写入](https://github.com/jundot/omlx/blob/v0.5.3/omlx/api/audio_routes.py#L171-L180) [来源：请求结束清理](https://github.com/jundot/omlx/blob/v0.5.3/omlx/api/audio_routes.py#L697-L742)

因此，oMLX 已确认的是**请求级 voice cloning**，不是**持久化声音管理**。如果产品需要 `voice_id`、复用、重命名、删除、审计或版本化，必须由上层应用保存参考音频和元数据，并在每次合成时重新传入；或者在 oMLX 之外增加专门的 voice registry 服务。

## 6. 可执行命令

### 6.1 安装 Audio 依赖

从源码安装时：

```bash
cd /path/to/omlx
python -m pip install -e ".[audio]"
```

这是 `TTSEngine` 自身给出的依赖恢复方式，且 `audio` extra 固定了兼容的 `mlx-audio` 提交。[来源：oMLX `TTSEngine`](https://github.com/jundot/omlx/blob/v0.5.3/omlx/engine/tts.py#L115-L121) [来源：oMLX `pyproject.toml`](https://github.com/jundot/omlx/blob/v0.5.3/pyproject.toml#L132-L137)

### 6.2 下载模型

oMLX 官方 CLI 当前没有 `omlx download` 子命令；CLI 注册的是生命周期命令、`serve`、`launch` 和 `diagnose`。[来源：oMLX CLI subcommands](https://github.com/jundot/omlx/blob/v0.5.3/omlx/cli.py#L763-L790) [来源：后续 subcommands](https://github.com/jundot/omlx/blob/v0.5.3/omlx/cli.py#L973-L1055)

官方 oMLX 下载方式是：

1. 启动 oMLX；
2. 打开 `http://127.0.0.1:8000/admin`；
3. 在 Downloads 中输入并下载：

```text
mlx-community/pocket-tts-4bit
```

oMLX README 明确把 Hugging Face 模型下载器放在 Admin Dashboard 中。[来源：oMLX README](https://github.com/jundot/omlx/blob/v0.5.3/README.md#L223-L225)

下载器搜索默认使用 `mlx_only=true`；`mlx-community/pocket-tts-4bit` 当前声明 `library_name=mlx-audio` 并带有 `mlx` 标签，符合 MLX 搜索语义。无论搜索排序如何，直接在下载输入框填写完整仓库 ID 都有效，因为直接下载接口只校验 `owner/model` 形式。[来源：oMLX 搜索过滤](https://github.com/jundot/omlx/blob/v0.5.3/omlx/admin/hf_downloader.py#L389-L446) [来源：直接下载校验](https://github.com/jundot/omlx/blob/v0.5.3/omlx/admin/hf_downloader.py#L620-L662) [来源：HF 模型 API](https://huggingface.co/api/models/mlx-community/pocket-tts-4bit)

如果需要纯命令行准备目录，可以使用 Hugging Face 官方 CLI；注意这不是 oMLX 子命令：

```bash
hf download mlx-community/pocket-tts-4bit \
  --local-dir "$HOME/.omlx/models/mlx-community/pocket-tts-4bit"
```

### 6.3 启动服务并确认模型

```bash
omlx serve --model-dir "$HOME/.omlx/models"
```

oMLX 支持 `<organization>/<model>` 两层目录，但对外 `model_id` 使用最内层目录名；本机发现结果为 `pocket-tts-4bit`。[来源：oMLX 模型目录说明](https://github.com/jundot/omlx/blob/v0.5.3/README.md#L285-L298) [来源：两层发现实现](https://github.com/jundot/omlx/blob/v0.5.3/omlx/model_discovery.py#L1257-L1345)

确认：

```bash
curl -sS http://127.0.0.1:8000/v1/models \
  | jq '.data[] | select(.id == "pocket-tts-4bit")'
```

如果配置了 oMLX API key，为 `/v1/*` 请求增加：

```bash
-H "Authorization: Bearer $OMLX_API_KEY"
```

### 6.4 使用预设声音生成

```bash
curl -sS http://127.0.0.1:8000/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "pocket-tts-4bit",
    "input": "The quick brown fox jumps over the lazy dog.",
    "voice": "alba",
    "response_format": "wav"
  }' \
  --output pocket-tts-4bit-alba.wav
```

这是由官方请求模型与路由直接推导出的调用格式，不是 README 中单独发布的 Pocket TTS 示例。[来源：请求模型](https://github.com/jundot/omlx/blob/v0.5.3/omlx/api/audio_models.py#L32-L48) [来源：TTS 路由](https://github.com/jundot/omlx/blob/v0.5.3/omlx/api/audio_routes.py#L649-L755)

### 6.5 使用参考音频克隆声音

macOS：

```bash
REF_AUDIO_B64="$(base64 < reference.wav | tr -d '\n')"

jq -n \
  --arg input "This sentence should use the reference speaker." \
  --arg ref_audio "$REF_AUDIO_B64" \
  --arg ref_text "Exact transcript of the speech in reference.wav." \
  '{
    model: "pocket-tts-4bit",
    input: $input,
    ref_audio: $ref_audio,
    ref_text: $ref_text,
    response_format: "wav"
  }' \
  | curl -sS http://127.0.0.1:8000/v1/audio/speech \
      -H 'Content-Type: application/json' \
      --data-binary @- \
      --output pocket-tts-4bit-cloned.wav
```

如果配置了 API key，同样增加 Bearer header。

## 7. 最终确认与剩余边界

- oMLX `v0.5.3` 有 TTS 引擎与 `/v1/audio/speech`；
- oMLX 固定的 `mlx-audio` 快照包含专用 Pocket TTS MLX 实现；
- `mlx-community/pocket-tts-4bit` 已由 Admin 完整下载，并被发现为 `audio_tts` / `pocket_tts`；
- 预设声音与参考音频克隆均已在本机通过 HTTP 200 返回有效 WAV；
- `kyutai/pocket-tts` 可由通用下载器在有访问权时下载，但当前仓库结构不能直接被 oMLX 服务；
- `voice` 预设声音与 `ref_audio` 声音克隆的源码链路完整；
- oMLX 不提供任意远程自定义 TTS 架构的通用兼容承诺；
- oMLX 没有持久化 voice registry，克隆仅作用于携带 `ref_audio` 的当前请求。

本次短请求实测已经回答“能否下载、发现、加载、预设发声、参考音频克隆”。生产候选仍需另行设定长文本稳定性、并发、目标声音相似度与持久化声音资产管理的验收门槛；这些是生产评估范围，不改变本文的兼容性结论。
