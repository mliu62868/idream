# P2 — 运营配置台（Backends/Workflows 页 + 编辑通路入抽象 + Profile→Workflow + Visual Passport）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让运营在 admin 看到并使用生图底座：Backends 健康页、Workflows（生图模版）页、Profile 引用 Workflow 发布、角色 Visual Passport 编辑；同时把 Qwen-Edit 编辑通路（参考图输入）收进 GenBackend 抽象（P1 遗留 Task 6b）。

**Architecture:** workflow 描述符 schema+loader 从 `packages/gen` 上移到 `packages/shared`（node-only 子路径导出，先例 `./storage/local-blob`），main 与 gen 共读同一 `GEN_WORKFLOW_DIR`。gen 侧：registry 双键索引（modelId+workflowKey）、ComfyUIBackend 增加 `/upload/image` 参考图上传并绑定 image 型槽。main 侧：admin dispatcher 新增 `generation/backends`、`generation/workflows`、`content/characters/:id/visual-profiles` 三个资源族；`GenerationModelProfile` 加可空 `workflowKey` 列（SQL 交用户执行），入队处 `model: profile.workflowKey ?? profile.pipelineModel`。UI 走 AdminConsoleClient selfFetch 六触点 + `apiGet/apiWrite` 模式。

**Tech Stack:** TypeScript strict（no `any`），bun + turbo，vitest，Zod v4，Prisma 7（PG），Next 16 App Router，ComfyUI HTTP API（/prompt、/upload/image、/system_stats）。

## Global Constraints

- TypeScript strict、no `any`、named exports、2-space 缩进（AGENTS.md）。
- **数据库模式变更：只产出 SQL 文件交用户手工执行，任何任务不得对 dev/prod 库跑 DDL**（全局规则）。列为**可空、纯增量**，未应用前不得让运行路径崩溃（见 Task 7 顺序门）。
- gen 层不碰 DB/结算；`ImageModel` 结果封套与 `pipeline.ts` 保持不变（P1 既定）。
- Admin 写操作必须 `actorWithPermission(request, "generation.config.write")`（或相应键）+ `writeAudit(...)` 收尾；读用 `generation.config.read`（service.ts:1270 用例）。
- Admin 变更走 `{ ...fields, reason, confirmation }` 约定（TagsView.tsx:168-172 模式），`reason.trim().length >= 3`。
- 每个 backend HTTP/spawn 超时用 AbortController（P1 既定）。
- ComfyUI 大模型**串行换载**：不得在测试/冒烟里并发触发两个大 checkpoint 加载（P0 OOM 教训，spec §4.2b）。
- 用户 UI 禁止出现 IPAdapter/LoRA/CFG/VAE 等术语；admin 面向运营可展示 workflowKey/槽位等（spec §2.2）。
- shared 的浏览器安全 barrel（`src/index.ts`）不得引入 node:fs 模块——新模块只走子路径导出（先例 package.json `"./storage/local-blob"`）。

---

## File Structure

**Create:**
- `packages/shared/src/gen/workflow.ts` — 描述符 schema+绑定+loader（从 gen 平移）。
- `packages/shared/src/gen/workflow.test.ts` — 平移的单测。
- `packages/gen/workflows/qwen-image-edit-img2img.json` — Qwen-Edit 描述符（P0 已验证图）。
- `packages/main/src/components/admin/BackendsView.tsx`、`WorkflowsView.tsx`、`VisualPassportPanel.tsx`。
- `db/sql/2026-07-07-generation-model-profiles-workflow-key.sql` — 用户手工执行的 DDL。
- 测试：`packages/gen/src/backend/comfyui.test.ts`（扩）、`registry.test.ts`（扩）、`packages/main/src/server/modules/admin/generation-catalog.test.ts`、`characters/visual-profiles.test.ts`。

