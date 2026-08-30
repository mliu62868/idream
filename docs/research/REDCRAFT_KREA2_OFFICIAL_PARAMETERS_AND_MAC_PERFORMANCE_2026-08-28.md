# RedCraft Krea2 Identity Edit：作者参数与 Apple MPS 性能核对

日期：2026-08-28

范围：RedCraft 3.0 Krea2 `3139241` FP8、Krea 2 Identity Edit v1.2 full `3139172`、`comfyui-krea2edit` `bdfa8b267fdb13730868d435b277dcfe696ec083` / `1.2.5`。

方法：参数结论只采用作者 Civitai 精确版本/API、作者 Hugging Face 模型卡、固定 revision 的 GitHub README/CHANGELOG/source、Krea 2 官方仓库、ComfyUI `v0.34.2` source、PyTorch `v2.13.0` source/docs；性能结论另用当前 8188 历史和隔离 8193 runner 做固定输入实测。没有修改常驻服务。

## 结论

1. **当前 iDream graph 的核心参数没有偏离作者配方。** `832×1216`、8 steps、CFG 1、Euler / Simple、LoRA 1.0、`fit`、`ref_boost=4`、`grounding_px=768`、同一个 `EmptySD3LatentImage` 同时接 `KSampler.latent_image` 和 patch 的 `target_latent`，都落在作者的正式建议内。8 steps 是作者给出的最快正式档；12 steps 仍可作为偏脸部细节的显式质量档。
2. **本机 A/B 找到了一个明确的 Mac runtime 未优化点：当前 8188 强制使用 split attention。** 隔离 runner 改用 `--use-pytorch-cross-attention` 后，官方 8-step 档完整耗时为 277.44 秒；当前 split runner 的 12-step 为 754.52 秒。步数差异贡献了其中一部分，稳定采样阶段的单步耗时也从约 50 秒降到约 34 秒。它仍达不到作者未注明硬件的“约 1 分钟”，但不是小优化。
3. **FP8 在这台 Mac 上主要是权重存储/内存格式，不是原生 FP8 算力加速。** PyTorch 2.13 的 MPS dtype 映射没有 float8，`_scaled_mm` 也没有 MPS dispatch；ComfyUI 0.34.2 因此把 scaled-FP8 层列为 emulated ops，在 BF16/FP16 计算路径解量化。文件名里的 `fp8-scaled` 不能解释成 Apple GPU 正在用 FP8 tensor core。
4. **Identity Edit 本身比普通 T2I 重。** 它把 VAE reference tokens prepend 到目标序列，并让 Qwen3-VL 4B 再看一次参考图；`ref_boost != 1` 还会建立 target→reference 的加性 attention bias。相同像素数下，它不是“只多一个小 LoRA”。
5. **最可靠且有作者依据的提速是 12→10 或 8 steps。** 10 steps 是作者的质量/速度平衡点；8 steps 更偏构图服从、比 12 steps 少 33% denoise 次数。`grounding_px` 从 768 降到 512 主要减少 grounded encoder 固定开销并增强 edit adherence，不会按比例缩短 12 次 12.9B DiT forward。
6. **`target_latent` 是上游确认过的严重性能坑，但我们已经接对。** 若没接，VAE 会在 sampling 第一阶段进入显存，可能驱逐一部分 diffusion model，导致后续每一步从 CPU stream 权重；当前 descriptor 已接同一 latent，所以不能把现有慢速归咎于这个已知 bug。

## 一、作者参数：三层来源不要混在一起

### 1. RedCraft 3.0 Krea2 `3139241`

