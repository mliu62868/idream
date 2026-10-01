# REDQW21 V2：作者加速配置与 Mac 图生图实测

> 后续实施更新（2026-10-01）：本地已启用 VAE 修复、单图 MPS INT8 编码与 Viggle 六步，并完成真实产品交付/持久化/单次扣费验证。本文保留当轮历史状态；最新配置、数值 oracle 与耗时见 [实施记录](QWEN21_MAC_ACCELERATION_IMPLEMENTATION_2026-10-01.md)。

## 结论与当前状态

作者推荐工作流描述了原生 Cache 步数优化与批量 LoRA 控制器，但没有指明使用 Viggle/PAI 等 4–6 步蒸馏 LoRA。公开可读样图的六份 prompt 图都加载 **REDV1**，采样模型链是 `UNETLoader → Kitchen attention → QwenImage21Cache → APG → FreSca`，没有外挂快速 LoRA 或 EasyCache 节点。因此这些图不能证明 REDV2 完整工作流的具体配置，也无法排除权重曾合并其他微调。完整工作流下载返回 HTTP 403，未购买。

找到并修复了运行环境错配：image 的 ComfyUI 代码来自新 Qwen21 安装，但 PM2 保存的 `COMFYUI_VENV_PYTHON` 仍指向旧安装（PyTorch 2.10.0）。旧的按名称 restart 命令不会重新读取 ecosystem 定义。现在 image 定义明确指定同安装的 Python，restart 命令重新加载该定义；实际 image API 已确认 PyTorch 2.14.0。相同 832×1216、10 步编辑完整执行从旧环境的 140–164 秒降到 **93.526 秒**，本次输出保住构图并加上红围巾；这是一例受控实测，不能当作稳定延迟承诺。

单参考图仍使用 `qwen-image-edit-img2img@4`：REDQW21 V2 BF16、CPU 上的社区 INT8 Qwen3-VL 8B、原生无损 prefix-KV 缓存、10 步 Euler/simple、CFG 1。EasyCache `threshold=0.2, start=0.15, end=0.7` 候选曾在热运行保住构图，但最终冷启动测试改变了手部姿势和构图，已撤回 canonical/seed 配置，数据库没有发布新 profile。旧环境的参考 VAE 冷、热编码明显不同，不能把所有构图漂移单独归因于 Cache 或 LoRA。双参考图工作流未改变；Rapid-AIO v19 继续退役。

修正后的环境中，社区 Viggle v0.3 r128 6 步 LoRA 实测 **69.450 秒**，同一编辑也保住正面构图。不能根据旧环境中的失败认定它不兼容 REDV2。EasyCache 是近似计算；LoRA 也是另一份采样配方。当前证据仅是一张参考图、一条编辑指令的受控试验，没有完成生产身份质量矩阵，也没有复现用户提到的 M5 Pro 16 秒，因此本轮没有发布采样配方切换。

## 可复现条件

- Apple M4 Max，128 GiB；ComfyUI 0.37.0。旧 image 进程为 PyTorch 2.10.0 / comfy-kitchen 0.2.36；修正后为 PyTorch 2.14.0 / comfy-kitchen 0.2.35（与此安装声明的依赖相符）。
- 模型：`redqw21_unlocked_v2_bf16.safetensors`，SHA256 `c2ff9ea7e983b61589363fe11d0437419f7ade088bb470ef2e501bd81513c45f`。
- 编码器：`qwen3vl_8b_int8_convrot.safetensors`，SHA256 `8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f`。INT8 权重存储，CPU 混合精度运行，不代表 Mac 原生 INT8 GEMM。
- 832×1216，一张参考图，seed 42。指令要求添加红围巾，保留人脸、绿衬衫、白杯、双手、海滩及镜头构图。
- 参考图 SHA256 `f0755a99018699d0e934bd3b566498736ed994d9f23b0734ad43797a1c0a4798`。
- 应用通过项目 wrapper 暂停准入、排空队列并停止；三个原生 runner 均检查空闲。请求通过真实 `providers.image.generate()`，取得共享加速器租约，并保存原生 history、模型运行时、descriptor/source revision、图片哈希与耗时。
- 不创建产品 Job，不扣梦币，不调用外部按量生成接口。每份 JSON 保存实际 source revision；后续代码变更不能冒充同一 revision 的验证。

复现脚本及原始记录位于仓库忽略目录 `.scratch/qwen21-acceleration-diagnosis/`：

```bash
bun .scratch/qwen21-acceleration-diagnosis/benchmark.ts baseline
bun .scratch/qwen21-acceleration-diagnosis/benchmark.ts pinned-baseline
```

