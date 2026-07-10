# Admin「生成」组重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 admin「生成」组从工程调试面板改成运营看得懂、走得动的三层界面（纯前端）。

**Architecture:** 建 5 个小的前端单元（4 个 presentation 原语 + 1 个失败原因字典），把「生成」组 6 个页面重写成薄组合；把 nav 从两组（GenerationConfig/Engineering）重排成三组（Operations/GenerationOps/Engineering）。不动 API/schema/worker。

**Tech Stack:** Next 16 + React 19 + TypeScript strict；Tailwind v4；Lucide；vitest（node env，纯函数测试）；i18n = `useAdminI18n()` 的 `t()`（查不到 key 回退英文）。

## Global Constraints

- **纯前端**：禁止改 `packages/main/src/server/**`、Prisma schema、API 路由、worker。只动 `packages/main/src/components/admin/**`。
- **不做 RBAC / 角色门禁**：分层靠 nav 分组与视觉层级，不靠权限。
- **i18n SSoT**：所有用户可见文案走 `t(key)`；zh 译文进 `i18n.tsx` 的 `zh`（标题/按钮/正文，起始 `i18n.tsx:9`）或 `zhColumns`（表头，`i18n.tsx:648`）。`t()` 查不到 zh 键→回退英文（这是"英文残留"的成因）。
- **标识符不翻译但必折叠**：内部 ID / `.safetensors` 文件名 / 机器错误码 / 组件名，一律只出现在 `EngineeringDetails` 折叠区内，运营首屏不可见。
- **测试前置（重要）**：`packages/main/vitest.config.ts` 注册了 `globalSetup`，每次 `vitest run` 都会对 `localhost:5433/idream_test` 做 db-push+seed。**跑任何 vitest 前，先确保测试用 Postgres(5433) 可达**，否则测试在执行前就失败。命令一律在 `packages/main/` 下跑。
- **单文件测试命令**：`cd packages/main && bunx vitest run <相对路径>`。
- **收尾门槛**：`bun run check`（root，= lint + typecheck + build）全绿。
- **组件测试策略（偏离 spec §5，已在计划顶部说明）**：仓库无 DOM 渲染测试基建，且刻意不引入。含真实逻辑的单元（`failureReasons`、nav 数据、i18n 覆盖）走 `.test.ts`；presentation 原语与页面薄化由 **P5 人工 zh 逐页冒烟** 验收。
- **既有 INVARIANT**：`nav-config` 的 `id/href/icon/tier` 不改；daily+folded 必须覆盖所有 id 恰好一次（`nav-config.test.ts` 有守卫）。

---

## 计划顶部说明：对 spec 的两处实现细化（请在评审时确认）

1. **组 key 命名**：spec §4.1 的三组，用 group key `Operations` / `GenerationOps` / `Engineering`。`Operations` 是把现有 `GenerationConfig` 组**改名**（成员不变：config/recipes/presets）；`GenerationOps` 是从 `Engineering` **拆出**（jobs/dead-letter/backends/ops-providers）；`Engineering` 保留 workflows/metrics。英文界面会显示这些 camelCase key（与现有 "CharacterConfig" 一致），zh 显示 运营/运维/工程诊断。
2. **组件测试**：见 Global Constraints 最后一条——纯逻辑单测 + 人工冒烟，不引入 jsdom/testing-library。

---

## File Structure

**新建**（`packages/main/src/components/admin/generation/`）：
- `failureReasons.ts` — 机器码→人话字典 + `resolveFailureReason()`（纯函数，SSoT）。
- `failureReasons.test.ts` — 纯函数单测。
- `EngineeringDetails.tsx` — 折叠容器（原生 `<details>`，默认折叠）。
- `FailureReason.tsx` — 单个失败原因展示（人话 + severity 配色 + 原码折叠）。
- `OperatorFlow.tsx` — 列表→选中→详情 响应式骨架（修 config 挤压 bug）。
- `ReadonlyOpsView.tsx` — 运维只读表格 + 人话状态。

**修改**：
- `packages/main/src/components/admin/nav-config.ts` — group 字段 + `FOLDED_GROUP_ORDER`。
- `packages/main/src/components/admin/nav-config.test.ts` — 两个硬编码顺序数组 + `idsInGroup` 成员。
- `packages/main/src/components/admin/i18n.tsx` — zh 组名 + 新增文案 + zhColumns 表头。
- `packages/main/src/components/admin/AdminConsoleClient.tsx` — `ConfigView`(~3230)、`PromptRecipesView`(3321)、`GenerationPresetsView`(3354)、`JobsView`(2445)、`DeadLetterView`(5618) 改用原语。
- `packages/main/src/components/admin/BackendsView.tsx` — 改用 `ReadonlyOpsView` + `FailureReason`。

**不动**：`WorkflowsView.tsx`、`GenerationMetricsView.tsx`（工程组保持原样）。