**Modify:**
- `packages/shared/package.json` — exports 增 `"./gen-workflow": "./src/gen/workflow.ts"`。
- `packages/gen/src/backend/workflow.ts` — 改为 `export * from "@idream/shared/gen-workflow"`（保住 gen 内部 import 路径不变）。
- `packages/gen/src/backend/registry.ts` — 双键索引。
- `packages/gen/src/backend/comfyui.ts` — 参考图上传 + image 槽绑定 + capabilities.referenceImages=true。
- `packages/main/src/server/modules/admin/service.ts` — dispatcher 三个新族（:454-503 generation 大括号内 + content 族内）。
- `packages/main/src/server/modules/admin/generation-catalog.ts`（新 handler 模块，避免再喂肥 4,889 行的 service.ts；service.ts 只加路由行）。
- `packages/main/src/server/modules/admin/characters/visual-profiles.ts`（新 handler 模块）。
- `packages/main/src/components/admin/AdminConsoleClient.tsx` — 六触点 ×2 新页。
- `packages/main/src/components/admin/OfficialCharactersView.tsx` — 挂 VisualPassportPanel。
- `packages/main/prisma/schema.prisma` — `GenerationModelProfile.workflowKey String?`。
- `packages/main/src/server/modules/ourdream/service.ts:1861`、`:2461` — model 覆盖。
- `packages/main/src/server/modules/admin/service.ts` profile create/patch handler（:1797/:1829）— 接受并校验 workflowKey。

---

## Task 1: workflow 模块上移 shared（main/gen 共读）

**Files:**
- Create: `packages/shared/src/gen/workflow.ts`、`packages/shared/src/gen/workflow.test.ts`
- Modify: `packages/shared/package.json`、`packages/gen/src/backend/workflow.ts`（变薄壳）、`packages/gen/src/backend/workflow.test.ts`（跟随 import 或保留经薄壳）

**Interfaces:**
- Consumes: 现 `packages/gen/src/backend/workflow.ts` 全部导出（`workflowDescriptorSchema`、`WorkflowDescriptor`、`SlotValues`、`ComfyNode`、`bindComfySlots`、`bindSdcppArgs`、`loadWorkflowDescriptors`）。
- Produces: `@idream/shared/gen-workflow` 子路径导出同名 API；`packages/gen/src/backend/workflow.ts` 仅 `export * from "@idream/shared/gen-workflow";`（gen 内部 `./workflow` import 全部无感）。

**注意**：shared 的 logger 依赖——gen 版 loader 用了 `../logger`（pino）。shared 无 pino。改为**注入式告警**：`loadWorkflowDescriptors(dir, opts?: { onSkip?: (file: string, err: string) => void })`，gen 薄壳不变（shared 版默认静默跳过，gen 调用点在 registry.ts 传 `onSkip: (f,e)=>logger.warn({file:f,err:e},"skipping invalid workflow descriptor")`）。

- [ ] **Step 1: 平移文件 + 改 loader 签名**（内容 = 现 workflow.ts 去掉 logger import，`loadWorkflowDescriptors` 加 `opts` 参数如上；其余逐字保留）。
- [ ] **Step 2: exports map 增子路径**

```json
"./gen-workflow": "./src/gen/workflow.ts",
```
（插入 `packages/shared/package.json` exports；**不动** `src/index.ts` barrel。）

- [ ] **Step 3: gen 薄壳化**

```ts
// packages/gen/src/backend/workflow.ts
// SPEC: 描述符 SSoT 已上移 @idream/shared/gen-workflow（main/gen 共读）。此文件仅保住 gen 内部 import 路径。
export * from "@idream/shared/gen-workflow";
```
registry.ts 的 `loadWorkflowDescriptors(opts.workflowDir)` 调用改为传 `{ onSkip: ... }`（用现 logger）。

- [ ] **Step 4: 测试平移** — 把 gen 的 workflow.test.ts 主体复制为 shared 的 `workflow.test.ts`（shared 有 vitest？检查 `packages/shared/package.json` scripts；若无 test 脚本则加 `"test": "vitest run"` + devDep 对齐 gen 的 vitest 版本）。gen 侧保留 Task 6 的 loader 加载测试（它验证真实 workflows 目录）。
- [ ] **Step 5: 全绿验证** — `cd packages/shared && bunx vitest run && bunx tsc --noEmit`；`cd ../gen && bunx vitest run && bunx tsc --noEmit`（薄壳后 76+ 全过）。
- [ ] **Step 6: Commit** — `git commit -m "refactor(shared): hoist gen workflow descriptor schema+loader to @idream/shared/gen-workflow"`

