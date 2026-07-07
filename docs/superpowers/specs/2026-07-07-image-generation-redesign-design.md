# 生图系统第一性原理重构 —— 设计方案

更新日期：2026-07-07
状态：设计草案 / 待用户评审（尚未实现）
适用范围：生图底座抽象（ComfyUI + sdcpp）、运营配置台（底座/模版/角色/预生图）、角色一致性、聊天 Agent 生图能力。

> 本文是 SSoT 草案。它**吸收并收敛**已有的三份文档，不推翻其中的好思想：
> - `docs/product/GENERATION_ADMIN_OPERATIONS_REDESIGN.md`（运营对象模型 Profile/Recipe/Batch/Asset/Placement/Metric，很好，保留）
> - `docs/product/CHARACTER_CONSISTENT_IMAGE_GENERATION_PRD.md`（CharacterVisualProfile 一致性，保留但修正若干 smell）
> - `docs/product/CHARACTER_IMAGE_GENERATION_FLOW_BLUEPRINT.md`（用户体验/文案，保留）

---

## 0. 一句话结论

**"生图模版"在第一性原理上 = 一张带类型化输入槽（typed input slots）的 workflow 图，绑定到一个后端（backend）。** 运营选一张图、填槽位；工程维护图；聊天 Agent、角色预生图、用户生图都复用同一套 `Backend → Workflow → Profile` 契约。围绕这一句话，同时治好三个根因问题。

---

## 1. 现状诊断（三个根因问题）

代码远比"从零"要成熟，问题是**抽象拧巴 + 对象只建了一半 + Agent 是雏形**。

### 问题 1：生图底座抽象拧巴 —— 用 OpenAI 图片 API 去套 ComfyUI（最深的债）

现状链路：
```
gen worker (IMAGE_PROVIDER=pipeline) → OpenAI 兼容 HTTP 网关 → 真实 runner
                                        ├─ sdcpp-openai-image-server.ts  :8091 → sd-cli
                                        └─ comfyui-openai-image-server.ts :8092 → ComfyUI :8191
```
`/images/generations` 只能表达 `prompt/width/height/steps/seed`，网关把这些**注入到 workflow 里固定的 node id**。代价：

- ComfyUI 的价值就是**任意节点图**。塞进扁平 OpenAI 请求 = 把它阉割成只会 text2img 的黑盒。**Qwen-Image-Edit（编辑模型，必须吃参考图+编辑指令）、角色一致性（IPAdapter/reference 节点、LoRA 栈、denoise 控制）根本无法表达。**
- 两个 bespoke HTTP server 各自重实现 OpenAI 路由/鉴权/健康检查 = 重复面。
- **实测证据**：RedCraft Krea2 在 sdcpp/Apple Silicon 上全白图（fp8/Metal VAE 问题），确认它是 ComfyUI FP8 checkpoint；在 ComfyUI split-node workflow 下跑通、20 样本 17/20（0.85）达标，却因"等一个 hosted gateway"被永久 `draft+disabled`。**那个 gateway 就是本机 ComfyUI Desktop。**

### 问题 2：运营配置对象只建了一半

redesign 文档的 Profile/Recipe/Batch/Asset/Placement/Metric 词汇，代码里：
- Recipe 塌缩进 `GenerationPromptTemplate`（不是一等对象）。
- `GenerationModelProfile` 把 runner 参数、LoRA JSON、文件路径、安全字段混在一页 → 运营得像工程师。
- `CharacterVisualProfile` 有 schema 无 admin UI。
- per-character 预生图没有专属入口（只能去 Production Studio 手填 purpose+target）。
- Metric 回路完全没有；Batch 成本是 `0` stub。

### 问题 3：聊天 Agent 生图是雏形

单个硬编码工具 `generate_image_async` + 正则关键字门 + "文本 XOR 图片"（出图就不能同时说话）+ Agent 看不见自己生成的图。加一个能力要手改 `agent-tools.ts` + `generate.ts` 两个文件。无工具注册表、无按角色/档位配置。

