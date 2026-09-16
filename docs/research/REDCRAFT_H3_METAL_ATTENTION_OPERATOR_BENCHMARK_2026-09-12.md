# RedCraft H3：完整 Metal attention 算子测试

日期：2026-09-12。结论：**本轮未发现值得接入当前 M4 Max / ComfyUI H3 的速度优化，保留现有 SDPA。** 两套候选库均已实际运行；通过数值筛选的路径更慢，部分路径未通过数值筛选。没有安装到生产 Python 环境、修改工作流、启停服务或生成视频。

## 测试范围

- Apple M4 Max / 128 GiB，macOS 26.5.1，PyTorch 2.13.0，Python 3.13.12。
- iDream revision：`bd42bcd0b1772bd579b2c2229c4c3e236b5a39f9`；ComfyUI revision：`c645560264062e6a5b0688d25eaf3ee9906a7709`。
- 当前运行日志确认 H3 `model weight dtype torch.bfloat16, manual cast: torch.bfloat16`，视频 VAE 为 FP16。
- 隔离 venv：`.tmp/h3-metal-attention-20260912/venv`，通过只读路径复用当前 runtime 的 torch；仅在隔离目录安装 `mps-flash-attn==0.6.3` 和 `mtlflashattn==0.2.0`，禁用自动 shim/SDPA patch。
- 每批通过项目 `withGenerationAcceleratorLease` 获得 GPU lease，并确认 8188/8189/8190 队列为空。未停止常驻服务；计时仍可能受系统负载及热状态影响。
- 测试进程的 MPS allocator 上限为推荐工作集的 25%；没有修改其他进程的内存策略。

**这是合成输入的算子筛选，不是捕获真实生成中的 Q/K/V，也不是视频端到端验证。** 使用固定 CPU seed `20260912`、RMS-normalized Gaussian Q/K 和 Gaussian V；两个 DiT 场景另读取现有 RedCraft checkpoint 的 block 0 / block 25 Q/K norm 权重，覆盖不同的 logit 尺度。未读取整个模型或执行完整 DiT。

## 形状依据

本地 `comfy/ldm/minimax/model.py` 的主干为 56 heads × 128 dimensions，采用完整、非因果、无 mask attention。Q/K 保留投影缓冲的非连续步幅，V 如 H3 forward 一样 clone。所有后端都包含转换成 ComfyUI `[B,S,H*D]` 输出的成本，候选所需的连续化、dtype 转换也算入计时。

| 场景 | 输入形状 `[B,H,N,D]` | 精度 | 依据 |
| --- | --- | --- | --- |
| DiT | `[1,56,10398,128]` | BF16 | 当前 512×512、124 帧，假设 256 text tokens，block 0 norm |
| DiT 较长/较强 norm 场景 | `[1,56,11166,128]` | BF16 | 同包络，假设 1024 text tokens，block 25 norm |
| 视频 VAE tile | `[1,32,1797,64]` | FP16 | 7 latent time slices × 16×16 tile + 4 registers + 1 suffix |
| API smoke | `[1,4,1024,128]` | BF16 | 先验证扩展可加载及参考计算；不代表生产耗时 |

主干长度计算来自本地 `nodes_minimax_h3.py` 和 `PackedLayout`：124 帧 → 37 latent frames；视频 `37×16×16=9472`，首帧条件 `256`，双声道音频 `2×round(124/24×40)=414`，再加 text tokens。文本长度是明确的测试场景，并非观测到的真实 prompt 长度。VAE 使用其 256-pixel tile 和 5+2 temporal overlap 配置；只测试该 tile 形状，不声称覆盖所有 decoder 调用。

## 数值判定与计时

独立参考使用 **CPU float64** 的 matmul → softmax → matmul；每个场景抽取 4 个 head、32 个 query 位置，但计算这些 query 对**全部 key/value**的 attention。先把输入量化到目标 dtype，保证所有实现比较同一输入。记录 relative RMSE、max absolute error、cosine；这不是以现有 SDPA 自己作为唯一正确答案。

筛选线在候选运行前按参考输出量化误差定义：

- relative RMSE ≤ `max(0.005, 4 × output-quantization relative RMSE)`；
- max absolute error ≤ `max(0.002, 4 × output-quantization max error)`；
- 首轮检查抽样输出 finite；补测脚本加强为全输出 finite，再检查抽样精度。

这些是本次算子筛选标准，不是 H3 官方容差，也不是视频感知质量阈值。失败照实记录，不放宽门槛，不把失败路径列为速度赢家。验证通过后，每个后端预热两次，采用五轮轮换顺序计时；每次计时前后显式 `torch.mps.synchronize()`，首次编译耗时单独记录。

## 性能结果

以下为 warm 单次完整 attention 调用的中位数，单位毫秒。表中倍数是**候选耗时 / 同批 SDPA 耗时**，大于 1 表示更慢。各批热状态不同，不能拿补测基线与首轮候选交叉比较。

| 场景/批次 | 当前 SDPA | 候选 | 候选耗时 | 相对耗时 |
| --- | ---: | --- | ---: | ---: |
| DiT / 首轮 | 322.09 | mps-flash-attn，BF16 | 1077.45 | 3.35× |
| DiT / 首轮 | 322.09 | mtl 自动选路，显式 BF16→FP16→BF16 | 435.16 | 1.35× |
| VAE / 首轮 | 2.47 | mps-flash-attn，FP16 | 7.72 | 3.12× |
| VAE / 首轮 | 2.47 | mtl 自动选路，FP16 | 3.93 | 1.59× |
| DiT / 指定 v1 补测 | 444.38 | mtl v1，显式 BF16→FP16→BF16 | 1371.82 | 3.09× |
| VAE / 指定 v1 补测 | 3.24 | mtl v1，FP16 | 10.79 | 3.33× |