---

## Task 2: registry 双键索引（modelId + workflowKey）

**Files:**
- Modify: `packages/gen/src/backend/registry.ts`（:24-27 索引、:37-38 resolve）
- Test: `packages/gen/src/backend/registry.test.ts`（扩）

**Interfaces:**
- Produces: `resolveForModel(key: string)` 现在同时接受 `descriptor.modelId` 或 `descriptor.workflowKey`（两者都 unique；冲突时 modelId 优先并在构建期对重复键 throw）。这是 Task 7 中 `payload.model = profile.workflowKey` 能被 gen 解析的前提。

- [ ] **Step 1: 失败测试** — 现有 temp-dir fixture 上加断言：`resolveForModel("<workflowKey>")` 返回与 `resolveForModel("<modelId>")` 同一 descriptor；未知 key 仍 throw；两个描述符若 workflowKey 撞 modelId → `buildBackendRegistry` reject。
- [ ] **Step 2: 实现** — 构建 `byKey = new Map()`：先放全部 modelId，再放 workflowKey（若 `byKey.has(workflowKey)` 且指向不同 descriptor → `throw new Error(\`duplicate registry key: ${workflowKey}\`)`）。`resolveForModel` 查 `byKey`。
- [ ] **Step 3: 验证** — `bunx vitest run src/backend/registry.test.ts` PASS；全套 PASS。
- [ ] **Step 4: Commit** — `git commit -m "feat(gen): registry resolves by modelId or workflowKey (dual index)"`

---

## Task 3: ComfyUIBackend 参考图上传 + image 槽绑定（Task 6b-A）

**Files:**
- Modify: `packages/gen/src/backend/comfyui.ts`（submit :59-91、capabilities :53）
- Test: `packages/gen/src/backend/comfyui.test.ts`（扩）

**Interfaces:**
- Consumes: `ResolvedGenJob.referenceImages`（types.ts:18，目前在 comfyui.ts 被丢弃——backend-image-model.ts:144 已传入）。参考图元素形如 `{ assetId, role, b64Json?, url?, contentType?, ... }`（`imageGeneratePayloadSchema` referenceImages 元素，shared contracts）。
- Produces: `submit(job)` 流程变为：
  1. 收集描述符里 `type === "image"` 的槽（按 `inputs` 声明顺序）。
  2. 若有 image 槽且 `job.referenceImages` 非空：对第 i 个 image 槽取第 i 个参考图 → `uploadImage(bytes, name)` = `POST {apiUrl}/upload/image`（multipart form 字段 `image`，`overwrite=true`）→ 响应 `{ name, subfolder, type }` → 槽值 = `subfolder ? \`${subfolder}/${name}\` : name`。
  3. 无 default 的 image 槽缺参考图 → throw（复用 bindComfySlots 的 missing-slot 语义：把上传后的文件名并进 `slots` 再调 `bindComfySlots`，缺失自然报错）。
  4. bytes 来源：`b64Json` 直接 decode；仅 `url` 时 `fetch(url)`（AbortController + job.timeoutMs）。
  5. `capabilities().referenceImages` → `true`。

- [ ] **Step 1: 失败测试**（mock fetch 序列：upload → prompt → history → view）