执行前必须通过既有 pause/drain wrapper 停止应用，核实原生队列空闲；完成后使用 `bun run pm2:restart` 恢复准入。不要并行占用 GPU。

## 实测记录

以下第一张表均为修正前的实际 PyTorch 2.10.0 进程，包含 VAE 条件漂移的干扰；保留原始观察，不将其当作修正后配方的质量结论。

| 变体 | 总耗时 | 原生执行 | 采样 | 请求 ID | 观察 |
| --- | ---: | ---: | ---: | --- | --- |
| 原始 10 步 | 140.674 s | 139.983 s | 104.4 s | `566198b9-9e18-4b23-9f77-0bc5546da07b` | 构图保留，围巾编辑成功 |
| EasyCache 默认 end=0.95 | 79.495 s | 78.336 s | 54.5 s | `2185bcff-329d-4bc8-b40a-db3e249613a3` | 跳过 5/10 步；脸、衣服和背景有明显颗粒，未采用 |
| Viggle v0.3 r128 6 步，首次 | 150.799 s | 149.928 s | 121.5 s | `c2a27bca-a5a2-42fd-a3c9-6948e65e5271` | 首两步有开销；人脸、视角漂移 |
| 同一 LoRA 6 步，热运行 | 112.586 s | 111.681 s | 80.0 s | `852e3523-50ec-4879-825c-3909a9e4320e` | 回到正面构图；与首次输出明显不同，原因未确定，未采用 |
| EasyCache end=0.7，热运行 | 114.582 s | 113.440 s | 79.7 s | `1cc18677-b771-4e5a-bff1-decb7a5c8b81` | 跳过 3/10 步；此次保住构图，明显颗粒减轻 |
| 原始 10 步再次运行 | 164.322 s | 163.551 s | 以原生日志为准 | `fb0c1a73-081f-4eb7-b388-954f2609e90d` | 构图与首次基线基本一致；耗时存在波动 |
| 最终候选 end=0.7，重启后冷运行 | 108.575 s | 108.243 s | 72.9 s | `91685195-e745-4546-bf0e-088dceea9f9d` | 跳过 3/10 步；姿势、手部和构图漂移，撤回切换 |

基线采样占原生执行约 75%，准入排队不足 1 ms。不能将完整耗时主要归咎于 INT8 编码器，也不能将步数比例当作完整耗时比例。Cache 的速度收益有实测证据，但未通过冷、热编辑保真检查，不能作为已经上线的加速收益。

修正为 PyTorch 2.14.0 后，同一原始 10 步配方的总耗时为 93.526 秒，原生执行 93.117 秒，采样约 64.3 秒，准入等待 0.736 ms，原生缓存命中节点数为 0。请求 `1f431e0b-2b24-4755-b695-4eb4c116c30f`，source revision 为 `idream-worktree-1d64360e30998500dfdc3bc6593b8c1dc66390e0c851dbaaa184851a01375b85`；结果、history 和运行版本保存于 `pinned-baseline*`。

同一新环境下，Viggle 6 步从重新启动的 image 进程开始，总耗时 69.450 秒，原生执行 68.812 秒，采样约 39.7 秒，准入等待 0.850 ms，缓存命中节点数为 0。请求 `da09afbc-068a-491d-9bd8-9a322031b7de`，完整记录在 `pinned-viggle6*`。结果保住正面人脸、白杯与双手构图，红围巾编辑成功；与 10 步图相比有细节差异，两者都相对原图增加了皮肤与衣物纹理。单例只证明此条件下能执行并获得速度收益，不证明全部编辑或双图身份替换质量。

## 参考图编码诊断

临时诊断节点只执行原始图中的文本与参考图编码，在采样前记录 tensor 指纹。两个环境的冷、热运行都使用相同原始图和 prompt；输入图片、正/负向文本 embedding 与零目标 latent 的 SHA256 完全一致，差异发生在参考 VAE latent：

| 实际 image 环境 | 冷运行 mean / std | 热运行 mean / std |
| --- | --- | --- |
| PyTorch 2.10.0 | -0.128566 / 5.625319 | 0.156755 / 3.864711 |
| PyTorch 2.14.0 | 0.156316 / 3.863894 | 0.156734 / 3.863319 |

新环境中大幅统计漂移没有复现，但 latent 哈希仍不同；均值与标准差接近不证明逐元素相等或跨请求严格确定性。256×384 的独立 VAE 对照在两个版本均未复现该大幅漂移，不能用小图结果代替真实 1 MP 条件的证据。临时条件捕获节点已移除。

