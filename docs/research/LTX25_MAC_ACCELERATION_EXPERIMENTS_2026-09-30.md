# RedGraft / LTX 2.5 Mac 加速实验

日期：2026-09-30。这是受控 Comfy backend / MLX 可行性实验，未测试产品 BFF 交付、数据库与额度扣减，未修改默认 workflow 或启动配置。研究来源与量化建议见[调研记录](LTX25_MAC_ACCELERATION_RESEARCH_2026-09-30.md)。

## 当前判断

保留当前 INT8 ConvRot Gemma。MPSGraph 是保留权重的最小改动候选；MLX Q8 已完成完整音视频可行性运行，主要收益来自解码，采样本身略慢于MPSGraph。低位 Gemma 文件更小不等于完整视频更快。默认路由仍需多 seed、音画质量与失败恢复验收。

总耗时可拆为：加载 + 文本编码 + 8次低分辨率 DiT + 3次高分辨率 DiT + latent upscale + VAE + 保存。Gemma 每个 prompt 编码一次，DiT 重复11次，因此改善数百秒的采样比改善十几到几十秒的文本编码更可能带来显著收益。VAE 约252秒，是 attention 优化之后仍存在的独立瓶颈。

## 固定输入与版本

- M4 Max，40 GPU cores，128GB，macOS26.5.1；Comfy0.34.2、torch2.13.0、Python3.13.12、kitchen0.2.31。
- 仓库 HEAD `c1d4508e11dd306b36cd4cfd38163a6fd3ea34a6`；工作树还有其他任务的修改。
- canonical workflow SHA-256 `362c5361425a046254c479c080117f390a2cc709f4cbb07182e5f35980cde131`。
- Comfy checkout `c645560264062e6a5b0688d25eaf3ee9906a7709`，隔离端口8191经现有wrapper启动；8188/8189/8190保持服务，实验前检查队列为空。
- 共用实际 `withGenerationAcceleratorLease`；在 lease 内清理闲置runner模型缓存，GPU任务串行。
- RedGraft `redgraftLTX25Fast2K_ltx25RedgraftNSFW.safetensors`，Gemma `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors`；实际DiT为混合W4A8与INT8，不是统一INT8。
- 768×1152、121帧、24fps、带音轨，8+3 Euler、CFG1、×2 latent upscale，Conv BF16 VAE；stage2 sigmas `.85,.7250,.4219,0`。
- 输入 `ltx23-gtanimation-alexa-reeves.webp`，SHA-256 `b65590b7ecdee0b5121b0ee3671ae81ab8aa7c471ef171575b23253d5c78e41b`；成年女性游艇场景，眨眼、微笑、挥手、说欢迎上船。seed `2026082801` / stage2 `2026082802`。
- 保留原补丁 `tensor_to_fp8,int_mm_mps,fused_norm_mps,rope_fast_mps`；M4 native FP8与Metal4.1扩展关闭。

完成运行后重新读取权重SHA-256：RedGraft `ab59bb5e74e76937b55a6876fb23c4b58261e798227eb544f7d8a2934728c882`；Gemma `6ce688a0aa98a5fa36a9f1e6c3f42152a498cc2b53ee8c15674c64244f91487f`。[checksum记录](../../.scratch/ltx25-mac-optimization-20260930/model-checksums.txt)

## 已观察的 Comfy 结果

**证据限制：原 `.tmp/ltx25-mac-optimization-20260930` 在 A2 运行期间被清理。A1/B及早期文本实验的原始报告、视频和QKV样本已不在原路径。下表这些行来自清理前已读取的会话记录，不冒充仍可复核的原始文件。A2的内存中报告和最终latent已成功保存到新目录。** 因而这些观察支持候选筛选，不足以作为默认路由的完整验收。

| 运行 | 文本正/负编码 | stage1 | stage2 | video VAE | 耗时边界 |
| --- | ---: | ---: | ---: | ---: | --- |
| A1 split / CPU Gemma | 27.42s | 359.77s | 478.43s | 约253s | 完整视频1136.26s（18.94min） |
| B MPSGraph / CPU Gemma | 21.36s | 160.56s | 370.14s | 251.73s | 完整视频815.88s（13.60min） |
| A2 split / CPU Gemma | 23.33s | 294.15s | 471.02s | 未执行 | 到最终latent801.57s；采样765.17s |

B采样530.70s，比A1减少36.7%、比A2减少30.6%。A1的低分辨率阶段存在明显波动，因此以两次基线给出范围；A2运行期间还发生临时目录清理，未隔离该外部磁盘活动的性能影响。B完整视频比A1减少28.2%；A2停止在VAE前，**不能**拿A2的801.57s与B的完整815.88s直接比较，也不能把估算的A2解码时间当实测。