```ts
it("uploads reference image and binds filename into image slot", async () => {
  const editDescriptor = workflowDescriptorSchema.parse({
    workflowKey: "edit-wf", modelId: "edit-m", backendKind: "comfyui", version: 1,
    capabilities: ["img2img", "edit", "referenceImages"],
    apiPrompt: {
      "8": { class_type: "LoadImage", inputs: { image: "" } },
      "3": { class_type: "TextEncodeQwenImageEditPlus", inputs: { prompt: "" } },
      "9": { class_type: "SaveImage", inputs: {} },
    },
    inputs: [
      { key: "edit_prompt", type: "text", target: { nodeId: "3", field: "prompt" } },
      { key: "source_image", type: "image", target: { nodeId: "8", field: "image" } },
    ],
  });
  const g = mockFetch([
    () => new Response(JSON.stringify({ name: "up.png", subfolder: "", type: "input" }), { status: 200 }), // upload
    () => new Response(JSON.stringify({ prompt_id: "p9" }), { status: 200 }),
  ]);
  vi.stubGlobal("fetch", g);
  const backend = new ComfyUIBackend({ apiUrl: "http://x" });
  await backend.submit({
    descriptor: editDescriptor,
    slots: { edit_prompt: "red dress" },
    referenceImages: [{ assetId: "a1", role: "source_image", b64Json: PNG_B64 }], // PNG_B64 = 既有 2x2 棋盘格 base64
    timeoutMs: 5000,
  });
  // upload 调用是 multipart
  const uploadCall = g.mock.calls[0];
  expect(String(uploadCall[0])).toContain("/upload/image");
  expect((uploadCall[1] as RequestInit).body).toBeInstanceOf(FormData);
  // prompt body 中 LoadImage 槽已绑定上传返回名
  const promptBody = JSON.parse((g.mock.calls[1][1] as RequestInit).body as string);
  expect(promptBody.prompt["8"].inputs.image).toBe("up.png");
});
it("throws when a required image slot has no reference image", async () => {
  /* 同 descriptor，referenceImages: [] → await expect(submit).rejects.toThrow(/source_image/) */
});
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**（`uploadImage` 私有方法：`new FormData()` + `new Blob([bytes], {type: contentType ?? "image/png"})`，字段名 `image`，附 `overwrite: "true"`；AbortController+timeout 与 poll 同模式）。
- [ ] **Step 4: 全套绿 + tsc 清**。
- [ ] **Step 5: Commit** — `git commit -m "feat(gen): ComfyUIBackend uploads reference images and binds image-type slots"`

---

## Task 4: qwen-image-edit 描述符 + 真实编辑冒烟（Task 6b-B）

**Files:**
- Create: `packages/gen/workflows/qwen-image-edit-img2img.json`
- Modify: `packages/gen/src/backend/smoke.ts`（加 `--model` 参数已有则复用；加 `--ref` 本地图片路径→b64 注入 referenceImages）
- Test: gen loader 测试断言新 modelId 出现

**描述符内容**（P0 实测图逐字落库；bf16 checkpoint、TextEncodeQwenImageEditPlus、4步/cfg1/sa_solver/beta）：

```jsonc
{
  "workflowKey": "qwen-image-edit-img2img",
  "modelId": "qwen-image-edit",
  "backendKind": "comfyui",
  "version": 1,
  "capabilities": ["img2img", "edit", "referenceImages", "stableSeed", "textToImage"],
  "apiPrompt": {
    "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "Qwen-Rapid-AIO-NSFW-v19-bf16.safetensors" } },
    "8": { "class_type": "LoadImage", "inputs": { "image": "" } },
    "3": { "class_type": "TextEncodeQwenImageEditPlus", "inputs": { "clip": ["1", 1], "vae": ["1", 2], "image1": ["8", 0], "prompt": "" } },
    "4": { "class_type": "TextEncodeQwenImageEditPlus", "inputs": { "clip": ["1", 1], "prompt": "" } },
    "9": { "class_type": "EmptyLatentImage", "inputs": { "width": 832, "height": 1216, "batch_size": 1 } },
    "2": { "class_type": "KSampler", "inputs": { "model": ["1", 0], "positive": ["3", 0], "negative": ["4", 0], "latent_image": ["9", 0], "seed": 0, "steps": 4, "cfg": 1, "sampler_name": "sa_solver", "scheduler": "beta", "denoise": 1 } },
    "10": { "class_type": "VAEDecode", "inputs": { "samples": ["2", 0], "vae": ["1", 2] } },
    "11": { "class_type": "SaveImage", "inputs": { "images": ["10", 0], "filename_prefix": "idream_qwen_edit" } }
  },
  "inputs": [
    { "key": "prompt", "type": "text", "target": { "nodeId": "3", "field": "prompt" } },
    { "key": "source_image", "type": "image", "target": { "nodeId": "8", "field": "image" } },
    { "key": "width", "type": "int", "target": { "nodeId": "9", "field": "width" }, "default": 832 },
    { "key": "height", "type": "int", "target": { "nodeId": "9", "field": "height" }, "default": 1216 },
    { "key": "seed", "type": "int", "target": { "nodeId": "2", "field": "seed" } },
    { "key": "steps", "type": "int", "target": { "nodeId": "2", "field": "steps" }, "default": 4 }
  ]
}
```

- [ ] **Step 1: loader 测试加断言**（`modelId === "qwen-image-edit"` 存在）→ 失败。
- [ ] **Step 2: 落 JSON** → 测试过。
- [ ] **Step 3: smoke 扩展** — smoke.ts 支持 `--model qwen-image-edit --ref <png路径> --prompt "..."`：读文件→base64→`referenceImages: [{ assetId: "smoke-ref", role: "source_image", b64Json }]`。
- [ ] **Step 4: 真实冒烟**（8188 在跑；**串行**，勿与其他大模型任务并发）：
  `IMAGE_PROVIDER=backend COMFYUI_API_URL=http://127.0.0.1:8188 bunx tsx src/backend/smoke.ts --model qwen-image-edit --ref <P0人像png> --prompt "Change her outfit to an elegant red evening dress. Keep her face, hairstyle, hair color and identity exactly the same." --out /tmp/p2-edit-smoke.png`
  Expected: ok:true、~832×1216、sanity 过、肉眼身份保持（对照 P0 直连结果 72s 级别）。