---

## Task 1: `failureReasons.ts` 字典 + 解析函数（TDD）

**Files:**
- Create: `packages/main/src/components/admin/generation/failureReasons.ts`
- Test: `packages/main/src/components/admin/generation/failureReasons.test.ts`

**Interfaces:**
- Produces: `type FailureSeverity = "retry" | "engineering" | "waiting"`；`type FailureReason = { code: string; title: string; hint: string; severity: FailureSeverity }`；`resolveFailureReason(code: string | null | undefined): FailureReason`（永不返回 undefined；`title`/`hint` 是 i18n key）。

- [ ] **Step 1: 写失败测试**

```ts
// packages/main/src/components/admin/generation/failureReasons.test.ts
import { describe, it, expect } from "vitest";
import { resolveFailureReason } from "./failureReasons";

describe("resolveFailureReason", () => {
  it("maps a known code and keeps severity", () => {
    const r = resolveFailureReason("timeout");
    expect(r.severity).toBe("retry");
    expect(r.title).toBe("Generation timed out");
    expect(r.code).toBe("timeout");
  });
  it("is case- and whitespace-insensitive on the lookup key", () => {
    expect(resolveFailureReason("  MISSING_RUNTIME_COMPONENTS ").severity).toBe("engineering");
  });
  it("falls back for unknown codes but preserves the raw code", () => {
    const r = resolveFailureReason("weird_new_code");
    expect(r.title).toBe("Unknown error");
    expect(r.severity).toBe("engineering");
    expect(r.code).toBe("weird_new_code");
  });
  it("handles null/undefined without throwing", () => {
    expect(resolveFailureReason(null).title).toBe("Unknown error");
    expect(resolveFailureReason(undefined).code).toBe("");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/main && bunx vitest run src/components/admin/generation/failureReasons.test.ts`
Expected: FAIL（`Cannot find module './failureReasons'`）。（若报 PG 连接错，先起测试库再跑——见 Global Constraints。）

- [ ] **Step 3: 写实现**

```ts
// packages/main/src/components/admin/generation/failureReasons.ts
// SPEC: 前端 SSoT——把生成失败的机器码/failureMode/verificationStatus 翻成运营看得懂的
//       人话标题 + 建议动作。纯前端，不依赖后端返回结构。
// INTENT: 未知码必须走兜底，绝不把原始码漏到运营首屏（原码只在 EngineeringDetails 展开可见）。
// INVARIANTS: resolveFailureReason 对任意输入都返回一个 FailureReason（永不 undefined）。
// EXAMPLE: resolveFailureReason("timeout") → { code:"timeout", title:"Generation timed out", hint:"Safe to retry", severity:"retry" }

export type FailureSeverity = "retry" | "engineering" | "waiting";

export type FailureReason = {
  code: string; // 原始机器码，保留给 EngineeringDetails 展开
  title: string; // i18n key（人话标题）
  hint: string; // i18n key（建议动作）
  severity: FailureSeverity;
};

// key = 机器码 / failureMode / verificationStatus（小写下划线）。title/hint 存 i18n key。
const TABLE: Record<string, Omit<FailureReason, "code">> = {
  missing_runtime_components: {
    title: "Model files not ready",
    hint: "Missing runtime components — needs engineering",
    severity: "engineering",
  },
  missing_flux2_klein_reference_runtime_components: {
    title: "Model files not ready",
    hint: "Missing runtime components — needs engineering",
    severity: "engineering",
  },
  timeout: { title: "Generation timed out", hint: "Safe to retry", severity: "retry" },
  backend_unreachable: {
    title: "Backend unreachable",
    hint: "Check backend health — needs engineering",
    severity: "engineering",
  },
};

const FALLBACK: Omit<FailureReason, "code"> = {
  title: "Unknown error",
  hint: "Share the error code with engineering",
  severity: "engineering",
};

export function resolveFailureReason(code: string | null | undefined): FailureReason {
  const key = (code ?? "").trim().toLowerCase();
  const hit = key ? TABLE[key] : undefined;
  return { code: code ?? "", ...(hit ?? FALLBACK) };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/main && bunx vitest run src/components/admin/generation/failureReasons.test.ts`
Expected: PASS（4 tests）。

- [ ] **Step 5: 提交**

```bash
git add packages/main/src/components/admin/generation/failureReasons.ts packages/main/src/components/admin/generation/failureReasons.test.ts
git commit -m "feat(admin): failure-reason dictionary for generation ops"
```

---

## Task 2: `EngineeringDetails` 折叠容器

**Files:**
- Create: `packages/main/src/components/admin/generation/EngineeringDetails.tsx`

**Interfaces:**
- Consumes: `useAdminI18n` from `@/components/admin/i18n`。
- Produces: `EngineeringDetails({ summary, children }: { summary: ReactNode; children: ReactNode })`；默认折叠。