---

## 2. 第一性原理对象模型（统一契约）

从"团队要稳定生产并运营图片"倒推，定义一条自顶向下、层层复用的契约链。**每一层职责单一、边界清晰、可独立测试。**

```
Backend(底座)  ──has──▶  Workflow(生图模版)  ──referenced by──▶  Profile(可发布能力)
   runner实例                 图+输入槽+能力位                  默认槽值+灰度+权益+定价
                                                                     ▲
                                     Recipe(prompt+neg+preset包) ────┘  (可选，复用文案)
                                                                     ▲
        Character ──has active──▶ VisualPassport(身份护照) ──feeds──┘  (角色一致性槽值)
                                                                     ▲
        Batch(运营生产任务) / ChatAgentTool(聊天能力) ──都调用──────┘
                                     │
                                     ▼
                              Asset ──placed──▶ Placement       Metric(表现回路)
```

### 2.1 各对象定义

| 对象 | 是什么 | 谁维护 | 新建/改造 |
|------|--------|--------|-----------|
| **Backend 底座** | 一个 runner 实例 + 健康。类型 `comfyui`（直连本机 Desktop `/prompt`）/ `sdcpp`（sd-cli 快速通道）/ `external`（远端 OpenAI 兼容，可选）。配置：endpoint 或 binary 路径、model root、并发、健康探针。 | 工程 seed | **新建一等对象**（现在藏在 env 里） |
| **Workflow 生图模版** | 版本化的**图 + 声明式输入槽 + 能力位**，绑定一个 Backend。ComfyUI：graph JSON + `slot→{nodeId,field}` 映射表；sdcpp：sd-cli 参数模版。**两个目标模型就活在这里。** | 工程 seed（运营只读/选用） | **新建**（现在是硬编码 node id + env） |
| **Profile 可发布能力** | Workflow + 默认槽值 + 灰度 + 权益门 + 定价 + capabilities。运营发布/回滚的单位。 | 运营发布 | 改造 `GenerationModelProfile`：**改为引用 Workflow，不再内嵌 runner 参数** |
| **Recipe** | prompt + negative + preset 的可复用命名组合，引用 Profile/Workflow。 | 运营 | 从 `GenerationPromptTemplate` 提升语义（对象可沿用，补 metric） |
| **Preset** | 背景/姿势/服装等槽位预设。 | 运营 | 沿用 `GenerationPreset` |
| **VisualPassport 身份护照** | = `CharacterVisualProfile`。角色身份 SoT。**修正：结构化 traits 是唯一真源，`identityPrompt` 降级为带 hash 的派生缓存。** anchors/references/seed/adapterRefs（LoRA/IPAdapter）。 | 运营/用户创建向导 | 沿用 schema + **新建 admin 编辑 UI**；修正真源关系 |
| **Batch 生产任务** | 一次运营批量出图（角色封面/Feed/首页/SEO/活动）。 | 运营 | 沿用 `ContentProductionBatch` + **新建 per-character 面板** |
| **Asset / Placement** | 可复用素材 + 投放位。 | 运营 | 沿用 |
| **Metric 表现** | profile/recipe/workflow/placement 的点击/转化/Remix/失败成本 rollup。 | 系统 | **新建** |
| **ChatAgentTool** | 聊天能力注册表项：`{name, description, intentHints, argsSchema, profileRef, enabledFor}`，映射到一个 Profile。 | 工程注册 + 运营开关 | **新建注册表**（现在单硬编码工具） |

### 2.2 关键设计裁决（修正已有文档的 smell）