- [ ] **Step 5: Commit** — `git commit -m "feat(gen): qwen-image-edit workflow descriptor + edit smoke through GenBackend"`

---

## Task 5: Admin API — generation/backends + generation/workflows

**Files:**
- Create: `packages/main/src/server/modules/admin/generation-catalog.ts` + `generation-catalog.test.ts`
- Modify: `packages/main/src/server/modules/admin/service.ts`（:454-503 generation 大括号内加两个路由块；顶部 import）
- Modify: `packages/main/src/server/env.ts` 或等价 env 读取点（若 main 无 `GEN_WORKFLOW_DIR`/`COMFYUI_API_URL`/`SDCPP_CLI` 读取，就地 `process.env.X ?? 默认` 于 generation-catalog.ts，默认与 gen/env.ts 一致：`packages/gen/workflows`、`http://127.0.0.1:8188`、`~/bin/sd-cli`）

**Interfaces:**
- Produces（响应经 `ok(...)` 封套）：
  - `GET generation/backends` → `{ items: [{ id: "comfyui", kind: "comfyui", endpoint, health: { ok, detail?, latencyMs? } }, { id: "sdcpp", kind: "sdcpp", cliPath, health: { ok, detail? } }] }`。comfyui 健康 = `fetch(\`${url}/system_stats\`)` AbortController 3s；sdcpp = `fs.access(cli, X_OK)`。
  - `GET generation/workflows` → `{ items: WorkflowDescriptor摘要[] }`（workflowKey/modelId/backendKind/version/capabilities/inputs 槽表；**不含** apiPrompt 大图）。
  - `GET generation/workflows/:workflowKey` → 完整描述符（含 apiPrompt，供工程排查）。
- 权限：全部 `generation.config.read`。
- 数据源：`loadWorkflowDescriptors(GEN_WORKFLOW_DIR)`（Task 1 的 shared 模块；进程内 60s TTL 缓存即可，文件是工程 seed 低频变更）。

**路由块（service.ts，mirror :465-475 形状）：**

```ts
if (id === "backends") {
  if (!action && method === "GET") return listGenerationBackends(request);
}
if (id === "workflows") {
  if (!action && method === "GET") return listGenerationWorkflows(request);
  if (action && !child && method === "GET") return getGenerationWorkflow(request, action);
}
```