- [ ] **Step 1: 写组件**

```tsx
// packages/main/src/components/admin/generation/EngineeringDetails.tsx
"use client";
// SPEC: 折叠容器——首屏只显示一行人话摘要；展开才见工程标识符（ID/文件名/原始码/组件表）。
// INTENT: 运营默认看不到黑话；工程需要时点开。用原生 <details>，无外部状态。
// INVARIANTS: 默认折叠（<details> 不带 open）。
import type { ReactNode } from "react";
import { useAdminI18n } from "@/components/admin/i18n";

export function EngineeringDetails({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  const { t } = useAdminI18n();
  return (
    <details className="group border border-white/10 bg-black/20 text-xs">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[rgb(170,170,170)] [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 truncate">{summary}</span>
        <span className="shrink-0 text-[11px] opacity-60">{t("Engineering details")}</span>
      </summary>
      <div className="border-t border-white/10 px-3 py-2 font-mono break-all text-[rgb(170,170,170)]">
        {children}
      </div>
    </details>
  );
}
```

- [ ] **Step 2: 类型检查通过**

Run: `cd packages/main && bunx tsc --noEmit`
Expected: 无与本文件相关的错误。（渲染态由 P5 人工冒烟验收。）

- [ ] **Step 3: 提交**

```bash
git add packages/main/src/components/admin/generation/EngineeringDetails.tsx
git commit -m "feat(admin): EngineeringDetails collapsible (fold jargon)"
```

---

## Task 3: `FailureReason` 展示组件

**Files:**
- Create: `packages/main/src/components/admin/generation/FailureReason.tsx`

**Interfaces:**
- Consumes: `resolveFailureReason` (Task 1)、`EngineeringDetails` (Task 2)、`useAdminI18n`。
- Produces: `FailureReason({ code, detail }: { code: string | null | undefined; detail?: string })`。

- [ ] **Step 1: 写组件**

```tsx
// packages/main/src/components/admin/generation/FailureReason.tsx
"use client";
// SPEC: 展示单个失败原因——人话标题 + 建议动作，配色按 severity；原始码/detail 折进 EngineeringDetails。
// INVARIANTS: 首屏只见人话；code/detail 仅在折叠区。
import { useAdminI18n } from "@/components/admin/i18n";
import { EngineeringDetails } from "./EngineeringDetails";
import { resolveFailureReason } from "./failureReasons";

const SEVERITY_CLASS: Record<string, string> = {
  retry: "text-amber-300",
  engineering: "text-red-300",
  waiting: "text-[rgb(170,170,170)]",
};

export function FailureReason({ code, detail }: { code: string | null | undefined; detail?: string }) {
  const { t } = useAdminI18n();
  const reason = resolveFailureReason(code);
  const hasTechnical = Boolean(reason.code || detail);
  return (
    <div className="space-y-2">
      <p className="text-sm">
        <span className={`font-medium ${SEVERITY_CLASS[reason.severity]}`}>{t(reason.title)}</span>
        <span className="text-[rgb(170,170,170)]"> · {t(reason.hint)}</span>
      </p>
      {hasTechnical ? (
        <EngineeringDetails summary={t("Technical detail")}>
          {reason.code ? <div>{reason.code}</div> : null}
          {detail ? <div className="whitespace-pre-wrap">{detail}</div> : null}
        </EngineeringDetails>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: 类型检查通过**

Run: `cd packages/main && bunx tsc --noEmit`
Expected: 无本文件相关错误。

- [ ] **Step 3: 提交**

```bash
git add packages/main/src/components/admin/generation/FailureReason.tsx
git commit -m "feat(admin): FailureReason (plain-language failure + folded code)"
```

---

## Task 4: `OperatorFlow` 列表→选中→详情 骨架（修布局塌陷）

**Files:**
- Create: `packages/main/src/components/admin/generation/OperatorFlow.tsx`

**Interfaces:**
- Consumes: `cn` from `@/lib/utils`、`useAdminI18n`。
- Produces:
  - `type OperatorFlowItem = { id: string; primary: ReactNode; secondary?: ReactNode; badge?: ReactNode }`
  - `OperatorFlow({ items, selectedId, onSelect, detail, empty }: { items: OperatorFlowItem[]; selectedId: string | null; onSelect: (id: string) => void; detail: ReactNode; empty?: ReactNode })`

- [ ] **Step 1: 写组件**

```tsx
// packages/main/src/components/admin/generation/OperatorFlow.tsx
"use client";
// SPEC: 运营动线骨架——左"列表"选一项，右"详情+动作"。响应式：窄屏单栏堆叠。
// INTENT: 纯布局+选择，不含业务判断；动作可用性由调用方在 detail 里决定。
// INVARIANTS: selectedId 受控；空列表显示 empty 文案；右栏 min-w-0 防止内容把栏挤成竖排（修 config 挤压 bug）。
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useAdminI18n } from "@/components/admin/i18n";

