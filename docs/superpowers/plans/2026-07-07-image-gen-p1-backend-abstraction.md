# P1 — 生图底座 workflow-native 抽象（去 OpenAI shim）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `gen worker → OpenAI 兼容 HTTP 网关(sdcpp:8091/comfyui:8092) → runner` 的间接层，替换成 gen worker 直调的统一 `GenBackend` 抽象；ComfyUI 后端直连本机 Desktop 原生 `/prompt`，"生图模版"= 带声明式输入槽的 workflow 描述符；sdcpp 后端保留为 sd-cli 快速 text2img 通道。

**Architecture:** 新增 `packages/gen/src/backend/` 目录，定义 `GenBackend` 接口（`submit/poll/health/capabilities`）+ `Workflow` 描述符 + `bindSlots()` 纯函数。`ComfyUIBackend` 把槽值按 workflow 声明的 `slot→{nodeId,field}` 注入 apiPrompt 后 POST `/prompt`、轮询 `/history`、取 `/view`。`SdcppBackend` 把槽值按 `slot→argFlag` 绑成 sd-cli 参数、spawn、读 PNG。保留现有 `ImageModel` 接口作为接缝：新增 `BackendImageModel implements ImageModel`，`IMAGE_PROVIDER=backend` 时启用，`pipeline.ts` 零改动。删除两个 OpenAI 网关 server。

**Tech Stack:** TypeScript strict（no `any`），bun + tsx，vitest，Zod，本机 ComfyUI Desktop（`/prompt` API），sd-cli 二进制。

## Global Constraints

- TypeScript strict mode，禁止 `any`；named exports；2-space 缩进（copy from AGENTS.md）。
- gen 层不碰 DB、不结算：backend 只产出 bytes/handle（invariant，见 `packages/gen/src/providers.ts:6`）。
- 保持 `ImageModel` 结果封套 `ProviderResult<{assets:[{key?,width,height,contentType?,body?,sourceUrl?}]}>` 不变——main 侧 finalizer 依赖它。
- BullMQ 队列名、`imageGeneratePayloadSchema`（`packages/shared/src/contracts/payloads.ts`）是 wire SSoT，本阶段不改。
- 转换/运行沿用 P0 实测事实：ComfyUI apiPrompt 走 `UNETLoader/CLIPLoader/VAELoader/CLIPTextEncode/ConditioningZeroOut/EmptyLatentImage/KSampler/VAEDecode/SaveImage`；本机 MPS 用 bf16 模型（`redcraftKREA2RedMix_krea2Edition-bf16.safetensors` + `qwen3vl_4b_bf16.safetensors` + `qwen_image_vae.safetensors`）。
- 每个 backend 用 `AbortController` + `PIPELINE_TIMEOUT_MS`（默认 60s，长任务可调）做超时。
- 测试：新代码单测覆盖；backend 的 HTTP/spawn 用 mock，不打真实 ComfyUI（除 Task 8 的门控 smoke）。

---

## File Structure

**Create:**
- `packages/gen/src/backend/types.ts` — `GenBackend`、`ResolvedGenJob`、`BackendHandle`、`BackendResult`、`Capabilities`、`BackendHealth`、`SlotValues`。
- `packages/gen/src/backend/workflow.ts` — `WorkflowDescriptor`（Zod schema + 类型）、`loadWorkflowDescriptors(dir)`、`bindComfySlots(descriptor, slotValues)`、`bindSdcppArgs(descriptor, slotValues)`。
- `packages/gen/src/backend/comfyui.ts` — `ComfyUIBackend implements GenBackend`。
- `packages/gen/src/backend/sdcpp.ts` — `SdcppBackend implements GenBackend`。
- `packages/gen/src/backend/registry.ts` — `buildBackendRegistry(env)`、`resolveForModel(modelId) → {backend, descriptor}`。
- `packages/gen/src/backend/backend-image-model.ts` — `BackendImageModel implements ImageModel`。
- 测试：`packages/gen/src/backend/workflow.test.ts`、`comfyui.test.ts`、`sdcpp.test.ts`、`registry.test.ts`、`backend-image-model.test.ts`。
- workflow 描述符：`packages/gen/workflows/redcraft-krea2-txt2img.json`、`packages/gen/workflows/qwen-image-edit-img2img.json`（在现有 `apiPrompt` 结构上加 `backendKind`、`modelId`、`inputs` 槽声明）。