- [ ] **Step 1: 失败测试** — 按 `modules/admin/*.test.ts` 既有模式（读一个近似测试如 `characters/tags.test.ts` 的装配方式照做）：workflows list 返回含 `redcraft-krea2-txt2img` 与 `qwen-image-edit-img2img`；detail 未知 key → 404；backends 列表两条且 comfyui health 字段存在（fetch mock 不可达 → `ok:false`）。权限缺失 → 403（复用既有权限测试写法）。
- [ ] **Step 2: 实现 handler 模块**（三个函数 + TTL 缓存 + env 读取；不写 service.ts 之外的全局状态）。
- [ ] **Step 3: service.ts 挂路由 + import**。
- [ ] **Step 4: `cd packages/main && bunx vitest run src/server/modules/admin/generation-catalog.test.ts` PASS；`bun run typecheck` 清。**
- [ ] **Step 5: Commit** — `git commit -m "feat(admin): generation/backends + generation/workflows read APIs"`

---

## Task 6: Admin UI — BackendsView + WorkflowsView

**Files:**
- Create: `packages/main/src/components/admin/BackendsView.tsx`、`WorkflowsView.tsx`
- Modify: `packages/main/src/components/admin/AdminConsoleClient.tsx` 六触点（锚点：navItems :618-648、normalizeSection :7081、fetchSection :1168 的 selfFetch 分支 :1266-1276、SectionData view union :216-231、renderSection :2240-2252、imports :45-53）

**Interfaces:**
- Consumes: Task 5 API（`apiGet` from `@/components/admin/api`）。
- 组件契约：零 props、`"use client"`、`useAdminI18n`、加载/错误态 —— 逐项 mirror `TagsView.tsx:36-60`。
- BackendsView：两卡片（kind、endpoint/cliPath、健康徽章 ok/fail + detail、latency）+ 手动刷新按钮。
- WorkflowsView：描述符表（workflowKey、modelId、backendKind、version、capabilities 徽章、槽位数）+ 行展开显示 `inputs` 槽表（key/type/target/default）。只读——运营"选图填槽"发生在 Profile 编辑（Task 7）。
- nav：`{ id: "generation/backends", label: "Backends", href: "/admin/generation/backends", icon: Server, group: "Generation Ops" }`、`{ id: "generation/workflows", label: "Workflows", href: "/admin/generation/workflows", icon: Workflow, group: "Generation Ops" }`（lucide `Workflow` 图标，import 顶部补）。

- [ ] **Step 1: 两个组件**（先写 WorkflowsView，槽表直接渲染 API 数据；无新状态管理）。
- [ ] **Step 2: 六触点注册 ×2**。
- [ ] **Step 3: 手动验证** — `bun run dev:admin`（或既有 admin dev 方式）→ Chrome 打开 `/admin/generation/backends`、`/admin/generation/workflows`：comfyui 显示 healthy（8188 在跑）、workflows 列出两个描述符。截图留档。
- [ ] **Step 4: `bun run check` 全绿。**
- [ ] **Step 5: Commit** — `git commit -m "feat(admin): Backends + Workflows ops pages"`

---

## Task 7: Profile → Workflow 引用（schema SQL 交用户 + 入队覆盖 + 编辑器字段）

**Files:**
- Modify: `packages/main/prisma/schema.prisma`（GenerationModelProfile 增 `workflowKey String?`，紧邻 `pipelineModel` :999 后）
- Create: `db/sql/2026-07-07-generation-model-profiles-workflow-key.sql`
- Modify: `packages/main/src/server/modules/ourdream/service.ts:1861`、`:2461`（`model: profile.workflowKey ?? profile.pipelineModel`）
- Modify: `packages/main/src/server/modules/admin/service.ts` `createModelProfile`(:1797)/`patchModelProfile`(:1829) — 接受 `workflowKey`，非空时校验存在于 `loadWorkflowDescriptors` 结果（复用 Task 5 缓存），不存在 → `Errors.badRequest("unknown workflowKey")`
- Modify: Profiles & Rollout 编辑器组件 — 定位方式：`AdminConsoleClient.tsx` `fetchSection("generation/config")` 分支所指向的 view；在 profile 表单加"Workflow"下拉（数据 `apiGet("generation/workflows")`，选项 label = `workflowKey (backendKind)`，可清空=沿用 pipelineModel）
- Test: 扩 `generation-catalog.test.ts` 或就近 profile handler 测试：patch 带未知 workflowKey → 400；带合法 → 落库