1. **traits = 真源，identityPrompt = 派生缓存**：护照存结构化 traits；`identityPrompt` 由版本化 assembler 生成并存 `assembledPromptHash`，避免两者漂移。
2. **护照身份版本（不可变）与参考池（可变）分离**：`referenceAssetIds` 池可增删而不铸新版本；只有影响身份的改动才铸新 `active` 版本 → 抑制版本爆炸。
3. **一致性模式（Strict/Balanced/Creative）必须机械化**：workflow-native + Qwen-Edit/IPAdapter 后，三档真正映射到 reference weight / denoise / seed 锁定，而非文本 XOR 之下三档趋同（现状假承诺）。
4. **prompt 分层收敛为一套**：文档里 5/7/8 层不一致 → 定为 **5 层**：Identity / Scene / Style / Continuity / Quality。用户输入只填 Scene。
5. **用户面统一术语**："身份护照 / Identity Lock"，代码内部叫 `CharacterVisualProfile`；用户 UI 禁止出现 IPAdapter/LoRA/CFG/VAE。

---

## 3. 底座架构（workflow-native，去 shim）

### 3.1 统一 GenBackend 接口（`packages/gen`）

```ts
// SPEC: 所有生图后端的统一契约。gen worker 只认这个接口，不再认 OpenAI HTTP shim。
// INTENT: 把"如何生成"下沉到 Workflow 的槽位绑定，backend 只负责执行+取回。
// INVARIANTS: backend 不碰 DB、不结算；只产出 bytes/handle。
interface GenBackend {
  readonly id: string
  readonly kind: "comfyui" | "sdcpp" | "external"
  capabilities(): Capabilities            // textToImage/img2img/referenceImages/stableSeed/lora/edit
  submit(job: ResolvedGenJob): Promise<BackendHandle>
  poll(handle: BackendHandle): Promise<BackendResult>   // { status, assets[] }
  health(): Promise<BackendHealth>
}
```

`ResolvedGenJob` = 一个 Workflow + 一组已解析槽值（prompt/neg/w/h/seed/refImages/denoise/lora…）+ 请求元数据。

### 3.2 两个后端实现

- **ComfyUIBackend**：加载 Workflow 的 graph JSON，按 Workflow **声明的 `slot→{nodeId,field}` 映射**把槽值写进节点输入（**不再硬编码 node id**）→ `POST /prompt` → 轮询 `/history/{id}` → `GET /view` 取图。直连本机 ComfyUI Desktop 的 API URL（见 §4）。
- **SdcppBackend**：按 Workflow 的参数模版把槽值绑成 sd-cli 参数 → spawn → 读 PNG。保留为**简单 text2img 快速通道**（Z-Image/Pornmaster turbo，8 步、cfg=1，秒级）。

**删除** `sdcpp-openai-image-server.ts` / `comfyui-openai-image-server.ts` 两个 OpenAI 兼容 server。gen worker 直调 backend。`IMAGE_PROVIDER=pipeline→external` 仅保留给"接远端 OpenAI 兼容 API"这一真实用途。

### 3.3 Workflow 描述符（"生图模版"的落地形态）

```jsonc
{
  "workflowKey": "redcraft-krea2-txt2img",
  "backendKind": "comfyui",
  "version": 3,
  "capabilities": ["textToImage", "stableSeed"],
  "graphPath": "workflows/redcraft-krea2-comfyui-text.json",
  "inputs": [                              // 声明式输入槽 —— 运营看到的就是这些
    { "key": "prompt",   "type": "text",  "target": { "nodeId": "6",  "field": "text" } },
    { "key": "negative", "type": "text",  "target": { "nodeId": "7",  "field": "text" } },
    { "key": "width",    "type": "int",   "target": { "nodeId": "5",  "field": "width" },  "default": 832 },
    { "key": "height",   "type": "int",   "target": { "nodeId": "5",  "field": "height" }, "default": 1216 },
    { "key": "seed",     "type": "int",   "target": { "nodeId": "3",  "field": "seed" } },
    { "key": "steps",    "type": "int",   "target": { "nodeId": "3",  "field": "steps" }, "default": 25 }
  ]
}
```
这一个结构同时解决：ComfyUI 黑盒问题（图是可见的、槽是声明的）+ 运营配置问题（运营填槽而非读底层字段）。sdcpp 的 `target` 换成 `{ "argFlag": "--steps" }`。