**Modify:**
- `packages/gen/src/providers.ts` — `buildImageModel()` 增加 `backend` 分支；移除 `PipelineImageModel`（或标注 deprecated 保留给 external）。
- `packages/gen/src/env.ts` — 新增 backend 配置（`COMFYUI_API_URL`、`SDCPP_CLI`、`GEN_WORKFLOW_DIR`、`IMAGE_PROVIDER` 支持 `backend`）。
- `packages/gen/src/providers.ts` 生产就绪断言（`assertProductionProviderReady`）— `pipeline`→`backend`。
- `ecosystem.config.js` — 删除 `sdcpp-image` 进程（`:95`）。
- `packages/gen/package.json` — 删 `serve:comfyui-image`、`serve:sdcpp-image` scripts。

**Delete（Task 7）:**
- `packages/gen/src/comfyui-openai-image-server.ts`
- `packages/gen/src/sdcpp-openai-image-server.ts`

（保留复用：`sdcpp-runtime.ts`、`sdcpp-reference-images.ts`、`reference-images.ts`、`generated-image-sanity.ts`。）

---

## Task 1: Workflow 描述符 + 声明式槽绑定（纯函数）

**Files:**
- Create: `packages/gen/src/backend/workflow.ts`
- Test: `packages/gen/src/backend/workflow.test.ts`

**Interfaces:**
- Produces:
  - `type SlotValues = Record<string, string | number>`
  - `WorkflowDescriptor`（见下 Zod）
  - `bindComfySlots(descriptor: WorkflowDescriptor, values: SlotValues): Record<string, ComfyNode>` — 深拷贝 `descriptor.apiPrompt`，对每个 `inputs[i]`（有 `target.nodeId/field`）写入 `values[key] ?? input.default`；缺必填槽（无 default 且 values 无值）抛 `Error`。
  - `bindSdcppArgs(descriptor, values): string[]` — 对每个 `inputs[i]`（有 `target.argFlag`）push `[flag, String(value)]`。
  - `loadWorkflowDescriptors(dir: string): Promise<WorkflowDescriptor[]>` — 读 `dir/*.json`，Zod 解析，跳过并 `logger.warn` 非法文件。

- [ ] **Step 1: 写失败测试**

```ts
// packages/gen/src/backend/workflow.test.ts
import { describe, it, expect } from "vitest";
import { workflowDescriptorSchema, bindComfySlots, bindSdcppArgs } from "./workflow";

const comfyDescriptor = workflowDescriptorSchema.parse({
  workflowKey: "t2i",
  modelId: "redcraft-krea2-comfyui",
  backendKind: "comfyui",
  version: 1,
  capabilities: ["textToImage", "stableSeed"],
  apiPrompt: {
    "6": { class_type: "CLIPTextEncode", inputs: { text: "" } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512 } },
    "3": { class_type: "KSampler", inputs: { seed: 0, steps: 20 } },
  },
  inputs: [
    { key: "prompt", type: "text", target: { nodeId: "6", field: "text" } },
    { key: "width", type: "int", target: { nodeId: "5", field: "width" }, default: 832 },
    { key: "seed", type: "int", target: { nodeId: "3", field: "seed" } },
  ],
});

describe("bindComfySlots", () => {
  it("injects values into declared node fields and applies defaults", () => {
    const p = bindComfySlots(comfyDescriptor, { prompt: "a cat", seed: 42 });
    expect(p["6"].inputs.text).toBe("a cat");
    expect(p["5"].inputs.width).toBe(832); // default
    expect(p["3"].inputs.seed).toBe(42);
  });
  it("does not mutate the descriptor's apiPrompt", () => {
    bindComfySlots(comfyDescriptor, { prompt: "x", seed: 1 });
    expect(comfyDescriptor.apiPrompt["6"].inputs.text).toBe("");
  });
  it("throws when a required slot (no default) is missing", () => {
    expect(() => bindComfySlots(comfyDescriptor, { prompt: "x" })).toThrow(/seed/);
  });
});

describe("bindSdcppArgs", () => {
  it("maps slots to sd-cli arg flags", () => {
    const d = workflowDescriptorSchema.parse({
      workflowKey: "sd", modelId: "z-turbo", backendKind: "sdcpp", version: 1,
      capabilities: ["textToImage"], apiPrompt: {},
      inputs: [
        { key: "prompt", type: "text", target: { argFlag: "--prompt" } },
        { key: "steps", type: "int", target: { argFlag: "--steps" }, default: 8 },
      ],
    });
    expect(bindSdcppArgs(d, { prompt: "hi" })).toEqual(["--prompt", "hi", "--steps", "8"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `cd packages/gen && bunx vitest run src/backend/workflow.test.ts`，Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `workflow.ts`**

```ts
// packages/gen/src/backend/workflow.ts
// SPEC: Workflow 描述符 = 图(apiPrompt) + 声明式输入槽。运营/上层只填槽，不碰 node id。
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { logger } from "../logger";