即使计入波动，结果也不支持当前形状下的加速接入。显式 FP16 路线改变了 attention 内部运算精度；虽然这些场景通过算子筛选，也不能据此直接改变生产精度。

## 数值结果及自动选路发现

| 场景 | SDPA relative RMSE | mps-flash | mtl BF16 自动模式 | mtl 显式 FP16 自动模式 | mtl v1 FP16 |
| --- | ---: | ---: | ---: | ---: | ---: |
| DiT / block 0 | 0.597% | 0.166% | **0.745%，未通过** | 0.171% | 0.500% |
| DiT 较长 / block 25 | **0.965%，未通过** | 0.165% | **2.227%，未通过** | 0.169% | **1.159%，未通过** |
| VAE | 0.0406% | 0.0209% | 0.0529%（此处输入 FP16） | 同一路径 | 0.2375% |

较长 DiT 场景中，原 SDPA 也超过本次约 0.659% 的 relative RMSE 门槛，因此未给它生成 warm 性能比。mps-flash 和 mtl 显式 FP16 分别为 1238.26ms、571.96ms；缺少同批有效基线，不能据此计算升级倍速。这个合成输入发现只说明数值敏感性，**不能推出当前生产视频已经出现可见错误**。若要追究质量，应另行捕获真实生成 activations 并检查最终视频；不因本次微基准直接改生产。

此前资料说 M4 通常走 mtl v1/torch fallback；实测 0.2.0 自动模式却在本机选择了 `v2` / `v2r(bfloat)`。检查已安装 `_kernel.py::_v2_supported()` 可见，它判断 macOS 版本和 shader 是否能编译，没有检查 M5 芯片型号。TRACE 记录了实际路径，所以不能把“编译成功、自动选到 v2”当成具备 M5 加速能力的证据。补测显式 v1 仍更慢，排除了只因自动路由不合适而漏掉明显收益的可能。

`dit-long-v1` 中两条路线均未通过筛选，脚本按合同返回非零；JSON 在退出前已完整保存，lease 的 finally 清理仍执行。这是记录下来的测试不通过，并非忽略异常或跳过失败。

## 内存与限制

DiT 测试进程的 RSS 高水位约 1.86–1.98 GiB；同步调用后观测到的 MPS driver allocation 约最高 2.01 GiB。它们包含输入、参考计算及多后端缓存，**不是每个 kernel 的瞬时峰值**，不能用来宣称候选节省多少显存。系统原有 swap 占用未清空，本轮未记录完整前后 swap 增量，因此不声明“零新增 swap”。

本轮只覆盖主干与视频 VAE 的代表性形状、固定合成 seed；没有测整个文本编码器、音频 VAE、真实隐藏状态分布、完整八步轨迹或视频质量。更高分辨率、更多 token、其他芯片可能有不同结论。

## 文件、复现与验证

- 当前可复用 [算子脚本](../../scripts/benchmark-h3-metal-attention.py)。参数 `--case`、`--checkpoint`、`--backends`、`--repeat`、`--warmup`、`--output` 明确输入输出；没有后端通过筛选时非零退出。
- [原始 JSON 与日志](evidence/h3-metal-attention-2026-09-12/sha256.json)保存 SHA256 索引；[首轮 DiT](evidence/h3-metal-attention-2026-09-12/dit.json)、[VAE](evidence/h3-metal-attention-2026-09-12/vae.json)、[较长 DiT](evidence/h3-metal-attention-2026-09-12/dit-long.json)、[v1 补测](evidence/h3-metal-attention-2026-09-12/dit-v1.json)。
- JSON 记录各次脚本 hash。为保留首轮证据，另存 [初始脚本文本快照](evidence/h3-metal-attention-2026-09-12/initial-benchmark-source.txt)；它是不可变实验材料，不是第二套维护实现。当前脚本新增指定 v1、全输出 finite 检查和计时前 allocator 预热。
- [lease launcher 快照](evidence/h3-metal-attention-2026-09-12/lease-runner-source.txt)展示实际持锁、检查 ComfyUI 队列和 300 秒子进程上限的执行方式。

本机保留隔离环境和 `.tmp/h3-metal-attention-20260912/run.ts`，可按原协议重现。例如：

```bash
H3_BENCH_BACKENDS=sdpa,mtl-v1-fp16 H3_BENCH_SUFFIX=-recheck \
  bun --env-file=packages/gen/.env \
  .tmp/h3-metal-attention-20260912/run.ts dit vae
```

这是复现说明，不表示本轮需要继续重跑。若 `.tmp` 被清理，用同版本隔离 venv、快照 launcher 和当前脚本重建；不要把库装进生产 runtime，也不要绕过 accelerator lease。

本轮实际完成：四种基础形状的算子运行，三种形状的指定 v1 补测，独立 float64 参考，原始结果保存，Python 语法、文档链接和 diff 空白检查。生产模型、服务和配置保持原状。

上游来源：[mps-flash-attention](https://github.com/mpsops/mps-flash-attention)、[mtlflashattn](https://github.com/pawel-mazurkiewicz/mtlflashattn)，访问于 2026-09-12。性能结论依据本机 JSON，而非 README 宣传倍速。