---

## 4. 两个目标模型端到端跑通（本机 ComfyUI Desktop）

**本机现状**：ComfyUI Desktop 已装，活动实例 `~/ComfyUI-Installs/idream (1)/ComfyUI`（v0.27.0+20，mac-mps，`--enable-manager`），模型共享目录 `~/ComfyUI-Shared/models/`。

### 4.1 RedCraft OR2 INT8（NSFW，已下载）—— ✅ 依赖全齐，零下载（2026-07-07 探测确认）
- workflow 引用的 3 个模型全部在盘：`diffusion_models/redcraftKREA2RedMix_krea2Edition.safetensors`、`text_encoders/qwen3vl_4b_fp8_scaled.safetensors`、`vae/qwen_image_vae.safetensors`。
- Backend=`comfyui`，Workflow=`redcraft-krea2-txt2img`（`packages/gen/workflows/redcraft-krea2-comfyui-text.json` 已存在、已 17/20 达标）。
- **动作**：启动本机 Desktop 的 ComfyUI server → 捕获 API URL 写入 Backend 配置 → **把 Profile 从 `draft/disabled` 解禁为 `active`**（无需补依赖）。
- 再补一张 `redcraft-krea2-ref`（IPAdapter/reference 变体）供角色一致性用。

### 4.2 Qwen-Image-Edit-Rapid-AIO（尚未下载）
- AIO = all-in-one 单文件，从 HuggingFace `Phr00t/Qwen-Image-Edit-Rapid-AIO` 下载到 `~/ComfyUI-Shared/models/checkpoints/`（或 diffusion_models，按 AIO 打包方式）。
- Backend=`comfyui`，Workflow=`qwen-image-edit-img2img`（以 Desktop 自带 blueprint `Image Edit (Qwen 2511).json` 为起点改造，声明 `source_image` + `edit_prompt` 槽）。
- **它是角色一致性 / "More like this" / 聊天"再来一张"的核心编辑通道**（吃参考图做身份保持）。

### 4.2b ⚠️ P0 spike 关键发现：fp8 × Apple Silicon(MPS) 硬冲突（2026-07-07 实测）

在本机 ComfyUI 8188 提交 RedCraft Krea2 workflow，KSampler 节点直接抛：
```
TypeError: Trying to convert Float8_e4m3fn to the MPS backend but it does not have support for that dtype.
  comfy/ldm/krea2/model.py → comfy_kitchen/tensor/fp8.py::dequantize
```
- **根因**：模型是 fp8（Float8_e4m3fn）权重，**MPS 不支持 fp8 dtype**。文档里那次 17/20 达标跑在 **CPU split-node workflow**；默认 MPS 设备必炸。这与 sdcpp 当初"白图"同源。
- **波及面**：Qwen-Image-Edit-**Rapid-AIO** 的 "Rapid AIO" 通常也是 fp8/int8，**同一堵墙**。即"这台 Mac 上跑这两个 fp8 模型"是系统性约束，非个案。
- **设计含义（正反馈到 §2/§3）**：Backend 必须携带 `device(mps|cpu|cuda)` + dtype 能力；Workflow 声明 dtype 需求；不兼容组合由 Backend **health 拦截**（正是现在发生的）。同一"逻辑模型"可有 fp8-cuda / fp16-mps 两个 Workflow 变体。

**社区实证解法（2026-07-07 调研，见 §8 决策 5）**——共识：Mac 上 fp8 无硬件支持，官方建议 fp16/bf16 或 GGUF：

