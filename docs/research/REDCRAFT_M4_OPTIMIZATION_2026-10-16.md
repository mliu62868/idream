# RedCraft / M4 Max 剩余瓶颈与优化实测（2026-10-16）

> 本文保留六步优化的历史对照。当前 RedCraft 已改用作者首轮八步配方，见[接入记录](REDCRAFT_QW21T_INTEGRATION_2026-10-16.md)；下面的六步耗时不能直接当作当前八步耗时。

已落地无损的跨请求前缀 KV 复用，接在已有 INT8 → BF16 驻留权重方案后。同一模型、提示词、参考图及目标尺寸再次出图，可以复用参考前缀；允许换种子。新提示词/参考图/尺寸需要重算，首次请求不享受这部分收益。模型、VAE、Euler 六步、CFG1 和分辨率均未改变。

## 实测结果

M4 Max / 128 GiB，macOS 27.0.1，图像环境 Torch 2.14.0 / ComfyUI 0.37.0，Comfy 源码 88ab4a06566454ad89db8f0bedb970d6c08cd1b7。832×1024、一个输出、TextureFix BF16 VAE、同一 ConvRot INT8 编码器在 MPS 上执行。两位不同的成年虚构人物、普通着装；固定提示词、种子和参考图。baseline 已经启用旧的 BF16 驻留加速，并非原始慢速 INT8。

每人物、每方案各两次的中位数；单位为秒：

| 场景 | 原方案全程 | 复用命中全程 | 用时减少 | 采样阶段前 → 后 |
|---|---:|---:|---:|---:|
| 人物 A · 咖啡杯 | 55.12 | 41.08 | 25.48% | 43.15 → 33.72 |
| 人物 B · 图书馆 | 51.05 | 44.65 | 12.54% | 43.06 → 36.78 |

“全程”是原生 Comfy execution_start → execution_success，覆盖加载、编码、采样、解码、保存，排除请求前资源排队；provider 原始 wall time 和 resourceWait 均保留在每次 JSON。另有几个串行 GPU 算子探针在请求之间持有同一项目 accelerator lease，因此不能把人为排队算成模型计算时间。所有请求都确认实际执行六步，未拿缓存整张成图代替推理。

这是小样本、分批测量，含运行顺序/加载波动，不能把 12.5–25.5% 当成所有场景的稳定承诺。更保守的同一复用分支对照：从 cache miss 到随后两次 hit，A 的采样中位数减少 11.94%，B 减少 17.26%。本轮没有证实新提示词首次生成可普遍提速。

全部七个复用样本（包括冷请求、命中、换种子、换人物）与相同输入的非复用控制图逐个解码核对，RGBA 像素完全一致。换种子样本也与该新种子的原方案控制图完全一致；缓存没有冻结采样噪声。画质与人物一致性保持原结果，没有提升模型的人物保持或指令执行能力。本轮没有测明确裸露/性行为，不能据此声称 NSFW 能力升级。

## 瓶颈与排除项

真实参考图请求中，首步 forward 约 11.28 秒，后续未加层级采样探针的 forward 约 5.35–5.51 秒。首步额外计算的是文本/参考前缀；其 timestep 固定为零且采用前缀因果注意力，与目标噪声和种子无关。上游原实现会在每个 sampling run 的 cleanup 清空它，因此连续重抽也重算。

采样之外，VAE 解码约 1.7–2 秒；编码器重载和条件编码有明显波动。单个真实缓存步首层中，注意力约 79ms、MLP 约 82ms，主要计算在投影/MLP 矩阵乘法与 SDPA。层级 hooks 含同步，不能把其总和当作无扰动的整机剖析。

已实际筛选：