export type OperatorFlowItem = {
  id: string;
  primary: ReactNode;
  secondary?: ReactNode;
  badge?: ReactNode;
};

export function OperatorFlow({
  items,
  selectedId,
  onSelect,
  detail,
  empty,
}: {
  items: OperatorFlowItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  detail: ReactNode;
  empty?: ReactNode;
}) {
  const { t } = useAdminI18n();
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(260px,340px)_1fr]">
      <ul className="space-y-1">
        {items.length === 0 ? (
          <li className="border border-white/10 px-3 py-6 text-center text-xs text-[rgb(170,170,170)]">
            {empty ?? t("Nothing here yet.")}
          </li>
        ) : (
          items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                className={cn(
                  "flex w-full items-start justify-between gap-2 border px-3 py-2 text-left text-sm",
                  item.id === selectedId
                    ? "border-white/40 bg-white/10"
                    : "border-white/10 hover:bg-white/5",
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate">{item.primary}</span>
                  {item.secondary ? (
                    <span className="block truncate text-xs text-[rgb(170,170,170)]">{item.secondary}</span>
                  ) : null}
                </span>
                {item.badge ? <span className="shrink-0">{item.badge}</span> : null}
              </button>
            </li>
          ))
        )}
      </ul>
      <div className="min-w-0">{detail}</div>
    </div>
  );
}
```

- [ ] **Step 2: 类型检查通过**

Run: `cd packages/main && bunx tsc --noEmit`
Expected: 无本文件相关错误。

- [ ] **Step 3: 提交**

```bash
git add packages/main/src/components/admin/generation/OperatorFlow.tsx
git commit -m "feat(admin): OperatorFlow list-select-detail shell (responsive)"
```

---

## Task 5: `ReadonlyOpsView` 运维只读视图

**Files:**
- Create: `packages/main/src/components/admin/generation/ReadonlyOpsView.tsx`

**Interfaces:**
- Consumes: `useAdminI18n`。
- Produces:
  - `type OpsColumn = { key: string; label: string; render?: (row: Record<string, unknown>) => ReactNode }`
  - `ReadonlyOpsView({ title, columns, rows, empty }: { title: string; columns: OpsColumn[]; rows: Record<string, unknown>[]; empty?: ReactNode })`
- Note: `label`/`title` 经 `t()`；横向 `overflow-x-auto` 防挤压。

- [ ] **Step 1: 写组件**

```tsx
// packages/main/src/components/admin/generation/ReadonlyOpsView.tsx
"use client";
// SPEC: 运维只读视图——表格展示 rows；失败行由调用方用 FailureReason 渲染 render() 出人话；无写操作。
// INVARIANTS: 纯展示；表格外层 overflow-x-auto，窄屏横滚不挤压。
import type { ReactNode } from "react";
import { useAdminI18n } from "@/components/admin/i18n";

export type OpsColumn = {
  key: string;
  label: string;
  render?: (row: Record<string, unknown>) => ReactNode;
};