| 方案 | 做法 | MPS 全速 | 打核心补丁 | 额外依赖 | 代价 |
|------|------|:---:|:---:|------|------|
| **A. fp16/bf16（★推荐，ComfyUI 官方路线）** | 下现成 fp16 版，或一次性把 fp8 dequant 成 fp16 safetensors | ✅ | 否 | 无 | ~2x 文件（128GB 无所谓）|
| GGUF | city96 等的 GGUF（`city96/Qwen-Image-gguf`、`realrebelai/KREA-2_GGUFs`）+ ComfyUI-GGUF 节点 | ✅ | 否 | **Krea2 需 patched GGUF fork**（标准节点报 Unexpected architecture）| 小；本机省内存意义不大 |
| CPU 回退补丁 | patch `comfy/float.py`+`quant_ops.py`+`comfy_kitchen/.../quantization.py`，fp8 算子挪 CPU 再搬回（Discussion #13273）| 部分 | ✅ 每次升级重打 | patcher 脚本 | 保留原 fp8 小文件；与本 ComfyUI "minimal change" 原则冲突 |
| B. 全 `--cpu` | ComfyUI 加 `--cpu`（`MPS_FALLBACK` 对 comfy_kitchen 自定义算子不可靠）| ❌ | 否 | 无 | 慢（分钟级/张）；仅适合异步预生图 |
| C. Mac 用 bf16 友好模型 | 本地用已跑通的 bf16（pornmaster Z-Image），fp8 模型留 prod CUDA | ✅ | 否 | 无 | 不满足"本机跑这两个 fp8 模型" |

**推荐：A（fp16/bf16）**——官方路线、不打补丁、MPS 全速、prod 仍用原 fp8；优先查现成 fp16 版，无则写一次性 dequant 脚本。GGUF 备选。
参考：ComfyUI Discussion #13273（MPS fp8 workaround）、Issue #5533/#6995/#6859（同类报错）。

### 4.3 Phase 0 验证闭环（demo 驱动，先跑通再抽象）

**✅ 第一条通路已跑通（2026-07-07）**：临时 headless `--cpu` ComfyUI（8199）→ RedCraft Krea2 出图成功（54s/384×512/6步，真实人像）。证明 workflow 图正确、依赖齐全；唯一阻塞是 fp8×MPS。

**✅✅ 方案 A（fp16/bf16）端到端验证成功（2026-07-07）**：
- 摸清格式：RedMix 是 **comfy_kitchen scaled-fp8**——每个量化 linear 有 `.weight`(F8_E4M3) + `.weight_scale`(**标量** F32, per-tensor) + `.comfy_quant`(U8, 仅 `{"format":"float8_e4m3fn"}` 标签)。**正确 dequant = `weight.float() * weight_scale` → bf16，丢弃两个 sidecar**。（`torch.Tensor.dequantize()` 是陷阱：只给原始 fp8→f32，不乘 scale。）
- 转换器（standalone，可复用于文本编码器/Qwen-Edit）：读 safetensors → fp8 权重按上式 dequant 成 bf16、非 fp8 原样保留 → 存新 safetensors。RedMix diffusion：256 fp8→bf16 + 174 bf16 = 430 张，**24GB，31s**。文本编码器 `qwen3vl_4b_fp8_scaled` 同法转 → `qwen3vl_4b_bf16`（8.3GB，7s）。VAE `qwen_image_vae` 本就纯 BF16，MPS 安全，无需转。
- **MPS 全速复验**：bf16 workflow 提交你的 8188 → `ok:true`、832×1216、10 步、**MPS 原生出图**（含 24GB 冷加载共 ~145s，热态更快），肉眼确认高质量连贯人像、身份与 fp8 版一致 → **转换数学正确**。
- 产物落位 `~/ComfyUI-Shared/models/{diffusion_models/redcraftKREA2RedMix_krea2Edition-bf16.safetensors, text_encoders/qwen3vl_4b_bf16.safetensors}`；原 fp8 保留给 prod CUDA。
- 延迟提示：12B 模型 MPS 高分辨率非秒级 → 聊天交互走 sdcpp 快速通道/降分辨率，预生图 batch 用 ComfyUI（异步可接受）。转换器待 P1 收进 repo（`packages/gen/scripts/`）。

