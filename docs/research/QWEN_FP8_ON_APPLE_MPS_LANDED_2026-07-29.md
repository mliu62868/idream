# Qwen Rapid-AIO 在 Apple MPS 上以 FP8 常驻（已落地）

日期：2026-07-29
范围：本机 ComfyUI `0.29.0` / PyTorch `2.10.0` / Apple M4 Max / 128 GiB unified memory。
本文推翻了 [`QWEN_IMAGE_FP8_INT8_APPLE_MPS_SUPPORT_2026-07-24.md`](./QWEN_IMAGE_FP8_INT8_APPLE_MPS_SUPPORT_2026-07-24.md) 结论 4（「当前可靠路径仍是离线恢复到 BF16/FP16」）的适用范围：社区已有可用方案，Qwen 现在直接以 8-bit 常驻。

## 结论

1. **Qwen 图生图已切到 26 GB FP8 原版，53 GB BF16 副本已删除。** 常驻内存 14.95 → 11.02 GB，冷启 128.5 → 84.2s，**输出逐像素完全相同**（RMSE `0.000`，max diff `0`）。
2. **画质零风险不是运气，是必然。** Rapid-AIO 上游权重本就是 `F8_E4M3`；那个 53 GB BF16 是 `dequant_fp8_to_bf16.py` widening cast 出来的容器，没有任何信息增益。FP8 常驻 + 计算时 cast 回 bf16，走的是完全相同的数值路径。
3. **不能用全局 `--fp8_e4m3fn-unet`。** 它在 `unet_dtype()` 里无条件生效，会劫持所有走 UNETLoader 的模型。实测 bf16 krea2 在该 flag 下输出 RMSE `43.5`、最大通道差 `214`、延迟 `+49%` —— 是完全不同的图，不是轻微降质。
4. **正确做法是节点级 dtype：`CheckpointLoaderKJ` + `weight_dtype: fp8_e4m3fn`。** 影响面锁死在 Qwen 三个 descriptor，其他模型一个字节都不受影响，且不需要改任何 ComfyUI 启动参数。
5. **两个社区 FP8 shim 里只有一个能用。** `fp4-fp8-for-torch-mps` 有效；`fp8-mps-metal` 在 PyTorch 2.10 和 2.13 上**都完全不生效**，尽管它自称 tested on 2.10.0。

## 最终方案

| 组件 | 取值 |
|---|---|
| 权重文件 | `Qwen-Rapid-AIO-NSFW-v19.safetensors`（26 GB，plain FP8 `F8_E4M3`） |
| Loader 节点 | `CheckpointLoaderKJ`（`custom_nodes.comfyui-kjnodes`），输出 `MODEL/CLIP/VAE`，与 `CheckpointLoaderSimple` 接口兼容 |
| dtype | `weight_dtype: fp8_e4m3fn`、`compute_dtype: default` |
| MPS FP8 支持 | `fp4-fp8-for-torch-mps==1.0.3`，装在 ComfyUI venv |
| 启动参数 | **不变**（`--enable-manager`，没有加任何 fp8 flag） |

`fp4-fp8-for-torch-mps` 注册了 PyTorch 官方的 `[torch.backends]` entry point：

```
[torch.backends]
fp4_fp8_for_torch_mps = fp4_fp8_for_torch_mps._autoload:_autoload
```

所以装进 venv 后 `import torch` 时自动激活，**不需要 PYTHONPATH、不需要显式 import、不需要改任何代码**。它的实现是给 MPS dispatch key 注册 `aten::mm` 等 kernel。

## 实测数据

同一 workflow（`qwen-image-edit-img2img`）、同素材 `ref-0.png`、同 prompt、832×1216、4 steps、`sa_solver/beta`，RSS 取 ComfyUI 服务进程实测值：

| 方案 | 冷启 | 热跑 | 常驻 RSS | 对其他模型 |
|---|---|---|---|---|
| BF16 53 GB（原生产） | 128.47s | 72.24s | 14.95 GB | 无影响 |
| FP8 26 GB + 全局 `--fp8_e4m3fn-unet` | 109.75s | 73.28s | 8.72 GB | **破坏**（krea2 RMSE 43.5） |
| **FP8 26 GB + `CheckpointLoaderKJ`** | **84.20s** | 76.23s | 11.02 GB | 无影响 |