A1 prompt `515dbf56-b0c3-4c87-bab1-df0986afc131`；B `cd5430e8-cd89-4450-b1c9-e098fbc2b5c4`；A2 `647e361b-5889-484c-94b9-4c23b9cdbc55`。A2报告的 `execution_cached.nodes=[]`、两阶段实际执行、输出 video `[1,128,16,36,24]` / audio `[1,8,126,16]` 全部有限值。[A2原始报告](../../.scratch/ltx25-mac-optimization-20260930/baseline-sampling-repeat/report.json)

清理前，A1/B经ffprobe核对均为H264 768×1152、24fps、121帧、5.041667秒，带48kHz双声道AAC；接触表看到连续动作与相同身份，无黑/绿/冻结片。121帧SSIM均值0.909709、最小0.763949，表情、手部轨迹和纹理有差异，不能称无损，也未完成3seed与口型/语音内容验收。物理footprint观察峰值A1约69GB、B约31GB；ps RSS约25GB不包含完整GPU物理占用，不能当总峰值。原footprint日志已被清理，这些内存数字也仅作为初步观察。

### attention 数值边界

候选节点只对一个 MODEL 安装 override，不全局替换 Gemma / H3。真实video Q/K/V首先抽样3个head、3个query、完整keys，在CPU float64独立计算参考。BF16误差在预设量化舍入容限内；实际观测相对RMSE约0.14%–0.24%。video长序列命中原生MPSGraph；短audio等shape会退回stock attention，不声称所有attention都命中新核。当前recipe未使用mask，不冒充真实masked路径已验收。

早期合成 `[B1,H32,L3456,D128]` BF16 probe：split FP32中位38.02ms，MPSGraph FP32 23.28ms，MPSGraph BF16 15.30ms。L13824、split预算4GiB：639.64 / 447.13 / 272.59ms。约2.35–2.48倍仅为局部算子；全视频受其他计算限制。[可复运行脚本](../../scripts/benchmark-ltx25-mps-attention.py)

首次L13824试验的32GiB进程上限与Comfy按host free RAM估算chunk不一致而OOM；随后显式4GiB estimator预算通过。这不证明生产workflow OOM。

清理后重新保存了合成probe：L3456的split / MPSGraph FP32 / MPSGraph BF16中位为37.60 / 19.75 / 15.39ms；L13824、split预算4GiB为631.30 / 440.02 / 242.40ms。两种MPSGraph模式每个shape都记录4次真实 `mpsgraph_zc` 调用、无fallback，CPU float64抽样参考通过。BF16局部加速约2.44 / 2.60倍。[L3456新报告](../../.scratch/ltx25-mac-optimization-20260930/attention-3456.json)、[L13824新报告](../../.scratch/ltx25-mac-optimization-20260930/attention-13824.json)