后续 demo 闭环：
```
demos/2026-07-comfyui-bringup/
  run.sh          # 起 ComfyUI + 对 redcraft/qwen-edit 两个 workflow 各提交一次
  expected.txt    # 两张非空非白、过 sanity 的图 + 一致性抽检
```
这一步**先于**§3 的抽象重构落地，用来 de-risk 最大技术未知。

---

## 5. 运营配置台（Admin）信息架构

沿用 redesign 文档的两大工作区，补齐缺失面（**粗体=新建**）。

```
Generation Ops
  ├─ Overview（健康总览）
  ├─ Backends 底座          ← 新建：ComfyUI/sdcpp 实例、URL/路径、健康、并发
  ├─ Workflows 生图模版      ← 新建：图注册表、输入槽、能力位、样例图、版本
  ├─ Profiles & Rollout     ← 改造：引用 Workflow + 默认槽值 + 灰度 + 定价
  ├─ Prompt Recipes         ← 沿用 + 补 Metric
  ├─ Jobs & Incidents       ← 沿用
  └─ Provider Health        ← 沿用（并入 Backends 健康）

Content Ops
  ├─ Production Studio       ← 沿用（Batch 出图）
  ├─ Asset Library          ← 沿用（含 igrep 复用检索）
  ├─ Placements             ← 沿用
  ├─ Official Characters    ← 沿用 + 内嵌↓
  │    └─ Visual Passport 编辑器   ← 新建：traits/anchors/refs/seed/版本/一致性分
  │    └─ 角色预生图面板            ← 新建：一键出封面/主图/Feed/chat 包 → Batch
  ├─ Templates / Tags / Review Queue ← 沿用
  └─ CMS / SEO              ← 沿用
```

新建对象的 admin API 走现有 segment dispatcher（`packages/main/src/server/modules/admin/service.ts`）：`generation/backends`、`generation/workflows`、`content/characters/{id}/visual-profile`、`content/characters/{id}/pregen`。

---

## 6. 聊天 Agent 生图能力

### 6.1 工具注册表（替换单硬编码工具）

```ts
// packages/chat/src/agent-tools.ts
interface AgentTool {
  name: string
  description: string
  intentHints: string[]            // 供 planner/意图门
  argsSchema: ZodSchema
  profileRef: string               // 映射到一个可发布 Profile
  enabledFor: { tiers: Tier[]; characterScope?: "all" | string[] }
}
const REGISTRY: AgentTool[] = [ generateSelfie, editLastImage /* Qwen-Edit */, /* 未来: voice, video */ ]
```

### 6.2 四项改造
1. **注册表 + 运营可配置**：admin 控制"哪些角色/档位开哪些工具"（= 你要的"配置 agent 生图能力"）。
2. **原生 function-calling 优先，JSON planner 兜底**：`ChatModel` 增加 `tools` 传参；模型支持则原生工具调用，否则回退现有 planner。正则门保留为**成本优化的预门**（省第二次 LLM 调用），但可被"强意图"覆盖。
3. **文本 + 图片同回合**：出图时先流式说话，再挂图（去掉 text XOR image）。
4. **Agent 结果感知**：图完成后把"已生成图（+简述）"回喂上下文，让角色能点评自己发的照片。
5. **护照注入前移**：聊天请求即注入角色 active VisualPassport 的身份槽，一致性不再只靠 planner 写好 prompt。

### 6.3 复用现有链路
chat→main→gen→finalizer→chat 的 outbox/inbox 事件链（`chat.image.requested/accepted/completed/failed`）**保持不变**，只是 payload 携带 `profileRef` + 护照槽值；新增工具 = 注册表加项，不动链路。

---

## 7. 分阶段落地（每阶段可独立验证）