- Q/K/V 合并：约 23.58 → 23.23ms；gate/up 合并约 70.52 → 70.53ms，收益太小。
- 仅设置 PYTORCH_MPS_PREFER_METAL 或 FAST_MATH，对真实 block 的变化不到 1%。[PyTorch 文档](https://docs.pytorch.org/docs/stable/mps_environment_variables.html) 说明前者用于 matmul；[该版本 Linear 实现](https://github.com/pytorch/pytorch/blob/v2.14.0/aten/src/ATen/native/mps/operations/Linear.mm) 显示 contiguous Linear 可以走独立 NDArray 路径。
- 显式 mm + Metal：实际 block 约 149 → 1137ms，明显退步，未接入。
- FP16 Linear：充分预热并交替测量后，BF16 baseline 201.70ms、FP16 204.96ms；无优势，未改精度。
- 自写 MPS AdaLN / RMS-RoPE 融合：真实 block 交替测量 201.70 → 194.35ms，约快 3.65%。仍有浮点差异，完整图像对照如下，未作为默认方案。

融合方案每场景各两次，单位秒；RGB 差异为 0–255 尺度 MAE：

| 场景 | 全程前 → 后 | 采样前 → 后 | RGB MAE |
|---|---:|---:|---:|
| a | 55.12 → 54.31 | 43.15 → 45.86 | 0.56 |
| b | 51.05 → 50.94 | 43.06 → 41.93 | 2.94 |
| t2i | 36.85 → 34.49 | 31.32 → 29.76 | 4.31 |

融合没有展现明确的画质或人物一致性提升，参考图采样收益混杂；其性能收益不足以支持替换当前默认。保留实验脚本用于复现，没有将这些 shader、FP16 或全局开关接入正式流程。

## 正式实现与验证

[prefix_cache.py](../../packages/gen/comfyui_nodes/idream_qwen21/prefix_cache.py) 由已有驻留节点启用。仅保留最近一份完整、无量化的前缀；以 Comfy 原有的完整张量 key 校验 conditioning、参考 latent、插入槽和目标几何，并额外检查模型 owner、权重 revision、模型选项、对象补丁及缓存设备/精度。换输入会替换旧条目。CFG 多槽仅保留原请求内生命周期，中断形成的不完整条目丢弃。

Comfy 的 detach(False) 还用于重新选择已加载 clone，不等于卸载；此时允许保留。真实 detach(True) 必须释放 KV 和权重。owner 使用弱引用。重建另一个 resident sibling 时，从 ModelPatcher 原始备份读取方法，避免捕获当前 sibling 的补丁并嵌套生命周期。RedCraft descriptor 字节仍为 bb2e52b756b03e3d80e4388e6bfcba0c72446b20576a1ddd71dfd8ed3ae34c59；未改 Main profile、数据库、模型文件或默认 REDQW21。

最终原生路径重新启动，已移除全部临时诊断节点，连续跑四次；缓存日志严格为 miss → hit → miss → miss：

| 输入 | 非复用控制秒 | 正式实现秒 | RGBA 像素 | native prompt ID |
|---|---:|---:|---|---|
| a | 52.25 | 46.74 | 完全一致 | a746de3c-efac-4eee-a2e2-e7da13a5657b |
| a-alt | 54.13 | 41.75 | 完全一致 | 4ccb8b14-a3a7-4e58-b906-87a5f907809b |
| b | 51.35 | 49.67 | 完全一致 | d7c886c6-4506-43f0-ba76-813bc97c002f |
| t2i | 35.95 | 37.16 | 完全一致 | bb90f010-0e56-48b4-b0f2-b63e5e60f318 |

正式执行 source revision：idream-worktree-080562f5f39f32d348c256e5041447809ec936aaeefddc2ef1e16a68e34d9f88。先前实验 revision：idream-worktree-01a7dc9712b4a9fc9f9c98398e240cfc81f5e3218f01aa8569e526a3a3618edb。之后仅更新说明/报告和测试导入格式；实际运行文件 SHA 在 canonical-verification.json 中另存，避免把后续文档 revision 当成执行证据。

- 原始 cleanup/clone detach 的回归控制真实失败：0.004 秒的 CPU 测试断言“相同输入应命中”失败，见 prefix-test-red.log。sibling 方法捕获回归也先红后绿，见 prefix-sibling-red.log。
- Qwen Python/MPS 测试 25 项通过，含真实 Qwen / ModelPatcher / PoseBranchCache、换噪声和 timestep 的精确数值对照、输入与权重/选项/owner 失效、CFG 多槽、不完整条目及方法恢复。
- MPS 实体回收：16 MiB KV 测试中 current_allocated_memory 从 18,352,128 降至 256 字节。整图样本的常驻条目约 2.03–2.09 GiB；实际内存不足触发模型真正卸载时会清掉。
- Gen 359 项 / 27 文件测试通过。仅改 Python runtime，无 Main schema/data 变更；未重跑 Main 计费链。
- 模型、编码器、VAE 最终重新读取 SHA256，全部匹配既有 pins。
- 本次 28 个成功原生生成请求（1 次性能采集、1 次融合预热、12 次融合矩阵、2 次初版复用控制、8 次修正复用矩阵、4 次正式验证）；另有 1 次诊断模块路径错误在采样前失败，留存记录。推理均在本机 Gen → Comfy 执行，交付/保存/native HTTP 字节核对；无 Main Job，Dreamcoins 0、外部推理费用 0。
- 服务已还原：comfyui-image stopped / PID0，8188/8189/8190 均无监听，临时节点 symlink 已移除。未安装依赖、升级 Torch 或修改系统电源/编译器设置。

## 可复核证据

- [融合矩阵与原始请求](../../.scratch/redcraft-optimize-20261016/matrix.json)、[融合图像差异/耗时](../../.scratch/redcraft-optimize-20261016/comparison.json)、[真实层预热交替测量](../../.scratch/redcraft-optimize-20261016/block-screen-fair.json)。
- [复用矩阵](../../.scratch/redcraft-optimize-20261016/cache-matrix.json)、[复用逐像素核验](../../.scratch/redcraft-optimize-20261016/cache-verification.json)。
- [正式运行与 pins / 回收状态](../../.scratch/redcraft-optimize-20261016/canonical-verification.json)、[正式运行日志](../../.scratch/redcraft-optimize-20261016/canonical-runtime.log)、[Python/MPS 回归](../../.scratch/redcraft-optimize-20261016/python-tests-with-mps-stderr.log)、[Gen 测试](../../.scratch/redcraft-optimize-20261016/gen-tests.log)。
- [融合方案面部对照](../../.scratch/redcraft-optimize-20261016/faces-all.png) 是手工指定固定裁切框的视觉比较，不是生物识别人脸评分。最终采用的复用方案图像逐像素相同，无需用主观评分替代精确对照。