[精确 version API](https://civitai.red/api/v1/model-versions/3139241) 的作者说明是：

- sampler：`ER_SDE` 或 `Euler`；
- scheduler：`Simple`；
- CFG：`1`；
- steps：`8–12`；
- 精确 FP8 文件：file `3019490`，12.24 GiB，SHA-256 `F6088960C0FEBD27CBD372FC758BB07D012F2D8AE3CD10C45C903D48B94409EA`；
- 作者随版本上传的 Comfy graph 样例中可见 `12 steps / CFG 1 / Euler / Simple`，尺寸包括 `1024×1536`。

这只是 **RedCraft checkpoint 的作者 T2I 配方**。它没有定义 Identity Edit 的 `fit`、`ref_boost`、`grounding_px` 或双条件 wiring；这些必须服从 Identity Edit 作者的模型卡和节点。

### 2. Krea 2 Identity Edit v1.2 full `3139172`

[精确 Civitai version API](https://civitai.red/api/v1/model-versions/3139172) 给出的 v1.2 变化包括 likeness、高分辨率适配、character sheet、head/face/person replacement、outpaint/inpaint/try-on，并明确让 `ref_boost` 先试 `2–6`。full 文件是 file `3019297`、FP16、约 1.70 GiB、SHA-256 `6ADF9A69CC9502D286DB7B69964D37DA7E9CFE4B05B4D004BC275F087D3FD3CF`。

[作者 Hugging Face 模型卡](https://huggingface.co/conradlocke/krea2-identity-edit/blob/main/README.md#recommended-settings) 给出更完整的正式配方：

| 任务 | 模型档 | steps | CFG | 备注 |
|---|---|---:|---:|---|
| 一般人物换场景、换装、重绘、添加属性 | Turbo 风格推理 | `8–12` | `1.0` | 8 更偏构图服从，12 更偏脸部细节，约 10 是平衡点 |
| 真正删除显著内容 | Raw | `20` | `3.0` | CFG > 1 时负面条件也必须用同图 grounded encode |

其余推荐：

- LoRA strength：`1.0`；
- `ref_boost`：约 `4` 是强脸/身体 likeness 起点；`>10` 会开始破坏删除类编辑，`<1` 更自由；
- `fit`：v1.2 默认，允许 source/output aspect ratio 不同；`crop (legacy)` 只给 v1/v1.1 旧权重；
- 输出：`≤2MP`；超过训练范围会有 source bleed 或主体复制；
- v1.2 `grounding_px`：节点作者在固定 revision 中校正为训练范围 `384–768`，默认 `768`；低值更服从编辑，高值更保身份，`1024+` 是作者称“常常仍可用”的外推，不是训练范围；
- 两参考：scene 必须接主 `source_latent/image`，person 必须接 `_b`；顺序交换会明显变差。

Identity Edit 作者把它明确写成 Krea 2 Raw 的非官方社区 LoRA，并说明其运行需要 dual conditioning，不能用普通 `CLIPTextEncode` 代替。[模型卡的架构与双条件说明](https://huggingface.co/conradlocke/krea2-identity-edit/blob/main/README.md#krea-2-identity-edit)

### 3. `comfyui-krea2edit` v1.2.5 固定 revision

固定 commit `bdfa8b267fdb13730868d435b277dcfe696ec083` 的 [`pyproject.toml`](https://github.com/lbouaraba/comfyui-krea2edit/blob/bdfa8b267fdb13730868d435b277dcfe696ec083/pyproject.toml) 声明 package `1.2.5`；[v1.2.5 release](https://github.com/lbouaraba/comfyui-krea2edit/releases/tag/v1.2.5) 的唯一实质新增是 `target_latent` 预编码时序修复。

作者随包提供的 [example workflow](https://github.com/lbouaraba/comfyui-krea2edit/blob/bdfa8b267fdb13730868d435b277dcfe696ec083/workflows/krea2_identity_edit.json) 默认是：

- Krea2 Turbo scaled FP8；
- Identity Edit v1.2 LoRA strength `1`；
- `1024×1024`；
- `10 steps / CFG 1 / Euler / Simple / denoise 1`；
- `ref_boost=4 / ref_boost_a=1 / fit`；
- 正、负两个 `Krea2EditGroundedEncode` 都是 `grounding_px=768`；
- `EmptySD3LatentImage` 同时连 sampler 和 `target_latent`。

因此，**对人物重构而言 Euler / Simple 是最清楚的一致默认**：RedCraft 作者允许 Euler，Identity 节点作者的示例用 Euler，且节点 changelog 特别提醒 outpaint 优先 Euler/其他 ODE sampler，不要优先 `er_sde`，因为 SDE 噪声会破坏 reference-copy channel。[v1.2.4 advisory](https://github.com/lbouaraba/comfyui-krea2edit/blob/bdfa8b267fdb13730868d435b277dcfe696ec083/CHANGELOG.md#v124--2026-07-29)

## 二、必须保持的 wiring

[`comfyui-krea2edit` 固定 README](https://github.com/lbouaraba/comfyui-krea2edit/blob/bdfa8b267fdb13730868d435b277dcfe696ec083/README.md#minimal-wiring) 要求：

```text
reference ─┬─ VAEEncode ─────── Krea2EditModelPatch.source_latent
           ├─ raw pixels ────── Krea2EditModelPatch.source_image
           └─ raw pixels ────── Krea2EditGroundedEncode.image

UNET → Identity LoRA @1.0 → Krea2EditModelPatch → KSampler.model

output latent ─┬─ KSampler.latent_image
               └─ Krea2EditModelPatch.target_latent
```

关键语义：

- `source_latent` 提供 appearance tokens；
- `Krea2EditGroundedEncode` 让 Qwen3-VL 看见图并理解“左边的人”等 scene semantics；
- `fit` 真正生效需要 `vae + source_image`；只写 `fit_mode=fit` 但不接 pixel path 会退回 latent crop；
- `target_latent` 必须是 sampler 使用的同一个 latent，只用于提前知道输出网格；
- 单参考不要接 `_b`；双参考时 scene 在主输入、person 在 `_b`。

上游源码也直接实现了这些约束：[`Krea2EditModelPatch` inputs 与预编码](https://github.com/lbouaraba/comfyui-krea2edit/blob/bdfa8b267fdb13730868d435b277dcfe696ec083/__init__.py#L260-L374)、[`Krea2EditGroundedEncode` 的 image resize/tokenize](https://github.com/lbouaraba/comfyui-krea2edit/blob/bdfa8b267fdb13730868d435b277dcfe696ec083/__init__.py#L387-L468)。

## 三、与当前 iDream descriptor 对照

当前 [`redcraft-krea2-identity-edit.json`](../../packages/gen/workflows/redcraft-krea2-identity-edit.json) 是：

| 项 | 当前值 | 作者基线 | 判断 |
|---|---:|---:|---|
| 尺寸 | `832×1216`，约 `1.01MP` | `≤2MP` | 合规，且已经是保守尺寸 |
| steps | `8` | `8–12`，约 10 平衡 | 合规，当前 fast 默认 |
| CFG | `1` | `1` | 一致 |
| sampler / scheduler | Euler / Simple | RedCraft 与 example workflow 都支持 | 一致 |
| LoRA strength | `1` | `1` | 一致 |
| `ref_boost` | `4` | 强 likeness 起点约 `4` | 一致 |
| `grounding_px` | `768` | v1.2 训练范围上沿/默认 | 一致，偏 likeness |
| geometry | `fit` + VAE + raw source | v1.2 默认 | 一致 |
| `target_latent` | 接 sampler 的 node `7` | v1.2.5 推荐 | 一致；已避开已知重度 slowdown |
| dual conditioning | VAE latent + raw pixel + Qwen3-VL grounded | 必需 | 一致 |

所以参数层面没有“接错线导致慢”的证据。可以把 12 调成 10 或 8 换速度，但那是明确的质量/速度取舍，不是修 bug。

## 四、为什么 Apple MPS 慢

下面严格区分一手事实和推断。

### 事实 A：官方 Krea 2 快速参考实现不是 Mac 路径

Identity Edit 作者模型卡把 Krea 2 标为 12.9B single-stream MMDiT；Krea 官方仓库的 Raw 配方是 52 steps/CFG 3.5，Turbo 是 8 steps/CFG disabled/`mu=1.15`。官方 `inference.py` 默认 `device="cuda"`、`dtype=torch.bfloat16`；官方 `pyproject.toml` 在 Linux/Windows 指向 `pytorch-cu128`。[Identity 模型卡](https://huggingface.co/conradlocke/krea2-identity-edit/blob/main/README.md#krea-2-identity-edit)、[Krea 官方 README](https://github.com/krea-ai/krea-2/blob/main/README.md#usage)、[inference.py](https://github.com/krea-ai/krea-2/blob/main/inference.py#L34-L58)、[pyproject.toml](https://github.com/krea-ai/krea-2/blob/main/pyproject.toml)

**推断：** Identity 作者写的“Turbo 8 steps、2MP 约 1 分钟”没有硬件字段，不能证明 M4 Max 应达到该速度。至少官方 Krea 参考栈没有为 MPS 提供等价 kernel/benchmark。

### 事实 B：PyTorch 2.13 MPS 没有原生 FP8 dtype / scaled matmul

PyTorch `v2.13.0` 的 MPS dtype switch 包含 FP32、FP16、BF16 和整数类型，但没有 float8；其他 dtype 直接抛 “MPS backend ... does not have support”。[`OperationUtils.mm` L49–87](https://github.com/pytorch/pytorch/blob/cf30153c4c131c8164ee7798e5022d810682e2cb/aten/src/ATen/native/mps/OperationUtils.mm#L49-L87)

同版本 `_scaled_mm` 的 dispatch 只有 CPU、CUDA、XPU，没有 MPS。[`native_functions.yaml` L6982–7012](https://github.com/pytorch/pytorch/blob/cf30153c4c131c8164ee7798e5022d810682e2cb/aten/src/ATen/native/native_functions.yaml#L6982-L7012)

ComfyUI `v0.34.2` 自己也明确：`supports_fp8_compute()` 在非 NVIDIA、且没有显式 backend support flag 时返回 false；mixed-precision loader 会把 FP8 format 放入 `emulated ops`。[`model_management.py` L1954–1970](https://github.com/Comfy-Org/ComfyUI/blob/169fcf35a2fc163fec31338b816503ddac0d3fcf/comfy/model_management.py#L1954-L1970)、[`ops.py` L1651–1667](https://github.com/Comfy-Org/ComfyUI/blob/169fcf35a2fc163fec31338b816503ddac0d3fcf/comfy/ops.py#L1651-L1667)

**源码与本机日志核对：** RedCraft FP8 在 MPS 的主要收益是磁盘/驻留权重更小；线性层仍需解量化后用受支持 dtype 计算。它不会自动带来 NVIDIA FP8 tensor-core 那类吞吐。当前 128 GiB 机器把这份模型 `loaded completely ... full load: True`：full Identity LoRA 在加载阶段对 256 个目标层完成 FP8 解量化、LoRA 合并和重新量化，采样期间不是每一步重新计算 LoRA。每一步仍有的开销，是 ComfyUI 把 MPS FP8 标记为 `emulated` 后对量化权重执行 FP8→BF16 解码与 BF16 Linear。

### 事实 C：Identity Edit 增加 token 与 attention 工作

节点作者说明 source latent 被 prepend 成 clean in-context tokens；源码把序列组装为 `[text | source refs | target]`，28 个 block 都在这个组合序列上运行。`ref_boost != 1` 时，源码还构造 `[batch, 1, total_tokens, total_tokens]` 的加性 bias，再交给 masked optimized attention。[README architecture](https://github.com/lbouaraba/comfyui-krea2edit/blob/bdfa8b267fdb13730868d435b277dcfe696ec083/README.md#krea2editmodelpatch)、[`_ref_attn_bias` 与 forward](https://github.com/lbouaraba/comfyui-krea2edit/blob/bdfa8b267fdb13730868d435b277dcfe696ec083/__init__.py#L139-L249)

**推断：** 当 source 和 target 网格接近时，image token 序列接近翻倍，dense attention pair 数接近普通 T2I 的四倍；此外每次请求还有 Qwen3-VL image-grounded encode。实际总耗时不会精确四倍，因为线性层、VAE、text encode、offload 都参与，但“Identity LoRA 很小，所以应接近 T2I 速度”是不成立的。

### 事实 D：Mac 的 attention 不是 CUDA FlashAttention 路径

PyTorch 的 SDPA 文档明确说明 fused FlashAttention-2 / memory-efficient kernel 的优化说明针对 CUDA；其他 backend 使用 PyTorch implementation。[PyTorch SDPA](https://docs.pytorch.org/docs/stable/generated/torch.nn.functional.scaled_dot_product_attention)

ComfyUI `v0.34.2` 的 attention 选择顺序是 Sage → Flash → xFormers → PyTorch → split/sub-quadratic；xFormers 在非 GPU state 被禁用，PyTorch attention 又没有像 NVIDIA 那样在 MPS 自动启用，所以普通 MPS 启动通常落到 split/sub-quadratic。它还在 macOS ≥14.5 对 FP16 attention 自动 upcast FP32，作为黑图规避。[attention selection](https://github.com/Comfy-Org/ComfyUI/blob/169fcf35a2fc163fec31338b816503ddac0d3fcf/comfy/ldm/modules/attention.py#L853-L883)、[backend gates](https://github.com/Comfy-Org/ComfyUI/blob/169fcf35a2fc163fec31338b816503ddac0d3fcf/comfy/model_management.py#L1675-L1725)、[Mac upcast](https://github.com/Comfy-Org/ComfyUI/blob/169fcf35a2fc163fec31338b816503ddac0d3fcf/comfy/model_management.py#L1736-L1746)

**本机验证：** 上游没有承诺 Krea2Edit/MPS 一定由哪个 backend 胜出，所以本次在隔离端口用固定模型、prompt、尺寸和 reference 做了 A/B。`--use-pytorch-cross-attention` 可正常处理 reference bias，没有出现黑图、NaN 或执行错误，并显著缩短稳定采样耗时。详细数字见“六、本机实测”。

### 事实 E：`target_latent` 缺失会产生灾难性 offload；当前已修

节点 v1.2.5 release 清楚说明：pixel path 若在 sampling 第一阶段才 VAE encode，ComfyUI 可能把 resident diffusion model 部分驱逐，后续每一步从 CPU stream；连接同一个 `target_latent` 会把 encode 移到 sampling 前。[v1.2.5 release](https://github.com/lbouaraba/comfyui-krea2edit/releases/tag/v1.2.5)、[README Pixel path and VRAM](https://github.com/lbouaraba/comfyui-krea2edit/blob/bdfa8b267fdb13730868d435b277dcfe696ec083/README.md#pixel-path-and-vram)

当前 iDream descriptor 已正确连接，因此：

- 如果日志出现 `pre-encoding sources ... before sampling`，这条优化生效；
- 如果出现 `NOTE: connect 'target_latent'` 或 target/sampling resolution mismatch warning，才是 wiring/runtime 漂移；
- 1-step smoke 不适合衡量这个修复，因为作者明确说 1-step 几乎全是 fixed overhead。

## 五、优化优先级

### P0：立即可用、作者明确支持

1. **人物重构默认已从 12 steps 收敛到 8；12 只作为显式质量覆盖。**
   - 10：作者明确的平衡点，理论上比 12 少 16.7% denoise forward；
   - 8：作者明确的 fast path，比 12 少 33.3%，更偏构图服从；
   - 不改 CFG、sampler、scheduler、LoRA strength、wiring。
2. **保持 `832×1216`、Euler / Simple、CFG 1、LoRA 1、`fit`、`target_latent`。** 目前尺寸只有约 1.01MP，继续砍尺寸虽能快，但已经不是首要“错误修复”。
3. **只在 identity 可接受时把 `grounding_px` 从 768 A/B 到 640/512。** 这是 encoder/identity tradeoff，不应期待与 steps 等比例提速。

### P1：最值得做的 Mac runtime A/B

1. **冷启动单模型 runner。** 记录日志中的：
   - `model weight dtype ... manual cast ...`；
   - `Native ops ... emulated ops ...`；
   - attention backend；
   - pre-encode good-path message；
   - 每一步耗时与 MPS/CPU memory。
2. **当前“FP8 存储 + 已合并 LoRA + 每次 forward 解码权重”对比一次性 BF16 merged candidate。** 128 GB unified memory 给了这条路线实验空间；目的不是提高数值精度，而是验证消除每步 256 层 FP8→BF16 权重解码能带来多少收益。当前 LoRA 已在模型完整加载阶段物化并重新量化，不能再把慢归因为“每步动态 LoRA application”。必须保留同 prompt/seed/尺寸/steps 和原 FP8 回滚文件；BF16 merged 与重新量化后的 FP8 不保证逐像素一致。这个建议是源码推断，不是作者承诺。
3. **attention backend 已完成隔离 A/B，PyTorch attention 胜出。** 下一步若落入常驻 8188，仍需用固定身份集做 2–3 张质量回归并保留 split 一键回退；不要把 CUDA Sage/FlashAttention 安装建议套到 MPS。

### P2：PyTorch 官方提供、但必须实测的环境旋钮

[PyTorch MPS 环境变量文档](https://docs.pytorch.org/docs/stable/mps_environment_variables.html) 提供：

- `PYTORCH_MPS_PREFER_METAL=1`：matmul 优先 Metal kernel；
- `PYTORCH_MPS_FAST_MATH=1`：启用 Metal fast math，有数值差异风险；
- `PYTORCH_ENABLE_MPS_FALLBACK=1`：不支持的 op 回退 CPU。

建议前两个逐个做固定样本 A/B；benchmark 时不要把 CPU fallback 当优化，因为它可能把不支持的 op 隐藏成慢路径。`HIGH_WATERMARK_RATIO` 是分配上限，不是速度旋钮；官方警告设为 `0` 可能造成系统级 OOM，不建议用它追速度。

## 六、本机实测：慢在哪里，Mac 哪里没优化

### 当前常驻 8188

运行时是 ComfyUI `0.34.2` / PyTorch `2.13.0` / MPS，启动命令固定带 `--use-split-cross-attention`。日志同时确认：

- Qwen3-VL text encoder：8,464.46 MB，默认在 CPU；
- Krea2：12,532.86 MB，完整加载；
- RedCraft scaled-FP8 被识别为 mixed precision，但 `float8_e4m3fn` 位于 emulated ops，模型报告 `weight dtype torch.bfloat16, manual cast torch.bfloat16`；
- `target_latent` 预编码 good path 生效，不存在逐步 CPU streaming 的已知 wiring bug。

同一尺寸 `832×1216` 的最小实测：

| 路径 | 配置 | sampler | graph / E2E |
|---|---|---:|---:|
| RedCraft T2I | 1 step，Euler / Simple | 2.75 s | 26.17 s |
| Identity Edit | 1 step，`ref_boost=1` | 13.18 s | 56.10 s |
| Identity Edit | 1 step，`ref_boost=4` | 18.88 s | 55.12 s |
| Identity Edit | 12 steps，`ref_boost=4` | 718.68 s | 754.52 s |

这组数字把两个增量分开了：reference + grounded edit 让单步从 2.75 秒增到 13.18 秒；`ref_boost=4` 的 dense bias 再把单步增到 18.88 秒。12-step 长跑后段稳定在约 50 秒/步，说明真正主耗时是组合序列上的重复 attention/DiT forward，而不是 SaveImage 或一个没接好的节点。

### 隔离 PyTorch-attention runner

临时端口 8193 使用同一安装、权重、reference、尺寸与工作流，只启用 `--use-pytorch-cross-attention` 并让模型留在 MPS；测试后已停止，没有接管或修改 8188。

| 配置 | sampler | graph / E2E | 结果 |
|---|---:|---:|---|
| 冷启动 1 step | 1.57 s | 56.76 s | 成功 |
| 热缓存 1 step | 0.41 s | 23.61 s | 成功 |
| 热缓存 8 steps | 243.20 s | 277.44 s | 成功，832×1216 PNG 无黑图/NaN |

多步时第 2 步以后约 30–34 秒/步，所以不能用热缓存单步的 0.41 秒外推整段；但与当前 split 长跑后段约 50 秒/步相比，PyTorch attention 仍是实质提速。当前 12-step 在第 8 步已经累计采样 523 秒，而隔离 8-step 全部采样是 243 秒；两者 sigma schedule 不完全相同，因此这是强方向证据，不是严格等步 benchmark。

`--gpu-only` 让 Qwen3-VL 从 CPU 移到 MPS，但冷启动总耗时没有改善（仍约 57 秒），所以本轮证据不支持把它单独当作主优化；采样阶段的主要差异来自 attention backend。

### 机器状态

- M4 Max 40-core GPU / 128 GB unified memory；接交流电，`powermode=2` 高性能模式；系统没有记录 thermal 或 performance warning。
- 当前 swap 12 GB 中已用约 10.9 GB，但检查时仍有较多可用内存且无 throttled pages；这是长时间工作负载留下的压力迹象，不是本次稳定单步慢的唯一根因。
- 发现两组位于已 quarantine 目录的遗留 `bun test` 已运行约 18.5 小时，持续合计占用约 255% CPU。它们会争抢 CPU、统一内存带宽和功耗预算，应该在确认无任务依赖后终止；本次诊断没有擅自杀进程。

## 七、最终判断

**模型和工作流确实跑通，参数也基本是作者正式参数；慢不是因为我们把 8-step 模型错误跑成 50 steps，也不是因为漏接 `target_latent`。**

目前最有证据的原因顺序是：

1. Krea 2 是 12.9B，官方快速实现以 CUDA/BF16 为参考，不是 Apple MPS；
2. RedCraft scaled FP8 在 MPS 没有原生 FP8 compute，只能走 emulated/dequantized compute；
3. Identity Edit prepend reference tokens 并增加 grounded Qwen3-VL，显著放大 attention 和固定开销；
4. 当前常驻 runner 强制使用 split attention；本机 A/B 已证明 PyTorch attention 在这个工作流上更快；
5. 两组遗留测试进程持续占用约 255% CPU，是应清理的独立机器侧干扰；
6. 12 steps 是作者质量上沿，合理但比 8-step fast path 多 50% denoise 次数。

因此短期实现是：**图片 runner 固定 PyTorch attention，人物编辑默认 8 steps；视频 runner 保留 split attention，两者由主机级 MPS 锁串行执行。** 12 steps 保留为显式质量覆盖，BF16 materialized/merged candidate 排在后面。现在可以确认 Mac runtime 的已知未优化点已经收敛，但仍不能承诺达到作者未注明硬件的约 1 分钟。

## 来源索引

- [RedCraft version `3139241` API](https://civitai.red/api/v1/model-versions/3139241)
- [Identity Edit version `3139172` API](https://civitai.red/api/v1/model-versions/3139172)
- [Identity Edit 作者模型卡](https://huggingface.co/conradlocke/krea2-identity-edit/blob/main/README.md)
- [`comfyui-krea2edit` 固定 README](https://github.com/lbouaraba/comfyui-krea2edit/blob/bdfa8b267fdb13730868d435b277dcfe696ec083/README.md)
- [`comfyui-krea2edit` 固定 CHANGELOG](https://github.com/lbouaraba/comfyui-krea2edit/blob/bdfa8b267fdb13730868d435b277dcfe696ec083/CHANGELOG.md)
- [`comfyui-krea2edit` v1.2.5 release](https://github.com/lbouaraba/comfyui-krea2edit/releases/tag/v1.2.5)
- [Krea 2 官方仓库](https://github.com/krea-ai/krea-2)
- [ComfyUI `v0.34.2` source](https://github.com/Comfy-Org/ComfyUI/tree/169fcf35a2fc163fec31338b816503ddac0d3fcf)
- [PyTorch `v2.13.0` MPS dtype source](https://github.com/pytorch/pytorch/blob/cf30153c4c131c8164ee7798e5022d810682e2cb/aten/src/ATen/native/mps/OperationUtils.mm#L49-L87)
- [PyTorch MPS environment variables](https://docs.pytorch.org/docs/stable/mps_environment_variables.html)