export type SlotValues = Record<string, string | number>;

const comfyNodeSchema = z.object({
  class_type: z.string(),
  inputs: z.record(z.string(), z.unknown()),
});
export type ComfyNode = z.infer<typeof comfyNodeSchema>;

const slotSchema = z.object({
  key: z.string(),
  type: z.enum(["text", "int", "float", "image"]),
  target: z.union([
    z.object({ nodeId: z.string(), field: z.string() }),
    z.object({ argFlag: z.string() }),
  ]),
  default: z.union([z.string(), z.number()]).optional(),
});

export const workflowDescriptorSchema = z.object({
  workflowKey: z.string(),
  modelId: z.string(),
  backendKind: z.enum(["comfyui", "sdcpp"]),
  version: z.number().int().positive(),
  capabilities: z.array(z.string()),
  apiPrompt: z.record(z.string(), comfyNodeSchema),
  inputs: z.array(slotSchema),
});
export type WorkflowDescriptor = z.infer<typeof workflowDescriptorSchema>;

function resolveValue(slot: z.infer<typeof slotSchema>, values: SlotValues) {
  const v = values[slot.key] ?? slot.default;
  if (v === undefined) throw new Error(`missing required slot: ${slot.key}`);
  return v;
}

export function bindComfySlots(d: WorkflowDescriptor, values: SlotValues): Record<string, ComfyNode> {
  const prompt = structuredClone(d.apiPrompt);
  for (const slot of d.inputs) {
    if (!("nodeId" in slot.target)) continue;
    const node = prompt[slot.target.nodeId];
    if (!node) throw new Error(`workflow ${d.workflowKey}: slot ${slot.key} targets missing node ${slot.target.nodeId}`);
    node.inputs[slot.target.field] = resolveValue(slot, values);
  }
  return prompt;
}

export function bindSdcppArgs(d: WorkflowDescriptor, values: SlotValues): string[] {
  const args: string[] = [];
  for (const slot of d.inputs) {
    if (!("argFlag" in slot.target)) continue;
    args.push(slot.target.argFlag, String(resolveValue(slot, values)));
  }
  return args;
}