重新安装完整依赖时发现：mps-sdpa0.2.0自动校准的是PyObjC复制后端，生成的三个dtype阈值均为null，连零拷贝请求也全部退回stock。这次失败路由已保存为 [fallback记录](../../.scratch/ltx25-mac-optimization-20260930/attention-auto-calibration-fallback.json)。实验runner需在启动前设置 `MPS_SDPA_SKIP_CALIBRATION=1`，使用已筛选的默认阈值；节点缺少该配置或已缓存null阈值时明确拒绝，不静默宣称命中MPSGraph。新bench验证实际call stats，模型仍只在图内覆写attention。[依赖的阈值判断源码](https://github.com/crlandsc/mps-sdpa/blob/main/src/mps_sdpa/backends/mpsgraph_zc.py)

### Gemma CPU / MPS

同一 INT8 Gemma 移到MPS后，正/负embedding相对RMSE约0.19%，shape、metadata与有限值通过。显式completed CLIP释放后，MPS allocated从14.292GiB降至约0.005GiB，owner不再持有权重；保留同设备活跃DiT/VAE。

初次编码27.42→24.74s，没有明显完整链路优势。固定正提示词先执行的复测中，CPU编码36.64s、MPS12.72s；文本子图整体39.08→26.54s，但MPS的finish节点包含数值比较与释放，不能把它全部归为卸载耗时。两轮冷热/缓存条件不同，不能只选最大收益。完整视频组合候选尚未执行。

## MLX Q8 可行性

固定 WeeTodd `85ccf847e9fdc8c061895c8ce91e8f1209cfd2ba`，使用它实际声明的 dgrauet `91e6f6c9bd621ff2ae31adfee643e113d67d6ae8`（core/pipelines0.15.2），没有擅自换到更新main。完成运行的是MLX / mlx-metal **0.32.2**、mlx-arsenal0.2.4的独立venv。0.32.3虽然满足声明的最低版本，但在导入Sol模块时触发Steel QK layout断言，尚未开始采样；改用作者README所用的0.32.2后通过，未改第三方kernel。失败已保留，[0.32.3错误报告](../../.scratch/ltx25-mac-optimization-20260930/mlx-0323-error.json)。直接读取已有权重，没有另下载大型模型。[接口与转换分析](../../.scratch/ltx25-mac-optimization-20260930/mlx-feasibility.md)

实验路线为 CPU 正确解包W4/INT8、逆ConvRot→每block二维weight按group64 Q8→严格加载全部DiT参数。connector不重复导入，使用重新捕获的Comfy最终conditioning `[1,1024,6144]`，Gemma与connector准备耗时单列。保留8+3、stage2 sigma与图像强度.7/1；stage1使用ancestral入口但eta=0，没有添加ancestral噪声。MLX RNG、浮点激活、再量化误差、图像预处理与VAE tile仍有差异，因此不能声称跨runtime逐像素parity。

| MLX阶段 | 实测 |
| --- | ---: |
| Comfy MPS Gemma + connector准备，独立进程 | 16.81s |
| CPU恢复、Q8转换、严格模型加载 | 70.13s（Q8 payload19.17GiB，7355个tensor） |
| stage1：8次forward | 191.21s |
| stage2：3次forward | 379.87s |
| latent upscale | 1.41s |
| 释放采样组件 | 0.39s |
| 音视频decode + MP4保存 | 25.07s |
| native运行：包含组件加载、11次forward和解码；不含前两项准备 | 599.44s |
| 本次转换进程总计 | 669.61s |
| 两个进程耗时相加 | 686.42s（约11.44min） |

这是一次完整可行性运行，不是已测试的常驻服务延迟，也不是去掉转换后的第二次热请求。当前Q8转换结果只在RAM，未写19GiB pack。抽查前8个weight相对新增RMSE0.57%–1.31%；这不是整个模型质量误差上限。

MLX两阶段纯采样合计571.07s，比此前MPSGraph的530.70s慢约7.6%；更快的完整结果主要来自解码方式。包含文本准备与转换的686.42s，比此前B完整815.88s少约15.9%，但B原始产物已失且两引擎配方并非完全相同，仅作初步比较。**下一步值得隔离测试MLX流式VAE对同一Comfy latent的解码**，先证明其质量与tile差异，再决定是否需要迁移整个DiT；本轮未实现该第四项候选。

[MLX原始报告](../../.scratch/ltx25-mac-optimization-20260930/mlx-report.json)、[完整运行日志](../../.scratch/ltx25-mac-optimization-20260930/mlx-video.log)、[conditioning记录](../../.scratch/ltx25-mac-optimization-20260930/conditioning-report.json)。MLX allocator peak29.37GiB；独立macOS footprint采样物理peak约34GB，两者不是同一指标。[物理内存采样](../../.scratch/ltx25-mac-optimization-20260930/mlx-physical-memory-0322.jsonl)

产物经ffprobe确认H264 768×1152、121帧、24fps、5.041667s，带48kHz双声道AAC（5.01s）；`ffmpeg -v error -f null -`全量解码无错误，音轨非静音、峰值-1.6dB。抽查首帧及每秒到末帧，身份连续、微笑/挥手/说话动作存在，无黑/绿/冻结片；手部仍有局部扩散瑕疵。未验证台词逐字正确、精确口型同步或3seed质量，不据单次运行默认切换。[media数据](../../.scratch/ltx25-mac-optimization-20260930/mlx-media.json)、[接触表](../../.scratch/ltx25-mac-optimization-20260930/mlx-contact-sheet.png)、[视频](../../.scratch/ltx25-mac-optimization-20260930/mlx-redgraft.mp4)。视频SHA-256 `d4b21cbcfa0c05ca9bbf8b0d0d8c34eb4809afca6ad770b54ea0bebee132be4c`。

## 代码与验证

- 增加 opt-in `IDreamMPSGraphAttention` 与独立 requirements；未接入默认graph。
- `IDreamFreshCLIPLoader`增加可选 `default/cpu/mps`，默认不变；显式completed CLIP可在MPS释放，卸载失败保留owner和registry。
- 生命周期8项测试通过，包含MPS CLIP释放且保留DiT/VAE、卸载失败保留owner的回归风险；Python语法检查与diff whitespace检查通过。真实依赖下核对了MODEL clone保持原options不变，以及未设置校准开关时明确拒绝。
- 实验依赖与脚本留在 `.scratch/ltx25-mac-optimization-20260930`；模型文件、现有runner配置和业务workflow未更换。

最终MPSGraph节点SHA-256 `3fd0cc9fe42cf813efca477221cbf02cfea2b53a4167abf8a269c990a4d06da8`；生命周期节点 `52493b770889021addd83986cd49150844c111db8e27bf4e67e914380dec8e65`。原B执行的是相同attention数值函数；后来新增的校准拒绝条件与bench真实调用检查未改变函数运算。