export function ReadonlyOpsView({
  title,
  columns,
  rows,
  empty,
}: {
  title: string;
  columns: OpsColumn[];
  rows: Record<string, unknown>[];
  empty?: ReactNode;
}) {
  const { t } = useAdminI18n();
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">
        {t(title)} ({rows.length})
      </h2>
      <div className="overflow-x-auto border border-white/10">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-white/10 text-xs text-[rgb(170,170,170)]">
            <tr>
              {columns.map((c) => (
                <th key={c.key} className="px-3 py-2 font-medium">
                  {t(c.label)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-6 text-center text-xs text-[rgb(170,170,170)]">
                  {empty ?? t("Empty")}
                </td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr key={index} className="border-b border-white/5 align-top">
                  {columns.map((c) => (
                    <td key={c.key} className="px-3 py-2">
                      {c.render ? c.render(row) : String(row[c.key] ?? "—")}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: 类型检查通过**

Run: `cd packages/main && bunx tsc --noEmit`
Expected: 无本文件相关错误。

- [ ] **Step 3: 提交**

```bash
git add packages/main/src/components/admin/generation/ReadonlyOpsView.tsx
git commit -m "feat(admin): ReadonlyOpsView for read-only ops triage"
```

---

## Task 6: nav 三层拆分（Operations / GenerationOps / Engineering）

**Files:**
- Modify: `packages/main/src/components/admin/nav-config.ts:59-61`（Operations 改名）、`:81-87`（拆 Engineering）、`:103-105`（`FOLDED_GROUP_ORDER`）
- Modify: `packages/main/src/components/admin/nav-config.test.ts:61-64`、`:67-77`、`:113-116`
- Modify: `packages/main/src/components/admin/i18n.tsx:606-612`（zh 组名）

**Interfaces:**
- Produces: 折叠组顺序 `["CharacterConfig","Operations","Media","Business","Insights","GenerationOps","Engineering","System"]`；`Operations`={generation/config,recipes,presets}；`GenerationOps`={generation/jobs,generation/dead-letter,generation/backends,ops/providers}；`Engineering`={generation/workflows,generation/metrics}。

- [ ] **Step 1: 先改测试为新预期（红）**

在 `nav-config.test.ts`：
- 把 `NAV_GROUP_ORDER` 断言（约 :61-64）改为：
```ts
expect(NAV_GROUP_ORDER).toEqual([
  "Daily", "CharacterConfig", "Operations", "Media", "Business", "Insights", "GenerationOps", "Engineering", "System",
]);
```
- 把 `idsInGroup` 成员块（约 :67-77）中 `GenerationConfig` 改为 `Operations`（同样 3 个 id），并新增两组断言：
```ts
expect(idsInGroup("Operations")).toEqual(["generation/config", "generation/recipes", "generation/presets"]);
expect(idsInGroup("GenerationOps")).toEqual([
  "generation/jobs", "generation/dead-letter", "generation/backends", "ops/providers",
]);
expect(idsInGroup("Engineering")).toEqual(["generation/workflows", "generation/metrics"]);
```
- 把 folded-group 顺序断言（约 :113-116）改为：
```ts
expect(names).toEqual([
  "CharacterConfig", "Operations", "Media", "Business", "Insights", "GenerationOps", "Engineering", "System",
]);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/main && bunx vitest run src/components/admin/nav-config.test.ts`
Expected: FAIL（当前 group 仍是 GenerationConfig/Engineering）。

- [ ] **Step 3: 改 `nav-config.ts` 的 group 字段**

- `:59-61` 三行 `group: "GenerationConfig"` → `group: "Operations"`。
- `:82-83`（workflows、backends）：workflows 保持 `group: "Engineering"`；backends 改 `group: "GenerationOps"`。
- `:84`（ops/providers）改 `group: "GenerationOps"`。
- `:85-86`（jobs、dead-letter）改 `group: "GenerationOps"`。
- `:87`（metrics）保持 `group: "Engineering"`。
- `FOLDED_GROUP_ORDER`（:103-105）改为：
```ts
const FOLDED_GROUP_ORDER = [
  "CharacterConfig", "Operations", "Media", "Business", "Insights", "GenerationOps", "Engineering", "System",
] as const;
```

- [ ] **Step 4: 加 zh 组名，跑 nav 两个测试**

在 `i18n.tsx` 的 `zh`（组名区 :606-612 附近）增/改：
```ts
"Operations": "运营",
"GenerationOps": "运维",
"Engineering": "工程诊断",
```
（`i18n-nav.test.ts:31-34` 会对每个折叠组要求 `hasAdminZh`，故 Operations/GenerationOps 必须有 zh。）

Run: `cd packages/main && bunx vitest run src/components/admin/nav-config.test.ts src/components/admin/i18n-nav.test.ts`
Expected: PASS（两文件全绿）。

- [ ] **Step 5: 扫残留的旧 group 字符串**

Run: `cd packages/main && grep -rn '"GenerationConfig"' src/components/admin/ || echo OK`
Expected: 仅可能命中 `i18n.tsx` 里旧的 `"GenerationConfig":"…"` zh 条目（可保留，无害）；无其它代码引用。若命中 `AdminConsoleClient.tsx` 等渲染代码，处理掉（组头是数据驱动的 `t(group)`，正常不会命中）。

- [ ] **Step 6: 提交**

```bash
git add packages/main/src/components/admin/nav-config.ts packages/main/src/components/admin/nav-config.test.ts packages/main/src/components/admin/i18n.tsx
git commit -m "feat(admin): split 生成 nav into Operations/GenerationOps/Engineering"
```

---

## Task 7: 模型配置页薄化（`ConfigView`，最重）

**Files:**
- Modify: `packages/main/src/components/admin/AdminConsoleClient.tsx`：`ConfigView`(起 ~3230)、`ConfigOverviewHeader`(~3041)、profile 工作台/卡片区（~2680–3220）
- Consumes: `OperatorFlow`/`OperatorFlowItem` (Task 4)、`FailureReason` (Task 3)、`EngineeringDetails` (Task 2)、`resolveFailureReason` (Task 1)；既有 `openAction`、`dryRunProfileAction`/`publishProfileAction`/`rollbackProfileAction`(3455+)、`profileVerificationSummary`、`selectedProfileId`/`setSelectedProfileId`(来自 `ctx`)。

**必须保留的行为（防回归清单）：**
- 草稿 `dry-run` / `publish` / `rollback` 动作仍经 `openAction(PendingAction)` 走确认弹窗（reason≥3 + confirmText）。
- `publish` 仅在 `profileVerificationSummary(row).blockedReason` 为空时可点（被阻止则禁用）。
- `selectedProfileId` 选择态仍驱动右侧详情。
- draft/active/enabled 状态对应的动作集合不变（见 `profileTableActions` 3366-3413 的现有逻辑）。

**改造目标（结构）：**
1. 顶部保留一行概览（可留 `ConfigOverviewHeader`，但去掉与列表重复的冗余统计；标题文案改走 `t()`——见 Task 13）。
2. 主体用 `OperatorFlow`：
   - `items` = `data.profiles`（草稿优先）映射为 `OperatorFlowItem`：`primary`=人话标签（profile 的 `label`/mode），`secondary`=状态人话（待测试/可发布/已发布/被阻止），`badge`=状态徽章。**不要**把 `profile_...` id / `.safetensors` 放进 primary/secondary。
   - `selectedId`=`selectedProfileId`，`onSelect`=`setSelectedProfileId`。
   - `detail` = 选中 profile 的详情区：
     - 顶部：动作栏（Select 隐含；draft→[Dry Run][Publish(按 blockedReason 禁用)]；active→[Rollback]；enabled→[Disable]），全部经 `openAction`。
     - 若 `blockedReason` 存在：渲染 `<FailureReason code={blockedReason} detail={verificationSummary 文本} />`（人话 + 折叠原码）。
     - 工程标识符（`profile_...` id、`.safetensors` 文件名、workflow 槽位、逐组件校验表、原始 `verificationStatus`）全部塞进一个 `<EngineeringDetails summary={t("Model & workflow details")}>…</EngineeringDetails>`。
3. 删除造成挤压 bug 的自制窄栏两栏布局（由 `OperatorFlow` 的响应式栅格接管）。

- [ ] **Step 1: 改造 `ConfigView` 主体为 `OperatorFlow` 组合**（按上面结构；import 新原语）。保留所有 action 构造器与 `openAction` 调用不变，仅改「壳与文案」。

- [ ] **Step 2: 把工程标识符收进 `EngineeringDetails`**（id/文件名/槽位/组件校验/verificationStatus）。确认运营首屏（未展开时）不出现任何机器码/文件名。

- [ ] **Step 3: 类型检查**

Run: `cd packages/main && bunx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 4: 人工冒烟（关键验收）**

先确保 admin dev 起着（`bun run dev:admin`，:3001）。用浏览器打开 `http://127.0.0.1:3001/admin/generation/config`（中文）：
- 列表→选中→详情 走得通；
- 首屏无 `profile_...`/`.safetensors`/`missing_flux2_...`（这些只在展开"工程详情"后可见）；
- 被阻止的 profile 显示人话原因（"模型文件未就绪…"）；
- 右侧不再出现单字符竖排（布局不塌）；
- draft 的 Publish 在被阻止时禁用，dry-run/publish/rollback 弹窗照常。

- [ ] **Step 5: 提交**

```bash
git add packages/main/src/components/admin/AdminConsoleClient.tsx
git commit -m "refactor(admin): model-profiles page onto OperatorFlow, fold jargon"
```

---

## Task 8: 提示词配方页薄化（`PromptRecipesView` 3321）

**Files:**
- Modify: `packages/main/src/components/admin/AdminConsoleClient.tsx:3321-3352`
- Consumes: `OperatorFlow` (Task 4)、`EngineeringDetails` (Task 2)、既有 `recipeTableActions`(3416)、`RecipeDraftForm`、`openAction`、`recipeDraft`/`setRecipeDraft`/`createRecipe`（来自 props）。

**保留行为：** 建草稿表单（`RecipeDraftForm`）不变；draft→Publish、active→Rollback 经 `openAction` 不变。

**目标：** 用 `OperatorFlow` 替换现在的 `DataTable`：
- `items` = `data.recipes` → `primary`=`label`，`secondary`=`useCase`+状态人话，`badge`=状态徽章。
- `detail` = 选中 recipe 的动作栏（Publish/Rollback）+ `<EngineeringDetails summary={t("Recipe details")}>` 内放 `id`、`recipeKey`、`mode` 等原始字段。
- 顶部保留 `RecipeDraftForm`。

- [ ] **Step 1: 改 `PromptRecipesView` 用 `OperatorFlow`**（本地 `useState` 选中态即可，因无跨 section 需求；或复用现有 selection 机制）。原始 `id/recipeKey` 进 `EngineeringDetails`。

- [ ] **Step 2: 类型检查**

Run: `cd packages/main && bunx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: 人工冒烟**

浏览器 `http://127.0.0.1:3001/admin/generation/recipes`（中文）：列表→选中→Publish/Rollback 走得通；首屏无 `recipeKey`/raw id；建草稿表单可用。

- [ ] **Step 4: 提交**

```bash
git add packages/main/src/components/admin/AdminConsoleClient.tsx
git commit -m "refactor(admin): recipes page onto OperatorFlow, fold raw keys"
```

---

## Task 9: 预设页薄化（`GenerationPresetsView` 3354）

**Files:**
- Modify: `packages/main/src/components/admin/AdminConsoleClient.tsx:3354-3363`
- Consumes: `OperatorFlow` (Task 4)、`EngineeringDetails` (Task 2)。

**说明：** 预设当前只读（无动作）。用 `OperatorFlow` 展示：`primary`=`label`，`secondary`=`category`+`visibility`+状态；`detail`=只读详情，原始 `id`/`type` 进 `EngineeringDetails`。无写操作。

- [ ] **Step 1: 改 `GenerationPresetsView` 用 `OperatorFlow`**（只读 detail）。

- [ ] **Step 2: 类型检查**

Run: `cd packages/main && bunx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: 人工冒烟**

浏览器 `http://127.0.0.1:3001/admin/generation/presets`（中文）：列表→选中→只读详情；首屏无 raw id/type；无英文残留（除折叠区标识符）。

- [ ] **Step 4: 提交**

```bash
git add packages/main/src/components/admin/AdminConsoleClient.tsx
git commit -m "refactor(admin): presets page onto OperatorFlow (read-only)"
```

---

## Task 10: 任务·事故页（`JobsView` 2445）接 `ReadonlyOpsView`

**Files:**
- Modify: `packages/main/src/components/admin/AdminConsoleClient.tsx`：`JobsView`(2445) 及其 render 调用（`renderSection` :2205 `<JobsView rows … openAction … />`）
- Consumes: `ReadonlyOpsView`/`OpsColumn` (Task 5)、`FailureReason` (Task 3)。

**目标：** 用 `ReadonlyOpsView` 展示 jobs：列 = 角色/时间/状态；失败行的"状态"列用 `render` 出 `<FailureReason code={row.failureMode ?? row.error} detail={原始 error 文本} />`。jobId、原始 error 只在 `FailureReason` 的折叠区。保留 `openAction`（若现有有"打开任务"动作，作为一列的按钮保留）。

- [ ] **Step 1: 改 `JobsView` 用 `ReadonlyOpsView`**（定义 `OpsColumn[]`，失败列走 `FailureReason`）。

- [ ] **Step 2: 类型检查**

Run: `cd packages/main && bunx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: 人工冒烟**

浏览器 `http://127.0.0.1:3001/admin/generation/jobs`（中文）：失败任务显示人话原因；jobId/原始 error 仅在折叠区；表格窄屏横滚不塌。

- [ ] **Step 4: 提交**

```bash
git add packages/main/src/components/admin/AdminConsoleClient.tsx
git commit -m "refactor(admin): jobs page onto ReadonlyOpsView + FailureReason"
```

---

## Task 11: 死信页（`DeadLetterView` 5618）接 `ReadonlyOpsView`

**Files:**
- Modify: `packages/main/src/components/admin/AdminConsoleClient.tsx`：`DeadLetterView`(5618) 及 render 调用（:2277）
- Consumes: `ReadonlyOpsView` (Task 5)、`FailureReason` (Task 3)。

**目标：** 死信列表用 `ReadonlyOpsView`；每条失败消息用 `FailureReason` 出人话摘要；queue payload / 原始 error 进折叠区。保留既有 `openAction`（如"重投/查看"）。

- [ ] **Step 1: 改 `DeadLetterView` 用 `ReadonlyOpsView`。**

- [ ] **Step 2: 类型检查**

Run: `cd packages/main && bunx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: 人工冒烟**

浏览器 `http://127.0.0.1:3001/admin/generation/dead-letter`（中文）：人话摘要在前，payload 折叠。

- [ ] **Step 4: 提交**

```bash
git add packages/main/src/components/admin/AdminConsoleClient.tsx
git commit -m "refactor(admin): dead-letter page onto ReadonlyOpsView + FailureReason"
```

---

## Task 12: 后端 / 供应商健康接 `ReadonlyOpsView`

**Files:**
- Modify: `packages/main/src/components/admin/BackendsView.tsx`
- Consumes: `ReadonlyOpsView` (Task 5)、`FailureReason` (Task 3)。

**目标：** `BackendsView` 用 `ReadonlyOpsView`：列 = 名称 / 健康(✓✗) / 延迟；`!health.ok` 时用 `<FailureReason code={backend.health.detail} />` 出人话；`endpoint`/`cliPath` 进 `EngineeringDetails`（或 FailureReason 折叠区）。ops/providers（Provider Health）若为独立视图，同法处理；否则跳过。保持零写操作 + 手动 Refresh。

- [ ] **Step 1: 改 `BackendsView` 用 `ReadonlyOpsView` + `FailureReason`。** 保留 Refresh 按钮与 `apiGet("/api/v1/admin/generation/backends")` 拉取。

- [ ] **Step 2: 类型检查**

Run: `cd packages/main && bunx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: 人工冒烟**

浏览器 `http://127.0.0.1:3001/admin/generation/backends`（中文）：健康✓✗ + 延迟；失败出人话；endpoint/cliPath 折叠。

- [ ] **Step 4: 提交**

```bash
git add packages/main/src/components/admin/BackendsView.tsx
git commit -m "refactor(admin): backends onto ReadonlyOpsView + FailureReason"
```

---

## Task 13: i18n 补齐 + 逐页 zh 验收 + `bun run check` 绿

**Files:**
- Modify: `packages/main/src/components/admin/i18n.tsx`（`zh` + `zhColumns`）

**目标：** 补齐所有新引入 + 既有残留英文的 zh 译文，中文模式下运营区+运维区无英文残留（折叠区标识符除外）。

- [ ] **Step 1: 补 `zh`（标题/正文/按钮，起 i18n.tsx:9）** —— 至少包含：
```ts
// 原语文案
"Engineering details": "工程详情",
"Technical detail": "技术详情",
"Nothing here yet.": "暂无内容",
"Model & workflow details": "模型与工作流详情",
"Recipe details": "配方详情",
// failureReasons 文案
"Model files not ready": "模型文件未就绪",
"Missing runtime components — needs engineering": "缺运行组件，需工程处理",
"Generation timed out": "生成超时",
"Safe to retry": "可重试",
"Backend unreachable": "后端不可达",
"Check backend health — needs engineering": "检查后端健康，需工程处理",
"Unknown error": "未知错误",
"Share the error code with engineering": "请把错误代码给工程",
// config 页残留英文（实机确认缺失）
"Built-in profiles, test, publish, monitor": "内置模型档：测试、发布、监控",
"Operate seeded generation profiles here; model files and runner templates stay in engineering-owned config.":
  "在此测试并发布内置生成档；模型文件与运行模板归工程配置。",
"Drafts are seeded from built-in profiles so operators can test readiness without managing model files.":
  "草稿由内置档生成，运营无需管理模型文件即可测试就绪度。",
"Verification status missing · No component status recorded": "校验状态缺失 · 无组件状态记录",
```
（其余在 Step 3 冒烟时逐条补。）

- [ ] **Step 2: 补 `zhColumns`（表头，i18n.tsx:648）** —— recipes/presets/ops 用到的列键：
```ts
"recipeKey": "配方标识",
"useCase": "用途",
"mode": "模式",
"visibility": "可见性",
"category": "类别",
"version": "版本",
```
（`id`/`type` 等标识符类若仍作列出现，考虑移入折叠区而非翻译。）

- [ ] **Step 3: 逐页 zh 冒烟（收尾验收）**

admin dev（:3001）中文模式逐页看：`/admin/generation/{config,recipes,presets,jobs,dead-letter,backends}`。每页确认：无英文残留（折叠区标识符除外）、无机器码露首屏、动作可走、布局不塌。发现漏译当场补进 `zh`/`zhColumns`。

- [ ] **Step 4: nav 测试仍绿**

Run: `cd packages/main && bunx vitest run src/components/admin/nav-config.test.ts src/components/admin/i18n-nav.test.ts src/components/admin/generation/failureReasons.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量 check 绿**

Run: `bun run check`（root）
Expected: lint + typecheck + build 全绿。

- [ ] **Step 6: 提交**

```bash
git add packages/main/src/components/admin/i18n.tsx
git commit -m "i18n(admin): fill zh for 生成 group; no English leakage on operator surface"
```

---

## Self-Review（已核对 spec，供评审参考）

- **Spec §4.1 三层 IA** → Task 6。
- **Spec §4.2 四原语** → Task 2/3/4/5。
- **Spec §4.3 failureReasons** → Task 1。
- **Spec §4.4 每页薄化** → Task 7（config）/8（recipes）/9（presets）/10（jobs）/11（dead-letter）/12（backends+providers）；workflows/metrics 原样（不建任务）。
- **Spec §4.5 i18n** → Task 13。
- **Spec §4.6 布局修复** → Task 4（OperatorFlow 栅格）+ Task 5（overflow-x-auto）+ Task 7 Step 4 验收。
- **Spec §5 测试** → 纯逻辑单测（Task 1、6）+ 人工冒烟（Task 7–13）；**偏离**：无 DOM 渲染测试（仓库无基建，见 Global Constraints 说明）。
- **Type consistency**：`resolveFailureReason`/`FailureReason`/`OperatorFlowItem`/`OpsColumn` 在 Task 1/3/4/5 定义，Task 7–12 按此消费，签名一致。
- **已知风险**：Task 7（config）体量最大，Step 4 冒烟是主要防回归手段；每次 vitest 依赖 PG(5433)。