export async function loadWorkflowDescriptors(dir: string): Promise<WorkflowDescriptor[]> {
  const out: WorkflowDescriptor[] = [];
  for (const f of await readdir(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(workflowDescriptorSchema.parse(JSON.parse(await readFile(path.join(dir, f), "utf8"))));
    } catch (err) {
      logger.warn({ file: f, err: String(err) }, "skipping invalid workflow descriptor");
    }
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过** — `bunx vitest run src/backend/workflow.test.ts`，Expected: PASS。

- [ ] **Step 5: Commit** — `git add packages/gen/src/backend/workflow.ts packages/gen/src/backend/workflow.test.ts && git commit -m "feat(gen): workflow descriptor + declarative slot binding"`

---

## Task 2: GenBackend 契约类型

**Files:**
- Create: `packages/gen/src/backend/types.ts`
- Test: 无独立测试（纯类型；被 Task 3/4 的实现测试覆盖）。折进 Task 3 的 commit。

**Interfaces:**
- Produces:
  - `interface Capabilities { textToImage: boolean; img2img: boolean; referenceImages: boolean; stableSeed: boolean; edit: boolean }`
  - `interface ResolvedGenJob { descriptor: WorkflowDescriptor; slots: SlotValues; referenceImages?: NonNullable<ImageGeneratePayload["referenceImages"]>; requestId?: string; timeoutMs: number }`
  - `interface BackendAsset { body: Uint8Array; width: number; height: number; contentType: string }`
  - `interface BackendResult { assets: BackendAsset[] }`
  - `type BackendHandle = { id: string }`
  - `interface BackendHealth { ok: boolean; detail?: string }`
  - `interface GenBackend { readonly id: string; readonly kind: "comfyui" | "sdcpp"; capabilities(): Capabilities; submit(job: ResolvedGenJob): Promise<BackendHandle>; poll(handle: BackendHandle): Promise<BackendResult>; health(): Promise<BackendHealth> }`

- [ ] **Step 1: 实现 `types.ts`**

```ts
// packages/gen/src/backend/types.ts
import type { ImageGeneratePayload } from "@idream/shared";
import type { SlotValues, WorkflowDescriptor } from "./workflow";

export interface Capabilities {
  textToImage: boolean;
  img2img: boolean;
  referenceImages: boolean;
  stableSeed: boolean;
  edit: boolean;
}

export interface ResolvedGenJob {
  descriptor: WorkflowDescriptor;
  slots: SlotValues;
  referenceImages?: NonNullable<ImageGeneratePayload["referenceImages"]>;
  requestId?: string;
  timeoutMs: number;
}

export interface BackendAsset {
  body: Uint8Array;
  width: number;
  height: number;
  contentType: string;
}
export interface BackendResult { assets: BackendAsset[] }
export type BackendHandle = { id: string };
export interface BackendHealth { ok: boolean; detail?: string }

export interface GenBackend {
  readonly id: string;
  readonly kind: "comfyui" | "sdcpp";
  capabilities(): Capabilities;
  submit(job: ResolvedGenJob): Promise<BackendHandle>;
  poll(handle: BackendHandle): Promise<BackendResult>;
  health(): Promise<BackendHealth>;
}
```

- [ ] **Step 2: typecheck** — `cd packages/gen && bunx tsc --noEmit`，Expected: 无新错误（`ImageGeneratePayload` 从 `@idream/shared` 可解析；若 import 路径不同，按 `providers.ts` 里现有 import 对齐）。

- [ ] **Step 3: Commit（与 Task 3 合并提交亦可）** — 暂不单独 commit，随 Task 3。

---

## Task 3: ComfyUIBackend

**Files:**
- Create: `packages/gen/src/backend/comfyui.ts`
- Test: `packages/gen/src/backend/comfyui.test.ts`
- Reference（移植来源，勿改）: `packages/gen/src/comfyui-openai-image-server.ts`（`submitPrompt`/`waitForImage`/`fetchComfyImage`/`requiredModelIssues` 逻辑）

**Interfaces:**
- Consumes: Task 1 `bindComfySlots`、`WorkflowDescriptor`；Task 2 `GenBackend/ResolvedGenJob/BackendResult`。
- Produces: `class ComfyUIBackend implements GenBackend`，构造 `new ComfyUIBackend({ apiUrl: string })`。

**实现要点（从 openai-image-server 移植，去掉 OpenAI 路由外壳）：**
- `submit(job)`: `const prompt = bindComfySlots(job.descriptor, job.slots)` → `POST {apiUrl}/prompt` body `{ prompt, client_id }` → 返回 `{ id: prompt_id }`；`prompt_id` 缺失抛 error（含 `node_errors`）。
- `poll(handle)`: `GET {apiUrl}/history/{id}` 轮询直到 `status.completed`；取第一个 `SaveImage` 输出 `{filename,subfolder,type}`；`GET {apiUrl}/view?filename=..&subfolder=..&type=..` 取 bytes；`assertGeneratedImageSanity(Buffer.from(bytes), id)`；返回 `{assets:[{body,width,height,contentType:"image/png"}]}`（w/h 从 job.slots 或 PNG header）。
- `health()`: `GET {apiUrl}/system_stats` 200 → `{ok:true}`，否则 `{ok:false,detail}`。
- 用 `AbortController` + `job.timeoutMs`；轮询间隔 1s。

- [ ] **Step 1: 写失败测试（mock fetch）**

```ts
// packages/gen/src/backend/comfyui.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ComfyUIBackend } from "./comfyui";
import { workflowDescriptorSchema } from "./workflow";

const descriptor = workflowDescriptorSchema.parse({
  workflowKey: "t2i", modelId: "redcraft-krea2-comfyui", backendKind: "comfyui",
  version: 1, capabilities: ["textToImage"],
  apiPrompt: { "9": { class_type: "SaveImage", inputs: {} },
               "6": { class_type: "CLIPTextEncode", inputs: { text: "" } } },
  inputs: [{ key: "prompt", type: "text", target: { nodeId: "6", field: "text" } }],
});

// 1x1 PNG
const PNG = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
), (c) => c.charCodeAt(0));

function mockFetch(seq: Array<() => Response>) {
  let i = 0;
  return vi.fn(async () => seq[Math.min(i++, seq.length - 1)]());
}

describe("ComfyUIBackend", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("submits prompt then polls history and fetches image", async () => {
    const g = mockFetch([
      () => new Response(JSON.stringify({ prompt_id: "p1" }), { status: 200 }),
      () => new Response(JSON.stringify({ p1: { status: { completed: true },
        outputs: { "9": { images: [{ filename: "a.png", subfolder: "", type: "output" }] } } } }), { status: 200 }),
      () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }),
    ]);
    vi.stubGlobal("fetch", g);
    const backend = new ComfyUIBackend({ apiUrl: "http://x" });
    const handle = await backend.submit({ descriptor, slots: { prompt: "cat" }, timeoutMs: 5000 });
    expect(handle.id).toBe("p1");
    const result = await backend.poll(handle);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].body.byteLength).toBeGreaterThan(0);
    // submitted body carried the bound slot
    const submitBody = JSON.parse((g.mock.calls[0][1] as RequestInit).body as string);
    expect(submitBody.prompt["6"].inputs.text).toBe("cat");
  });
  it("throws when prompt is rejected (no prompt_id)", async () => {
    vi.stubGlobal("fetch", mockFetch([() => new Response(JSON.stringify({ node_errors: { "6": "bad" } }), { status: 200 })]));
    const backend = new ComfyUIBackend({ apiUrl: "http://x" });
    await expect(backend.submit({ descriptor, slots: { prompt: "cat" }, timeoutMs: 5000 })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `bunx vitest run src/backend/comfyui.test.ts`，Expected: FAIL。

- [ ] **Step 3: 实现 `comfyui.ts`**（移植 `comfyui-openai-image-server.ts` 的 submitPrompt/waitForImage/fetchComfyImage；`buildPrompt` 换成 `bindComfySlots`）。完整实现：签名 `constructor(opts: { apiUrl: string; pollIntervalMs?: number })`，方法如上要点。图像 w/h 优先取 `slots.width/height`，缺省从 PNG IHDR 解析。复用 `assertGeneratedImageSanity`（`../generated-image-sanity`）。

- [ ] **Step 4: 跑测试确认通过** — `bunx vitest run src/backend/comfyui.test.ts`，Expected: PASS。

- [ ] **Step 5: Commit** — `git add packages/gen/src/backend/{types,comfyui}.ts packages/gen/src/backend/comfyui.test.ts && git commit -m "feat(gen): GenBackend types + ComfyUIBackend (native /prompt)"`

---

## Task 4: SdcppBackend

**Files:**
- Create: `packages/gen/src/backend/sdcpp.ts`
- Test: `packages/gen/src/backend/sdcpp.test.ts`
- Reference（移植/复用）: `packages/gen/src/sdcpp-openai-image-server.ts`（`runSdcpp`/`buildSdcppArgs`）、`sdcpp-runtime.ts`、`sdcpp-reference-images.ts`

**Interfaces:**
- Consumes: Task 1 `bindSdcppArgs`；Task 2 `GenBackend`。
- Produces: `class SdcppBackend implements GenBackend`，构造 `new SdcppBackend({ cli: string })`。`submit` 同步跑完（sd-cli 一次一图），`poll` 直接返回缓存结果（handle 携带内存结果 id）。

**实现要点：** `submit(job)` → `bindSdcppArgs` + reference args（复用 `sdcppReferenceArgs`）→ spawn `cli` → 读输出 PNG → sanity → 存入内存 map，返回 `{id}`；`poll` 从 map 取。`health()` 检查 `cli` 可执行（`access X_OK`）。测试用 `vi.mock("node:child_process")` 桩 spawn，验证参数含绑定后的 flags。

- [ ] **Step 1: 写失败测试** — mock `node:child_process` spawn 返回退出码 0 并写一个临时 PNG；断言 `bindSdcppArgs` 产出的 flags 出现在 spawn argv。（结构同 Task 3 风格）

- [ ] **Step 2: 跑测试确认失败** — `bunx vitest run src/backend/sdcpp.test.ts`，Expected: FAIL。

- [ ] **Step 3: 实现 `sdcpp.ts`**（从 `sdcpp-openai-image-server.ts` 抽 `runSdcpp`；参数拼接换成 `bindSdcppArgs` + 复用 reference-images 模块）。

- [ ] **Step 4: 跑测试确认通过** — Expected: PASS。

- [ ] **Step 5: Commit** — `git commit -m "feat(gen): SdcppBackend (sd-cli fast text2img channel)"`

---

## Task 5: Registry + BackendImageModel + providers/env 接线

**Files:**
- Create: `packages/gen/src/backend/registry.ts`、`packages/gen/src/backend/backend-image-model.ts`
- Test: `packages/gen/src/backend/registry.test.ts`、`packages/gen/src/backend/backend-image-model.test.ts`
- Modify: `packages/gen/src/env.ts`、`packages/gen/src/providers.ts:424-428`（`buildImageModel`）

**Interfaces:**
- Consumes: Task 1–4。`ImageModel`（`../providers`）。
- Produces:
  - `buildBackendRegistry(opts: { comfyApiUrl: string; sdcppCli: string; workflowDir: string }): Promise<{ resolveForModel(modelId: string): { backend: GenBackend; descriptor: WorkflowDescriptor } }>` — 加载 workflow 描述符，按 `descriptor.modelId` 建索引；`backendKind` 决定用哪个 backend 实例。
  - `class BackendImageModel implements ImageModel` — 构造接收 registry。

**BackendImageModel.generate 映射（对齐 `ImageModel` 接口 `providers.ts:24-46`）：**
- `orientation → {width,height}`（复用 `orientationToOpenAiSize` 的映射逻辑，或新建 `orientationToSize`）。
- slots = `{ prompt, negative: input.negativePrompt ?? "", width, height, seed: Number(input.seed ?? deterministicSeed), steps: controls?.steps ?? descriptor 默认 }`。
- `count>1` → 循环 `submit/poll` N 次（seed 递增）。
- 每次 `backend.submit → poll`，聚合 `assets`。
- 失败映射为 `ProviderResult{ok:false,error:{code,message,retryable}}`（transient=network/timeout → retryable=true）。

- [ ] **Step 1: 写失败测试** — `backend-image-model.test.ts`：注入一个假 registry（`resolveForModel` 返回桩 backend，其 `submit/poll` 返回 1 张 asset），调 `generate({prompt,count:2,model:"m",orientation:"portrait"})`，断言返回 2 个 assets 且 `ok:true`；再让桩 backend `poll` 抛错，断言 `ok:false` 且 `retryable` 正确。

- [ ] **Step 2: 跑测试确认失败** — `bunx vitest run src/backend/backend-image-model.test.ts`，Expected: FAIL。

- [ ] **Step 3: 实现 `registry.ts` + `backend-image-model.ts`**，并接线：

`env.ts` 新增（getter 风格，与现有一致）：
```ts
get COMFYUI_API_URL(): string { return process.env.COMFYUI_API_URL ?? "http://127.0.0.1:8188"; }
get SDCPP_CLI(): string { return process.env.SDCPP_CLI ?? `${process.env.HOME}/bin/sd-cli`; }
get GEN_WORKFLOW_DIR(): string { return process.env.GEN_WORKFLOW_DIR ?? "packages/gen/workflows"; }
```
`providers.ts` `buildImageModel()`：
```ts
if (env.IMAGE_PROVIDER === "mock") return new MockImageModel();
if (env.IMAGE_PROVIDER === "backend") return buildBackendImageModel(); // async-init 缓存
if (env.IMAGE_PROVIDER === "pipeline") return new PipelineImageModel(); // deprecated: external OpenAI 网关
throw new Error(`Unsupported image provider: ${env.IMAGE_PROVIDER}`);
```
（`buildBackendImageModel` 用一个 module-level `let registryPromise` 懒加载 registry，避免每次 rebuild。）

- [ ] **Step 4: 跑测试确认通过** — `bunx vitest run src/backend/`，Expected: 全 PASS。

- [ ] **Step 5: Commit** — `git commit -m "feat(gen): backend registry + BackendImageModel, wire IMAGE_PROVIDER=backend"`

---

## Task 6: 两个目标模型的 workflow 描述符

**Files:**
- Create: `packages/gen/workflows/redcraft-krea2-txt2img.json`、`packages/gen/workflows/qwen-image-edit-img2img.json`
- Test: `packages/gen/src/backend/workflow.test.ts`（追加：加载真实描述符文件、断言 schema 通过 + 关键槽存在）

**内容要点：**
- `redcraft-krea2-txt2img.json`：`backendKind:"comfyui"`、`modelId:"redcraft-krea2-comfyui"`、`apiPrompt` 用 **bf16 模型名**（`redcraftKREA2RedMix_krea2Edition-bf16.safetensors`、`qwen3vl_4b_bf16.safetensors`、`qwen_image_vae.safetensors`；CLIPLoader `type:"krea2"`；KSampler `er_sde`/`simple`/`cfg 1`），`inputs` 槽：prompt→CLIPTextEncode.text、width/height→EmptyLatentImage、seed/steps→KSampler。（可从 P0 用过的 `redcraft-krea2-bf16-mps.json` 的 `apiPrompt` 起改。）
- `qwen-image-edit-img2img.json`：`backendKind:"comfyui"`、`modelId:"qwen-image-edit"`、`capabilities:["img2img","edit","referenceImages"]`；以 Desktop blueprint `Image Edit (Qwen 2511)` 为起点；`inputs` 槽加 `source_image`（type:"image"）、`edit_prompt`。**依赖 Qwen-Edit bf16 转换产物**（P0 收口任务，下载完成后 `dequant_fp8_to_bf16.py` 转出 `Qwen-Rapid-AIO-NSFW-v19-bf16.safetensors`）与 `fixed-textencode-node (v2)` 自定义节点安装。

- [ ] **Step 1: 追加加载测试** — 断言 `loadWorkflowDescriptors("packages/gen/workflows")` 返回含 `redcraft-krea2-comfyui` 与 `qwen-image-edit` 两个 modelId。

- [ ] **Step 2: 跑确认失败** — Expected: FAIL（文件未建）。

- [ ] **Step 3: 建两个 JSON**（apiPrompt + inputs 槽）。

- [ ] **Step 4: 跑确认通过** — Expected: PASS。

- [ ] **Step 5: Commit** — `git commit -m "feat(gen): workflow descriptors for redcraft-krea2 + qwen-image-edit"`

---

## Task 7: 删除 OpenAI 网关 server + 清理编排

**Files:**
- Delete: `packages/gen/src/comfyui-openai-image-server.ts`、`packages/gen/src/sdcpp-openai-image-server.ts`
- Modify: `ecosystem.config.js`（删 `sdcpp-image` 进程块 `:94-120` 附近）、`packages/gen/package.json`（删 `serve:comfyui-image`/`serve:sdcpp-image`）、`packages/gen/src/providers.ts`（`assertProductionProviderReady` 里 `pipeline`→`backend`；prod 断言：`IMAGE_PROVIDER=backend` 时校验 `COMFYUI_API_URL` 可达或至少非空）

- [ ] **Step 1: 先确认无引用残留** — `cd packages/gen && grep -rn "openai-image-server\|serve:comfyui\|serve:sdcpp\|PipelineImageModel" src ../../ecosystem.config.js package.json`；除 deprecated PipelineImageModel（保留给 external）外应无对两个 server 文件的引用。
- [ ] **Step 2: 删文件 + 改编排/脚本/断言**（按上）。
- [ ] **Step 3: 全量校验** — 仓库根 `bun run typecheck && bun run lint`，Expected: PASS（无对已删文件的引用）。
- [ ] **Step 4: 跑 gen 测试** — `cd packages/gen && bunx vitest run`，Expected: PASS。
- [ ] **Step 5: Commit** — `git commit -m "refactor(gen): remove OpenAI-compat gateway servers; gen worker calls GenBackend directly"`

---

## Task 8: 门控端到端 smoke（真实本机 ComfyUI）+ 文档

**Files:**
- Create: `packages/gen/src/backend/smoke.ts`（脚本，`package.json` 加 `smoke:backend`）
- Modify: `packages/gen/README.md`（或新建）记录 backend 抽象、如何指向本机 ComfyUI、如何跑 smoke。

**Interfaces:** 复用 `BackendImageModel` + registry。脚本读 `COMFYUI_API_URL`，对 `redcraft-krea2-comfyui` 提交一次真实生成，`assertGeneratedImageSanity`，写 PNG，打印耗时。默认不在 CI 跑（需真实 ComfyUI），仅本地手动。

- [ ] **Step 1: 写 smoke 脚本**（调 `providers.image.generate({model:"redcraft-krea2-comfyui",prompt,count:1,orientation:"portrait",seed})`，`IMAGE_PROVIDER=backend`）。
- [ ] **Step 2: 本机手动跑**（ComfyUI 8188 在跑时）— `cd packages/gen && IMAGE_PROVIDER=backend COMFYUI_API_URL=http://127.0.0.1:8188 bun run smoke:backend`，Expected: 输出一张过 sanity 的 PNG（复现 P0 结果，只是走新抽象而非 probe 脚本）。
- [ ] **Step 3: 写 README 段**（backend 抽象 + 指向 ComfyUI + smoke 用法 + bf16 转换器指引）。
- [ ] **Step 4: Commit** — `git commit -m "feat(gen): backend e2e smoke + docs"`

---

## Self-Review

**Spec coverage（对 §3 底座架构）：**
- §3.1 GenBackend 接口 → Task 2 ✅
- §3.2 ComfyUIBackend 直连 /prompt、SdcppBackend 快速通道 → Task 3/4 ✅
- §3.2 删除两个 OpenAI shim server → Task 7 ✅
- §3.3 Workflow 描述符 + 声明式 `slot→{nodeId,field}`/`argFlag` 绑定 → Task 1 + Task 6 ✅
- §4.1/§4.2 两个目标模型 workflow（bf16）→ Task 6（Qwen-Edit 依赖 P0 下载/转换收口）✅
- gen worker 直调 backend（保留 ImageModel 接缝，pipeline.ts 零改）→ Task 5 ✅

**未覆盖（属其他阶段，本 P1 不做）：** 运营配置台（P2）、角色预生图/Metric（P3）、聊天 Agent 工具注册表（P4）、`GenerationModelProfile` 改为引用 Workflow（P2，届时 registry 的 modelId→descriptor 映射改由 DB profile 驱动）。P1 仅用文件系统 workflow 描述符，为 P2 留好接缝（registry 是唯一改动点）。

**Placeholder scan：** 无 TBD/TODO；code 步骤均含实体代码或精确移植来源。Task 4/6/8 的部分实现引用了具体的移植源文件与 P0 产物，非占位。

**Type consistency：** `GenBackend.submit/poll`、`ResolvedGenJob`、`BackendResult`、`WorkflowDescriptor`、`bindComfySlots`/`bindSdcppArgs`、`SlotValues` 在 Task 1/2 定义，Task 3/4/5 一致引用；`ImageModel` 接缝签名对齐 `providers.ts:24-46`。

**依赖顺序：** Task 1 → 2 → (3,4 并行) → 5 → 6 → 7 → 8。Task 6 的 Qwen-Edit 描述符与 Task 8 的真实 smoke 依赖 P0 收口（Qwen-Edit 下载+转换、fixed-textencode-node 安装）；RedCraft 通路 P0 已验证，可先行。