## Mac 注意力对照

使用准备好的新 image venv（PyTorch 2.14.0）进行离线测试；当时原生服务实际仍使用旧 2.10.0，不能混淆两者。合成 Qwen 缓存形状 `Q=[1,32,3952,128]`，`K/V=[1,32,8050,128]`；四个 head 的四行用独立 CPU float64 softmax/GEMM 校验。BF16 输入误差限为相对 RMSE 0.005、最大绝对误差 0.002，三组均通过。MPSGraph 四次调用均实际进入 `mpsgraph_zc`，没有静默回退。

| 实现 | 预热后中位耗时 | 相对 RMSE |
| --- | ---: | ---: |
| PyTorch BF16 | 38.144 ms | 0.001688 |
| PyTorch FP16（包含转换） | 39.912 ms | 0.001731 |
| MPSGraph BF16 | 39.874 ms | 0.001694 |

这不是捕获的模型激活，也不是完整生成测速；没有测出收益，因此没有修改原生注意力或扩散计算精度。作者的 Kitchen INT8 注意力仅支持 NVIDIA/AMD，当前 MPS runner 的 `ModelAttentionBackend` 也仅提供 PyTorch。

## 社区方案与证据边界

- [作者 REDV2 页面](https://civitai.red/models/452459?modelVersionId=3370753)与[原生加速工作流](https://civitai.red/models/579280?modelVersionId=3343677)：公开 API 描述保存在 `author-*.json`；解析的样图 prompt 图保存在 `author-example-graphs.json`。
- [Viggle v0.3](https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo/blob/009a44a895ef85f7e643c80fdca9543795248867/README.md)：社区确有 6 步编辑 LoRA。试验使用 r128、未合并 scale 1、作者动态分辨率 shift sigmas `[1,.9375,.875,.75,.5,.25]`、Euler、BasicGuider，无负向 CFG。未替换 REDV2 为社区已合并的官方底模。
- r128 文件为 679,604,800 bytes，SHA256 `0c98591700346f9777051d4e6fa29aa94519abec0d85b1f1f672a2a3db8c94b3`；上游节点 SHA256 `0592defd8ee6555b8c02bd9b287514849b1d46f579f47f8c7f711e6411f89587`。节点仅在受控测试期间加载，已移除，不在活跃配方中。
- [Alibaba PAI](https://huggingface.co/alibaba-pai/Qwen-Image-2.1-Fun-Acc-LoRAs/blob/main/README.md) 的 4NFE 需要其 PDD 采样实现，不能当普通 4 步 KSampler LoRA。此前离线试验没有跑通，此次没有补做其完整实测。
- [MFLUX 原生 MLX 参考编辑](https://github.com/mflux-community/mflux/blob/main/src/mflux/models/qwen21/reference/README.md)与[Draw Things M5 内核](https://releases.drawthings.ai/p/metal-flashattention-v25-w-neural)属于另一个运行实现。尚未验证这些后端对当前 REDV2 权重、参考编辑契约的兼容性，不将其数字套用到本系统。

## 撤回与验证

最终冷运行的保真失败后，canonical descriptor、seed 和版本断言均还原到本轮开始时的配置。候选 SQL 与测试移动到 `.scratch/qwen21-acceleration-diagnosis/candidate-publication*`，没有对开发库执行。实际保留的运行修复是 image Python 路径与 restart 定义加载；没有改变当前模型、采样图或双图版本。

候选阶段 Gen 四组相关测试 72/72、Gen/Main typecheck、seed/test ESLint 通过；Main 三组切换集成测试 5/5 通过（专用 `idream_test`、Redis 15），覆盖未固定版本的排队请求拒绝、历史和价格保留、双图不变及重复发布。这些测试不能替代真实输出保真检查，因此没有发布候选。

撤回后 Gen 相关测试再次 72/72 通过。新增的 PM2 Python 回归用例在修复前复现旧路径，修复后通过；完整 PM2 配置与编排测试 162/162 通过。视频进程的 Python 未改动。

受控试验结束后移除了临时 LoRA 节点，重新启动原生 runner 并确认 image 仍为 PyTorch 2.14.0、三个原生队列空闲。通过 `bun run pm2:restart` 恢复八个应用/worker；wrapper 的 readiness、ownership 和四个队列 resume 检查通过，八个服务均 online。恢复后的 `check:generation-cutover` 通过（活跃请求、Bull 执行中请求、待处理 outbox 均为 0），记录在 `restore-apps.log` 与 `restored-cutover.log`。这是受控 provider 验证与服务恢复证据，没有覆盖产品计费或公开生产链路。