采纳第三行。相对原生产：**内存 −26%、冷启 −34%、热跑 +5.5%、画质零差异**。

三个 Qwen workflow 在重启后的生产实例（8188）上均真实出图：

| workflow | 结果 | 耗时 | 备注 |
|---|---|---|---|
| `qwen-image-edit-img2img` | success | 84.20s 冷 / 76.17s 热 | RSS 稳定 11.02 GB |
| `qwen-image-edit-multi-reference` | success | 134.71s | 两张不同输入图 |
| `qwen-image-edit-multi-identity` | success | 141.37s | 三张不同输入图 |

第二行 RSS 更低（8.72 GB）但不可用 —— 代价是打坏所有其他模型。两者 RSS 的差异来自 `compute_dtype` 处理路径不同，未进一步拆解。

### 画质

`CheckpointLoaderKJ` FP8 输出 vs BF16 输出，seed 42 与 43 两组：

```
KJ-fp8 vs BF16 (seed42): RMSE=0.000  max_diff=0
KJ-fp8 vs BF16 (seed43): RMSE=0.000  max_diff=0
```

bit-identical。对照组：bf16-krea2 在全局 flag 下 RMSE `43.5`。

## 两个社区 shim 的实测对比

| 方案 | torch 2.10（ComfyUI 实际环境） | torch 2.13 | 机制 |
|---|---|---|---|
| [`fp4-fp8-for-torch-mps`](https://pypi.org/project/fp4-fp8-for-torch-mps/) | ✅ 生效 | ✅ 生效 | 注册 `aten::mm` 的 MPS dispatch kernel，走 `[torch.backends]` entry point 自动加载 |
| [`fp8-mps-metal`](https://github.com/tashiscool/fp8-mps-metal) | ❌ 无效 | ❌ 无效 | `install()` 不报错，但报错信息与 baseline 一字不差，未拦截 `.to(mps)` / `_scaled_mm` |

未打补丁时的 baseline 错误（印证 07-24 那份文档）：

- torch 2.10：`TypeError: Trying to convert Float8_e4m3fn to the MPS backend but it does not have support for that dtype.`
- torch 2.13：`RuntimeError: Undefined type Float8_e4m3fn`

### 裸算子微基准（仅供理解代价，非选型依据）

`fp4-fp8-for-torch-mps` 在 torch 2.10 上，bf16 为基线：

| 矩阵 | bf16 | FP8 常驻 + 每层 cast | `_scaled_mm`（真 FP8 计算） |
|---|---|---|---|
| M=1, K=N=4096 | 0.177ms | 1.43ms | 2.57ms |
| M=256, K=N=4096 | 0.813ms | 1.70ms | 18.06ms |
| M=1024, K=N=3584 | 1.842ms | 2.64ms | 56.64ms |

`_scaled_mm` 随矩阵增大急剧劣化（14× → 22× → 31×），图像生成全是大矩阵，**这条路不可用**。实际采用的是中间列（FP8 常驻 + 每层临时 cast），而它在端到端出图上的开销被摊薄到只剩 +5.5%。

单算子 RMSE 在 FP8 路径上比 bf16 差 9–12 倍，但端到端 4-step 采样后是 bit-identical —— **不要用微基准的 RMSE 推断成图质量**。

## sd.cpp 能不能跑 FP8

能读，但不省内存。用本机 `sd-cli`（commit `b290693`）直接加载 26 GB FP8 AIO：

```
[INFO] loading diffusion model from 'Qwen-Rapid-AIO-NSFW-v19.safetensors'
[INFO] Version: Qwen Image
[INFO] Weight type stat:  f32: 1 | f16: 2662 | bf16: 194
[DEBUG] qwen_image: num_layers = 60, zero_cond_t = true
```

- 全程无 e4m3/unsupported 报错，能正确识别为 Qwen Image 并自动认出 `zero_cond_t = true`（2511 edit 语义）
- 但 **2662 个 `F8_E4M3` 张量被读成 `f16`** —— 与本机文件头记录的 2,662 个 FP8 张量数字完全吻合。GGML 没有 FP8 type，加载时提升为 f16，内存回到 ~50 GB
- `model metadata validation failed` 是因为只给了 `--diffusion-model`，没给 `--llm` / `--vae`，符合 [`QWEN_RAPID_AIO_DRAWTHINGS_SDCPP_COMPATIBILITY_2026-07-24.md`](./QWEN_RAPID_AIO_DRAWTHINGS_SDCPP_COMPATIBILITY_2026-07-24.md) 的预期

**sd.cpp 的价值在 `--type q8_0`（GGML 在 Metal 上有原生 8-bit kernel），不在 FP8。** 这也是 GGUF 路线成立而 FP8 shim 一度不成立的根本区别：PyTorch MPS 缺的是 Float8 dtype 和 `_int_mm` dispatch，GGML 自己写了 Metal kernel 绕开了它。既然 ComfyUI 路线已经跑通且 bit-identical，GGUF 迁移不再必要。

## 已落地的改动

1. `fp4-fp8-for-torch-mps==1.0.3` 装入 `/Users/kk/ComfyUI-Installs/idream (1)/ComfyUI/.venv`
2. 三个 descriptor 的 loader 节点改为 `CheckpointLoaderKJ` + `weight_dtype: fp8_e4m3fn`，`ckpt_name` 指向 26 GB FP8 原版：
   - `qwen-image-edit-img2img.json`
   - `qwen-image-edit-multi-reference.json`
   - `qwen-image-edit-multi-identity.json`
3. 删除 `Qwen-Rapid-AIO-NSFW-v19-bf16.safetensors`（53 GB）
4. 重启 ComfyUI 后端（装包后必须重启，旧进程不会加载新装的 entry point）

**未改动**：Comfy Desktop 的 `launchArgs`、`settings.json`、`installations.json` 全部保持原样。

## `dequant_fp8_to_bf16.py` 必须保留

它不只服务 Qwen。`seed.ts:257` 的 redcraft krea2 profile 用它做 `scaled_fp8_e4m3 → bf16` 转换，两个活跃 workflow 依赖其产物：

- `redcraft-krea2-txt2img.json` → `redcraftKREA2RedMix_krea2Edition-bf16.safetensors`
- `redcraft-krea2-redmix3-txt2img.json` → `redcraftKREA2RedMix3.0-bf16.safetensors`

而且 redcraft **不能**照搬 Qwen 的方案：它的源权重是 scaled FP8（带 `weight_scale` sidecar），不是 plain FP8；实测强制走 fp8 会产出完全不同的图。krea2 线保持 bf16 是正确的。

## 踩过的坑

1. **`NO_PROXY` 被写成 URL**（`http://127.0.0.1:7897`）而不是主机列表，导致 Python `urllib` 把发往本机 8188 的 POST 也丢给代理，返回 502 空响应体。任何新写的本机 ComfyUI 客户端都要显式 `ProxyHandler({})`。
2. **ComfyUI 对相同 seed 返回缓存结果并计入耗时**。固定 seed 重复提交会得到 `0.03–4.02s` 的「生成耗时」，那是 KSampler 缓存命中。测速必须每次换 seed。
3. **装包后必须重启 ComfyUI 进程**。entry point 只在 `import torch` 时读取，已运行的进程不会感知新装的包 —— 这是第一次在 8188 上验证失败的原因。
4. **`supports_cast()` 对 MPS 是硬编码短路**（`comfy/model_management.py:1275`），在检查 float8 之前就 `return False`，没有开关。但 `unet_dtype()` 里的 `--fp8_e4m3fn-unet` 排在所有判断之前，能绕过它 —— 这是全局 flag 有效的原因，也是它危险的原因。
5. **断链会伪装成「模型齐全」**。`redcraft-krea2-comfyui-text.json` 报 `qwen3vl_4b_fp8_scaled.safetensors` not found，而 `ls` 明明能看到该文件 —— 它是个指向已被删除的 `~/.localai` 的符号链接。ComfyUI 扫目录时把断链**照样列进 CLIPLoader 下拉**，所以从 UI 和 `/object_info` 看模型都在，一跑才炸。同批共 3 个断链（另两个是 `Qwen3VL-4B-Instruct-Q4_K_M.gguf`、`darkBeastKrea2_dbkleinv2BFS.safetensors`）。已全部清除，该 workflow 改用真实存在的 `qwen3vl_4b_bf16.safetensors` 后 15.02s 跑通。

## plain FP8 与 scaled FP8 的行为完全不同

shim 装好后，krea2 系的 **scaled FP8 也能直接在 MPS 上跑**，`weight_dtype` 保持 `default` 让 ComfyUI 读 `comfy_quant` 元数据自行处理：

| 文件 | 结构 | 结果 |
|---|---|---|
| `Krea2RedMix3.0-fp8-scaled-ComfyUI.safetensors`（12.24 GiB） | 256×F8_E4M3 + 256×F32 `weight_scale` + 256×U8 `comfy_quant` + 174×BF16 | success，140.13s |
| `redcraftKREA2RedMix_krea2Edition.safetensors`（12 GB） | 同上结构 | success，125.24s |

**但它与 bf16 转换产物并不等价。** 同 seed（8675309）同 prompt 对比 `redcraftKREA2RedMix_krea2Edition` 的 FP8 原版与其 24 GB bf16 产物：

```
RMSE=25.52  max_diff=200  bbox=整图
```

对照 Qwen 的 `RMSE=0.000`。差异根源是两种 FP8 的性质不同：

- **plain FP8**（Qwen Rapid-AIO）：bf16 只是 widening 容器，无 scale、无信息增益，运行时 cast 回去数值完全一致 → **bit-identical**
- **scaled FP8**（krea2 系）：数值要乘回 `weight_scale` 才还原。ComfyUI 运行时的处理路径与 `dequant_fp8_to_bf16.py` 的离线实现不同，结果必然分叉

目视检查两张输出：同一个人、同样姿势构图场景，差别在蕾丝纹理精细度和一处纹身 —— **同构变体，质量相当，不存在谁降质**。

**官方最新版就是 scaled-FP8。** 查 `civitai.red` 确认 model `958009` 的最新版本是 `vid=3139241`「赤佬 3.0 (Krea2)」（2026-07-17），本地 `Krea2RedMix3.0-fp8-scaled-ComfyUI.safetensors` 正是它的 `fileId=3019490`，SHA-256 与 `seed.ts` 记录逐字符匹配。该版本另两个变体在 Mac 上都不可用（`int8` 卡 `_int_mm` 无 MPS dispatch、`nf4` ComfyUI MPS 支持不成立），**fp8 是这台机器上唯一正确的选择，且不需要任何转换**。

因此生产文生图整条线收敛到它 —— 见下一节。

## 生产文生图主力切换：krea2Edition-bf16 → RedMix3 FP8

这是产品决定，不是技术清理。切换前 `profile_image_default_v1` 与 `profile_image_premium_v1`（都是 enabled / rollout 100% / active）用的是 `redcraft-krea2-txt2img` + `redcraftKREA2RedMix_krea2Edition-bf16.safetensors`。**注意这条是文生图主力；Qwen 那套服务的是图生图/编辑，两者互不相干。**

已落地：

| 项 | 变更 |
|---|---|
| 主力 profile ×2 | `pipelineModel` → `redcraft-krea2-redmix3-fp8`，`workflowKey` → `redcraft-krea2-redmix3-txt2img`，模型路径 → `REDMIX3_FP8_MODEL_PATH` |
| 退役 profile | 删除 `profile_comfyui_redcraft_krea2_checkpoint_v1` 整块（211 行） |
| 删除 descriptor | `redcraft-krea2-txt2img`、`redcraft-krea2-comfyui-text`、`redcraft-krea2-drawthings{,-q8p,-i8x}-txt2img` 共 5 个 |
| 删除权重 | `redcraftKREA2RedMix_krea2Edition-bf16.safetensors`（24 GB）及其 ComfyUI 侧符号链接；Downloads 原始文件保留 |
| 删除常量 | `seed.ts` 中 6 个 `REDCRAFT_*_PATH` |
| 迁移引用 | 24 个文件、83 处（`redcraft-krea2-comfyui` → `-redmix3-fp8`，`redcraft-krea2-txt2img` → `-redmix3-txt2img`），跨 admin/gen/main/shared 四包 |

**已知后果：所有文生图输出会变。** redcraft 线有 `seedMode=locked` 的一致性依赖（`CharacterVisualProfile.defaultSeed`），已有角色重新生成会得到不同的脸。这在切换前已明确并确认。

替换时的两个陷阱：`redcraft-krea2-comfyui-text` 是 `redcraft-krea2-comfyui` 的子串，必须用负向先行断言 `(?!-text)` 才不会误伤；`profile_comfyui_redcraft_krea2_checkpoint_v1` 不能参与机械替换（否则会和主力 profile 撞同一个 workflow），只能整块删除。

`dequant_fp8_to_bf16.py` 现在**没有任何活跃使用者**了（它唯一的产物已删除），但暂时保留 —— 它仍是把 scaled-fp8 离线转 bf16 的唯一工具，且未来若要复现「bf16 与 fp8 输出差异」还需要它。

## preflight：把上面两类故障变成可检测的

上面两个坑（断链、shim 丢失）的共同点是**在生成之前完全无症状**。新增 `packages/gen/src/preflight.ts`（`bun run preflight`）做只读体检，退出码 0/1：

```bash
cd packages/gen
COMFYUI_VENV_PYTHON="/Users/kk/ComfyUI-Installs/idream (1)/ComfyUI/.venv/bin/python3" bun run preflight
```

它做三件事：

1. 遍历所有 `backendKind: comfyui` 的 descriptor，把 `ckpt_name` / `unet_name` / `clip_name` / `vae_name` 逐个对照 runner 的 `/object_info` —— 以**运行时视角**判断文件是否可见，而不是看本地磁盘。
2. 若有 descriptor 使用 `fp8_*` dtype，检查 `CheckpointLoaderKJ` 是否存在。
3. 给了 `COMFYUI_VENV_PYTHON` 时，直接在 runner 解释器里 `import fp4_fp8_for_torch_mps` 做硬校验；没给则只打印提醒（ComfyUI 不暴露包列表，没有别的探测面）。

双向验证过：真实 runner venv 不误报；换成没装 shim 的解释器会准确报出 `cannot import fp4_fp8_for_torch_mps`。

**它上线第一次运行就抓到一个既有问题**：

```
FAIL  redcraft-krea2-redmix3-txt2img.json: node 1 unet_name="redcraftKREA2RedMix3.0-bf16.safetensors" not visible to the runner
```

该 bf16 产物从未被转换出来。修复方式不是去生成那 24 GB，而是让 descriptor 直接加载官方 FP8 release（见上一节）。修复后：

```
preflight: 12 descriptors, 15 model refs checked, 0 problem(s)
```

建议把 `bun run preflight` 挂进 ComfyUI 升级后的检查流程：升级常会重建 venv，从而静默丢掉 shim。

## 风险与后续

- **`fp4-fp8-for-torch-mps` 是 1.0.3 的年轻第三方包**，它 override PyTorch 的 MPS dispatch，容易被 ComfyUI 或 torch 升级打断。preflight 能检出丢失，但检不出「装着但行为变了」—— 升级后仍应跑一次真实出图。
- **`CheckpointLoaderKJ` 引入了对 `comfyui-kjnodes` 的硬依赖**。该节点已装且是主流扩展，但它若缺失，三个 Qwen workflow 会直接失败（preflight 会报）。
- **验证覆盖面**：三个 workflow 都在生产实例上真实出图（见下表），但每条只跑了 1–4 次、单一素材组合。identity/source 的**语义正确性不在本次范围内** —— 那是 [`QWEN_V19_VS_KLEIN_9B_CONTROLLED_AB_2026-07-27.md`](./QWEN_V19_VS_KLEIN_9B_CONTROLLED_AB_2026-07-27.md) 的未决问题，与 FP8 切换无关。
- 53 GB 文件已删，若需回滚可用 `dequant_fp8_to_bf16.py` 从 26 GB FP8 重新生成，耗时数十分钟。