**SQL 文件内容（用户手工执行；Prisma 无 @map，列名即 camelCase 需引号）：**

```sql
-- 2026-07-07 P2: GenerationModelProfile 增加可空 workflowKey（引用 gen workflow 描述符）
-- 纯增量、可空；应用前旧代码可正常运行，应用后新代码方可读写该列。
ALTER TABLE "generation_model_profiles" ADD COLUMN IF NOT EXISTS "workflowKey" TEXT;
```

**⚠️ 顺序门（必须遵守）**：schema.prisma 修改 + `bunx prisma generate` 之后，**main 对真实 DB 的任何 prisma 查询会 select 新列** → 列未应用前运行 main 会炸。故本任务步骤顺序：先交 SQL → **等用户确认已执行** → 再改代码/跑集成验证。单测若走 mock/隔离测试库不受影响（按仓库既有测试基建判断，报告说明）。

- [ ] **Step 1: 写 SQL 文件 + schema.prisma 字段 + `bunx prisma generate`**（仅类型层）。
- [ ] **Step 2: ⏸ 通知控制器/用户执行 SQL，拿到确认再继续**（BLOCKED-on-user 语义）。
- [ ] **Step 3: 失败测试**（profile patch workflowKey 校验两分支）。
- [ ] **Step 4: 实现** — 两个 job-create 点覆盖 + create/patch 校验 + UI 下拉。
- [ ] **Step 5: 端到端验证** — admin 给 `redcraft` profile 设 `workflowKey: "redcraft-krea2-txt2img"` → 发一张用户侧生成（或既有 test-image 路径）→ gen 日志确认 registry 以 workflowKey 解析（Task 2 双键）→ 出图。
- [ ] **Step 6: `bun run check` 全绿；Commit** — `git commit -m "feat(main): GenerationModelProfile.workflowKey routes jobs to workflow descriptors"`

---

## Task 8: Visual Passport 编辑器（admin 族 + 面板 + 挂载）

**Files:**
- Create: `packages/main/src/server/modules/admin/characters/visual-profiles.ts` + `visual-profiles.test.ts`
- Create: `packages/main/src/components/admin/VisualPassportPanel.tsx`
- Modify: `packages/main/src/server/modules/admin/service.ts` — `content/characters/:id/visual-profiles` 路由（content 族内，mirror characters 子资源既有写法）
- Modify: `packages/main/src/components/admin/OfficialCharactersView.tsx` — 角色详情区渲染 `<VisualPassportPanel characterId={...} />`

**Interfaces:**
- Consumes: `createActiveCharacterVisualProfileVersion(tx, character, { createdFrom })`（ourdream/service.ts:1567，已导出）+ `characterVisualProfileCreateData`（同文件导出）+ `CharacterVisualProfile` 模型（schema :228-255）。
- Produces:
  - `GET content/characters/:id/visual-profiles` → `{ items: [{ id, version, status, identityPrompt, negativeIdentityPrompt, defaultSeed, anchorAssetIds, referenceAssetIds, qualityScore, consistencyScore, createdFrom, createdAt }] }`（按 version desc；权限 `generation.config.read` 若已有 content 侧读键则用之——mirror official.ts 现用键，报告注明选择）。
  - `POST content/characters/:id/visual-profiles` body `{ identityPrompt, negativeIdentityPrompt?, defaultSeed?, faceTraits?, hairTraits?, bodyTraits?, signatureTraits?, styleTraits?, reason, confirmation }` → 事务内：读 character（不存在→404）→ 归档现 active（updateMany，mirror :1583-1586）→ `tx.characterVisualProfile.create({ data: characterVisualProfileCreateData({ ...active 继承 anchors/refs, ...覆盖字段, version: (active?.version ?? 0)+1, status: "active", createdFrom: "admin_passport_edit" }) })` → `writeAudit`。**anchors/refs 池本期只读展示不编辑**（spec §2.2：池可变不铸版；池编辑属 P3 素材联动）。