| 阶段 | 内容 | 验证 |
|------|------|------|
| **P0 底座打通** | 本机 ComfyUI Desktop 起服务；RedCraft Krea2 解禁；下载并跑通 Qwen-Edit。demo 闭环。 | `demos/2026-07-comfyui-bringup/run.sh` 出两张达标图 |
| **P1 底座抽象** | `GenBackend` 接口 + ComfyUI/Sdcpp 两实现；删两个 OpenAI shim；Workflow 描述符 + 声明式槽绑定；gen worker 直调。 | 现有 image 生成 e2e 绿；`bun run check` |
| **P2 运营配置** | Admin 新增 Backends/Workflows 页；Profile 改引用 Workflow；Visual Passport 编辑器。 | Chrome 走查：运营选图填槽发布出图 |
| **P3 角色预生图 + Metric** | per-character 预生图面板 → Batch；Metric rollup；Batch 成本接 PricingRule。 | 一键为官方角色出封面/chat 包并投放 |
| **P4 聊天 Agent** | 工具注册表；原生 function-calling；文本+图同回合；护照注入；运营开关。 | 聊天内"发张自拍/换个场景"端到端 + 一致性 |

---

## 8. 待你确认的开放决策

1. **底座抽象方向**：**✅ 已采纳 workflow-native（去 shim）**（2026-07-07 用户确认）。
2. **sdcpp 去留**：**✅ 已定：保留为秒级 text2img 快速通道**（Z-Image/Pornmaster turbo，8 步 cfg=1），一致性/编辑全交给 ComfyUI（2026-07-07 用户确认）。
3. **聊天调用机制**：**✅ 已定：原生 function-calling 作为调用机制 + 机制无关工具注册表 + JSON planner 能力兜底**（2026-07-07）。
   - 澄清：function-calling / MCP / skill 不是同层三选一——FC=调用机制，MCP=跨进程工具来源/传输标准（最终仍靠 FC 调用），skill=过程性提示词打包（服务端模型前无 skill runtime）。
   - **不用 MCP**：热路径上多进程+发现+延迟、零收益，且不替代 FC。唯一回头场景 = 以后把"生图能力"作平台边界暴露给外部/第三方 agent 共享，那时用 MCP server 封装。
   - **不用 skill 机制**：其价值以"注册表工具 description/intentHints/few-shot + 角色 system prompt 指引"的提示词形态交付。
   - 原生 FC 额外收益：一次调用 in-band、结构上解锁"文本+图片同回合"。
   - **P0 需验证**：本机 oMLX uncensored 模型（Qwen3.6-35B-A3B）是否稳定支持 OpenAI `tools`；不稳则回退 planner。
4. **提交策略**：本文档尚未 commit（你不在时不擅自提交/改代码）。你点头后我再 commit 并进入 writing-plans 拆实现计划。
5. **fp8×MPS 落地**：**✅ 已定：方案 A —— fp16/bf16**（2026-07-07 用户确认）。本地运行时把 fp8 权重转 fp16 供 MPS 全速；prod CUDA 仍用原 fp8。优先现成 fp16 版，无则一次性 dequant 脚本（需按 scaled-fp8 语义处理 scale 张量）。

---

## 附：本机环境已确认事实（供实现期参照）

- ComfyUI Desktop 活动实例：`~/ComfyUI-Installs/idream (1)/ComfyUI`（standalone，mac-mps，v0.27.0+20，`--enable-manager`）；base_path 配在 `extra_models_config.yaml`。
- 模型共享目录：`~/ComfyUI-Shared/models/`；`diffusion_models/` 已有 `redcraftKREA2RedMix_krea2Edition.safetensors`、`darkBeastKrea2_*`、`pornmasterZImage_turbo*`。
- Desktop 自带 `blueprints/`（官方 workflow 模板）含 `Text to Image (Qwen-Image)`、`Image Edit (Qwen 2511)` 等，可作起点。
- sdcpp：`~/code/sd.cpp-webui`（PATH 无 `sd`，需确认 sd-cli 产物路径）。
- 现有 gen 契约：`ai.image.generate` / `app.ai.finalize` 队列、`imageGeneratePayloadSchema`、`ImageModel/VideoModel/ModerationProvider/BlobStore` provider 抽象，均在 `packages/shared/src/contracts` 与 `packages/gen/src/providers.ts`。
