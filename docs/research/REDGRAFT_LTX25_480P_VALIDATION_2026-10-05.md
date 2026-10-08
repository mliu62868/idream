# RedGraft LTX 2.5 448×768 默认档实测

2026-10-05（美国东部时间）在 Apple M4 Max / 128 GiB 上，常驻 ComfyUI
实际执行耗时 **210.574 秒（3 分 31 秒）**，输出 448×768、121 帧、24 fps、
5.041667 秒的 H.264/AAC MP4。这是一个热进程样本，不能视为冷启动耗时或 SLA。

## 默认配置与兼容边界

- 默认模型：`redgraft-ltx25-fast2k-int8-convrot`。
- 工作流：`redgraft-ltx25-i2v` v5；基础 recipe v8；options profile v9。
- 默认：`orientation=7:12`、`quality=preview`、`seconds=5`，448×768。
- 448×768 的准确比例为 7:12；“480p”是此处的档位称呼，实际短边为 448。
- 最终尺寸按两阶段 LTX 工作流要求以 64 对齐。
- 新 7:12 standard 为 896×1536，仅完成参数合同验证，未做真实生成。
- 旧显式比例仍保留：2:3 preview 512×768 / standard 768×1152，
  1:1 preview 512×512 / standard 768×768。
- 仅更新当前默认及新增比例；历史 profile、Job 和 Attempt 的执行参数不改写。

## 请求与计时

| 项目 | 证据 |
| --- | --- |
| 请求标识 | `redgraft-480p-1fb8cc0d-5b37-4ae2-9887-c95d9fc2b416` |
| ComfyUI prompt ID | `a999220a-dbc6-47ab-a648-8998ef2e2454` |
| 调用开始 UTC | `2026-10-06T03:19:18.125Z` |
| 完成 UTC | `2026-10-06T03:27:30.652Z` |
| 资源等待 | 281.179 秒 |
| ComfyUI 实际执行 | 210.574 秒 |
| 调用总耗时 | 492.527 秒 |
| seed | `2026082801` |
| cached nodes | 10 |

资源等待发生在我们的请求提交到 ComfyUI 之前：8188 当时已有另一个任务。
实际执行从本请求的 `execution_start` 到 `execution_success` 计算，
不把那个任务的执行时间归到本样本。资源等待、轮询、下载与媒体校验分别保留
在 Gen invocation performance 中。

使用真实 `providers.video.generate` 和共享 GPU lease，未使用 mock。
请求显式传入 448×768 和 7:12，刻意省略 `videoQuality`，验证 Gen 接受新的
preview 默认值。主站的省略比例/质量报价、提交及参数持久化另由数据库集成测试验证。

输入图为 `/Users/kk/ComfyUI-Shared/input/ltx23-gtanimation-alexa-reeves.webp`，
提示词：

> A 26-year-old woman on a yacht smiles and gives a small friendly wave. Natural daylight, fixed camera.

## 运行环境与不可变证据

- Apple M4 Max，128 GiB unified memory，MPS。
- ComfyUI 0.34.2，Python 3.13.12，PyTorch 2.11.0。
- 保留 8+3 Euler schedule、CFG 1、MPSGraph BF16 attention、MLX Q8 Gemma
  和 Conv VAE acceleration；仅改变默认输出规格及参数合同版本。
- 五个模型资产均在运行前核对 SHA-256，并 attestation 运行时模型根目录。
- Graph SHA-256：`580d16c686623cfb83bd72ad05594deed1caf48824523b8eff87831db4d05217`。
- 所测 source revision：
  `idream-worktree-49860d58f49fc47115d0eb37a94e93550ff934ff977a3dc8afdd5a3ab5657aa5`。
- 输出 SHA-256：`5aadc49e0f527397af03ada4822b181010c9ba3114402595abb92b7226806dc4`。

源 revision 绑定调用开始时的工作树，包含其他任务尚未提交的修改。
测试 fixture、公共目录漏项和 mock 默认值在运行期间继续修正；本实测不声称
覆盖最终工作树的全部文件。运行前采集的执行文件 SHA-256 和模型资产哈希保存
于本地 `report.json`，且随新 profile 的 `dryRunSummary` 归档。

## 媒体验证与限制

- ffprobe：448×768，121 帧，24 fps，5.041667 秒；H.264 视频与 AAC 音轨。
- ffmpeg 完整解码无错误。
- 抽取 0–4 秒共五帧人工检查：人物可辨认，微笑和挥手动作出现，无抽样黑屏、
  绿屏或冻结；手指形状存在轻微变化，未做完整时序质量评分。
- 音轨 mean -90.3 dB / peak -78.3 dB，近乎静音。此请求未要求讲话，
  仅证明容器包含可解码音轨，不能作为可听音频质量合格证据。
- 本次走原生 Gen backend，未经过 Main 用户交付、BFF、额度扣减和完整产品 E2E。
  API 费用为 0、Dreamcoin 扣减为 0；本机电费未计量。
- 旧 768×1152 数字来自不同热状态和规格，不能据此认定本次优化的严格倍速。

## 本地发布与验证

确认目标为开发库 `localhost:5433/idream_runtime_20260812` 后，通过根 README
的 PM2 wrapper 暂停并 drain Generation、停止 admission 和 worker，再执行
`db/sql/2026-10-05-redgraft-480p.sql`。

旧 active v7 被归档，新 active 为 `profile_video_redgraft_ltx25_v1-480p-v9`。
价格保留，历史 profile 除归档字段外保持不变，历史 Job / Attempt 参数校验和
发布前后相同。新 profile 附加本次原生验证证据，不继承旧规格的资格结果。

只同步 8188 的 RedGraft v5 工作流。`bun run pm2:start` 完成 readiness 和
worker ownership 检查，四条 Generation 队列均恢复放行。恢复后的实际 Admin
接口返回 active v9、workflow v5 和 448×768 默认尺寸。

已通过相关 shared / Gen / Main 类型检查、工作流与 envelope 单元测试、
视频控件和 Admin mounted 测试、不可变 SQL cutover 及旧 cutover 回归测试。
专用测试库上的新增默认报价/提交测试，以及视频提交、失败退款、素材持久化、
显式 H3 路由与 Admin 创建集成测试均通过。过滤运行之外的用例不计为本次验证。

本地原始证据在 `.scratch/redgraft-480p-20261005/`：`report.json`、
`history.json`、`video.mp4`、`contactsheet.jpg`、`media-check.json`、
`ffprobe.json`、`publication.json`、发布前后 profile 快照及测试/服务日志。
`.scratch` 不入版本控制；新 profile 的资格摘要持久保存关键标识、计时和哈希。