- VisualPassportPanel 契约：`export function VisualPassportPanel({ characterId }: { characterId: string })`，`apiGet`/`apiWrite`、版本时间线（version/status/时间/createdFrom）、当前 active 的 traits 只读 JSON 视图 + identityPrompt/negative/seed 编辑表单（reason+confirmation 约定）。**面向运营的文案不出现 LoRA/CFG 等术语**。

- [ ] **Step 1: 失败测试**（list 按版本降序；post 铸新版并归档旧 active；未知 character → 404；缺 reason → 400）。
- [ ] **Step 2: handler 实现 + 路由挂载**。
- [ ] **Step 3: 面板组件 + OfficialCharactersView 挂载**（读该文件找角色详情/编辑区的自然插入点，作为独立卡片段落；若该视图为纯列表无详情区，则行内展开面板——实现者按实际结构择一并在报告说明）。
- [ ] **Step 4: 手动验证** — admin 打开官方角色 → Passport 面板显示版本、编辑 identityPrompt 铸 v(n+1) active。
- [ ] **Step 5: `bun run check` 全绿；Commit** — `git commit -m "feat(admin): Visual Passport editor (character visual profile versions)"`

---

## Task 9: 收口 — 全链验证 + 文档

**Files:**
- Modify: `docs/superpowers/specs/2026-07-07-image-generation-redesign-design.md`（§7 P2 行标 ✅ + 实测记录）
- Modify: `packages/gen/README.md`（编辑通路用法：`--ref` smoke、image 槽约定）

- [ ] **Step 1: 全仓 `bun run check`**（lint+typecheck+build）绿。
- [ ] **Step 2: Chrome 走查**（运营视角闭环）：Backends 健康 → Workflows 选图看槽 → Profile 绑 workflowKey 发布 → 出图 → 角色 Passport 编辑铸版。逐屏截图。
- [ ] **Step 3: 文档更新 + Commit** — `git commit -m "docs: P2 ops console verified (backends/workflows pages, profile→workflow, visual passport)"`

---

## Self-Review

**Spec coverage（对 spec §5/§7 P2 行 + P1 遗留）：**
- Task 6b 编辑通路入抽象 → Task 3+4 ✅（P1 最终审查明确的缺口：comfyui.ts 丢弃 referenceImages）
- Admin 新增 Backends/Workflows 页 → Task 5+6 ✅
- Profile 改引用 Workflow → Task 2（gen 解析前提）+ Task 7 ✅
- Visual Passport 编辑器 → Task 8 ✅（anchors/refs 池编辑明确降到 P3，避免本期撞素材库联动）
- 验证"运营选图填槽发布出图" → Task 7 Step 5 + Task 9 Step 2 ✅
- 不在本期：per-character 预生图面板、Metric、Batch 成本（P3）；聊天 Agent（P4）。

**Placeholder scan：** 无 TBD；Task 8 Step 3 的"择一插入"是对未勘探文件的显式决策授权（带报告义务），非占位。Task 5 Step 1 指向既有测试模式属锚定 mirror。

**Type consistency：** `WorkflowDescriptor`/`loadWorkflowDescriptors` 名称在 Task 1 定义、5/7 复用一致；`resolveForModel` 双键语义 Task 2 定义、Task 7 消费；`VisualPassportPanel({ characterId })` 单处定义。

**依赖顺序：** 1→2→3→4；5 需 1；6 需 5；7 需 2+5（校验用 loader）且 **Step 2 阻塞于用户执行 SQL**；8 独立（可与 6/7 并行推进但按 SDD 单实现者串行）；9 收口。
