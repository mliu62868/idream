# Admin 运营 UX 重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 后台表现层重建：浅色编辑部风设计系统（token + 原语）+ 内容页「列表/详情/新建」路由级三件套。

**Architecture:** CSS 变量 token 挂在 admin app 全局样式；一套共享页面原语（`components/admin/ui/`）承载全部风格规则；`parseAdminPath` 扩展 catch-all 路由支持 `/new` 与 `/<id>` 子视图；七个内容资产页重建为薄页面三件套，其余页面机械换 token 皮。Spec: `docs/superpowers/specs/2026-07-10-admin-operator-ux-redesign-design.md`。

**Tech Stack:** Next.js 16 App Router (React 19, client components), Tailwind v4 (任意值引用 CSS 变量), Lucide, vitest。

## Global Constraints

- TypeScript strict，禁 `any`；named exports；2 空格缩进；PascalCase 组件。
- 颜色**只**许用 `--ad-*` token（如 `bg-[var(--ad-surface)]`）；禁止新增 `rgb(18,18,18)`、`border-white/10` 等暗色硬编码。
- 圆角：卡片/区块 `rounded-lg`，按钮/输入 `rounded-md`；阴影只允许 hover 时 `shadow-[var(--ad-shadow-hover)]`。
- 图标只用 Lucide；不引入新 UI 依赖。
- 运营面文案全部过 `t()`，且每个新 key 在 `i18n.tsx` 的 `zh` 表加中文（英文 key 即原文）。
- 写操作后端契约不变：body 携带 `reason`（≥3 字符）；破坏性操作（下线/归档/回滚/停用）在 ConfirmDialog 里额外输入**实体名称**确认；普通写操作只填 reason。
- 不改任何 API / Prisma schema / server 代码（`src/server/**` 只读）。
- 每个任务收尾：`cd /Users/kk/code/idream/packages/main && bun run lint && bun run typecheck` 全绿再 commit。
- 每个 Phase 收尾：仓库根 `bun run check` 全绿。
- Commit message 用 conventional commits（`feat:`/`refactor:`/`docs:`），不加 attribution。

## 关键路径与既有事实（工人必读）

- Admin 前端组件全在 `packages/main/src/components/admin/`；admin app 壳在 `packages/admin/`（catch-all `packages/admin/src/app/admin/[[...section]]/page.tsx` 把 URL 段传给 `AdminConsoleClient` 的 `initialSection`，每次导航是整页加载，无客户端路由状态）。
- `AdminConsoleClient.tsx`（7739 行）：`sectionId = normalizeSection(initialSection)` → `fetchSection(sectionId)` → `renderSection(...)`。自取数视图走 `section.kind === "selfFetch"` 分支。
- i18n：`i18n.tsx` 导出 `useAdminI18n()`（`{ t, value }`）与 `hasAdminZh(key)`；`zh` 是一张 `Record<string,string>`，`t()` 查不到回退英文 key。
- 测试：vitest，跑法 `cd packages/main && bunx vitest run src/components/admin/<file>.test.ts`。现有 `nav-config.test.ts`、`i18n-nav.test.ts`、`generation/failureReasons.test.ts` 全是纯逻辑测试（无 React 渲染测试基建，组件靠 typecheck/build + 浏览器冒烟验证）。
- 既有生成组原语（保留动线，皮肤在 Task 8 换）：`generation/OperatorFlow.tsx`、`generation/ReadonlyOpsView.tsx`、`generation/FailureReason.tsx`、`generation/EngineeringDetails.tsx`。
- 相关 API 端点（全部已存在，`src/server/modules/admin/service.ts` 派发）：

| 资源 | 端点 |
|---|---|
| 官方角色 | GET/POST `/api/v1/admin/content/official`；PATCH `/official/:id`；POST `/official/:id/state`（body `{status:"approved"\|"archived", reason}`） |
| 角色模板 | GET/POST `/api/v1/admin/content/templates`；PATCH `/templates/:id`；POST `/templates/:id/active`（body `{active, reason}`） |
| AI 辅助 | POST `/api/v1/admin/content/character-assist`（body `{seed}` → `{description, advancedDetails:{personality}}`） |
| Recipes | GET/POST `/api/v1/admin/generation/recipes`；PATCH `/recipes/:id`；POST `/recipes/:id/publish`（body 另含 `confirmation`、`dryRunSummary:{source:"admin_console"}`）；POST `/recipes/:id/rollback` |
| Presets | GET/POST `/api/v1/admin/generation/presets`；PATCH `/presets/:id` |
| 图片资产 | GET `/api/v1/admin/content/assets?status=&purpose=&…`；PATCH `/assets/:id` |
| Placements | GET/POST `/api/v1/admin/content/placements`；PATCH `/placements/:id` |
| Tags | GET `/api/v1/admin/content/tags`；PATCH `/tags/:id`；POST `/tags/merge` |

- 冒烟：`bun run dev:admin`（仓库根）起 admin 于 `http://127.0.0.1:3001/admin`，本地 dev-login 可用。

## File Structure（本计划锁定的分解）

```
packages/admin/src/app/globals.css          # M: 追加 --ad-* token
packages/admin/src/app/layout.tsx           # M: 去掉 html 的 "dark" class
packages/main/src/components/admin/
  ui/                                       # C: 共享原语（每文件一职责）
    status-tone.ts + status-tone.test.ts
    StatusPill.tsx  EmptyState.tsx  buttons.tsx
    PageHeader.tsx  FilterBar.tsx
    DataTable.tsx   CardGrid.tsx
    FormPage.tsx    DetailPage.tsx  ConfirmDialog.tsx
    AssetImage.tsx                          # C: 自 ContentOpsViews 迁入（Task 16）
  nav-config.ts                             # M: parseAdminPath + SUBVIEW_SECTIONS
  nav-config.test.ts                        # M: parseAdminPath 测试
  AdminConsoleClient.tsx                    # M: subview 接线、壳换皮、瘦身（recipes/presets 迁出）
  official/  official-api.ts OfficialSection.tsx OfficialListPage.tsx
             OfficialDetailPage.tsx OfficialNewPage.tsx   # C: 三件套样板
  starters/  starters-api.ts StartersSection.tsx StartersListPage.tsx
             StartersDetailPage.tsx StartersNewPage.tsx    # C
  recipes/   recipes-api.ts RecipesSection.tsx RecipesListPage.tsx
             RecipesDetailPage.tsx RecipesNewPage.tsx      # C
  presets/   presets-api.ts PresetsSection.tsx PresetsListPage.tsx
             PresetsDetailPage.tsx PresetsNewPage.tsx      # C
  assets/    AssetsSection.tsx AssetsListPage.tsx AssetsDetailPage.tsx  # C
  placements/ PlacementsSection.tsx …                      # C
  OfficialCharactersView.tsx TemplatesView.tsx             # D: 三件套落地后删除
  其余 *View.tsx                                            # M: 机械换 token 皮
```

---

# Phase 1 — 基座（token / 原语 / 路由 / 换皮）

### Task 1: 设计 token + 亮色根

**Files:**
- Modify: `packages/admin/src/app/globals.css`
- Modify: `packages/admin/src/app/layout.tsx`

**Interfaces:**
- Produces: CSS 变量 `--ad-canvas/--ad-surface/--ad-ink/--ad-text/--ad-text-muted/--ad-border/--ad-{green,yellow,red,blue}-{bg,text}/--ad-shadow-hover`，全后台任意组件可用 `var(--ad-*)` 引用。

- [ ] **Step 1: 在 globals.css 追加 token**

现内容是三行 `@source`/`@import`，在文件**末尾**追加：

```css

/* SPEC: admin 浅色编辑部风 design tokens（SSoT）。全后台颜色只许引用这些变量。
   INVARIANTS: 不定义暗色变体——admin 只有亮色一种主题。 */
:root {
  --ad-canvas: #f7f6f3;
  --ad-surface: #ffffff;
  --ad-ink: #111111;
  --ad-text: #2f3437;
  --ad-text-muted: #787774;
  --ad-border: #eaeaea;
  --ad-green-bg: #edf3ec;
  --ad-green-text: #346538;
  --ad-yellow-bg: #fbf3db;
  --ad-yellow-text: #956400;
  --ad-red-bg: #fdebec;
  --ad-red-text: #9f2f2d;
  --ad-blue-bg: #e1f3fe;
  --ad-blue-text: #1f6c9f;
  --ad-shadow-hover: 0 2px 8px rgba(0, 0, 0, 0.04);
}

body {
  background: var(--ad-canvas);
  color: var(--ad-text);
}
```

- [ ] **Step 2: layout.tsx 去掉 dark class**

`packages/admin/src/app/layout.tsx` 中：

```tsx
    <html lang="en" className="dark h-full antialiased">
```
改为
```tsx
    <html lang="en" className="h-full antialiased">
```

- [ ] **Step 3: 验证 + 提交**

Run: `cd /Users/kk/code/idream/packages/admin && bun run lint && bun run typecheck`
Expected: PASS（css/类名改动不产生类型错）

```bash
git add packages/admin/src/app/globals.css packages/admin/src/app/layout.tsx
git commit -m "feat(admin): light editorial design tokens (--ad-*) + drop dark root"
```

（此时页面处于明暗混杂中间态，属预期；Task 7/8 完成换皮后消失。）

---

### Task 2: status-tone 逻辑（TDD）+ StatusPill + EmptyState

**Files:**
- Create: `packages/main/src/components/admin/ui/status-tone.ts`
- Create: `packages/main/src/components/admin/ui/status-tone.test.ts`
- Create: `packages/main/src/components/admin/ui/StatusPill.tsx`
- Create: `packages/main/src/components/admin/ui/EmptyState.tsx`

**Interfaces:**
- Produces: `statusTone(status: string): StatusTone`；`<StatusPill status={string} label?={string} />`；`<EmptyState title hint? action? />`。后续所有列表/详情页依赖这三者。

- [ ] **Step 1: 写失败测试** `ui/status-tone.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { statusTone } from "./status-tone";

describe("statusTone", () => {
  it("maps live/positive states to success", () => {
    for (const s of ["approved", "active", "published", "succeeded", "ready"]) {
      expect(statusTone(s)).toBe("success");
    }
  });
  it("maps waiting states to pending", () => {
    for (const s of ["draft", "pending", "in_review", "queued", "paused"]) {
      expect(statusTone(s)).toBe("pending");
    }
  });
  it("maps real failures to danger — red is reserved for errors", () => {
    for (const s of ["failed", "rejected", "removed", "blocked"]) {
      expect(statusTone(s)).toBe("danger");
    }
  });
  it("maps in-flight states to info", () => {
    for (const s of ["running", "processing", "generating"]) {
      expect(statusTone(s)).toBe("info");
    }
  });
  it("is case-insensitive and defaults to neutral", () => {
    expect(statusTone("APPROVED")).toBe("success");
    expect(statusTone("archived")).toBe("neutral");
    expect(statusTone("whatever")).toBe("neutral");
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `cd /Users/kk/code/idream/packages/main && bunx vitest run src/components/admin/ui/status-tone.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `ui/status-tone.ts`：

```ts
// SPEC: 状态字符串 → 视觉基调。红色只留给真错误（spec §4.1）。
export type StatusTone = "success" | "pending" | "danger" | "info" | "neutral";

const TONE_BY_STATUS: Record<string, StatusTone> = {
  approved: "success", active: "success", published: "success",
  succeeded: "success", ready: "success", enabled: "success",
  draft: "pending", pending: "pending", in_review: "pending",
  queued: "pending", paused: "pending", submitted: "pending",
  failed: "danger", rejected: "danger", removed: "danger", blocked: "danger",
  running: "info", processing: "info", generating: "info",
  archived: "neutral", disabled: "neutral",
};

export function statusTone(status: string): StatusTone {
  return TONE_BY_STATUS[status.toLowerCase()] ?? "neutral";
}
```

- [ ] **Step 4: 跑测确认通过**（同 Step 2 命令）Expected: PASS

- [ ] **Step 5: 写 StatusPill** `ui/StatusPill.tsx`：

```tsx
"use client";
import { cn } from "@/lib/utils";
import { useAdminI18n } from "@/components/admin/i18n";
import { statusTone, type StatusTone } from "./status-tone";

const TONE_CLASSES: Record<StatusTone, string> = {
  success: "bg-[var(--ad-green-bg)] text-[var(--ad-green-text)]",
  pending: "bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]",
  danger: "bg-[var(--ad-red-bg)] text-[var(--ad-red-text)]",
  info: "bg-[var(--ad-blue-bg)] text-[var(--ad-blue-text)]",
  neutral: "bg-black/[0.05] text-[var(--ad-text-muted)]",
};

// SPEC: pastel 状态 pill。label 缺省时用 t(status) 翻译状态词本身。
export function StatusPill({ status, label }: { status: string; label?: string }) {
  const { t } = useAdminI18n();
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.05em]",
        TONE_CLASSES[statusTone(status)],
      )}
    >
      {label ?? t(status)}
    </span>
  );
}
```

- [ ] **Step 6: 写 EmptyState** `ui/EmptyState.tsx`：

```tsx
import type { ReactNode } from "react";

// SPEC: 空态给引导（标题+提示+行动按钮），不是一行灰字（spec §7）。
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] px-6 py-16 text-center">
      <p className="text-sm font-medium text-[var(--ad-ink)]">{title}</p>
      {hint ? <p className="text-xs text-[var(--ad-text-muted)]">{hint}</p> : null}
      {action}
    </div>
  );
}
```

- [ ] **Step 7: lint/typecheck + 提交**

Run: `cd /Users/kk/code/idream/packages/main && bun run lint && bun run typecheck`
Expected: PASS

```bash
git add packages/main/src/components/admin/ui/
git commit -m "feat(admin): ui primitives — statusTone (tested), StatusPill, EmptyState"
```

---

### Task 3: buttons + PageHeader + FilterBar

**Files:**
- Create: `packages/main/src/components/admin/ui/buttons.tsx`
- Create: `packages/main/src/components/admin/ui/PageHeader.tsx`
- Create: `packages/main/src/components/admin/ui/FilterBar.tsx`

**Interfaces:**
- Produces:
  - `PrimaryButton` / `GhostButton` / `DangerButton`：`ButtonHTMLAttributes<HTMLButtonElement>` 直传。
  - `<PageHeader title purpose action? />`（purpose 必填——每页一句话用途是硬规则）。
  - `<FilterBar search onSearch searchPlaceholder selects? />`，`selects: Array<{ name, value, onChange, options: Array<{value,label}> }>`。

- [ ] **Step 1: 写 buttons** `ui/buttons.tsx`：

```tsx
"use client";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const BASE =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.98]";

export function PrimaryButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(BASE, "bg-[var(--ad-ink)] text-white hover:bg-[#333333]", className)}
      {...props}
    />
  );
}

export function GhostButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        BASE,
        "border border-[var(--ad-border)] bg-[var(--ad-surface)] text-[var(--ad-text)] hover:bg-black/[0.03]",
        className,
      )}
      {...props}
    />
  );
}

export function DangerButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        BASE,
        "border border-[var(--ad-red-text)]/20 bg-[var(--ad-red-bg)] text-[var(--ad-red-text)] hover:bg-[#f9dfe1]",
        className,
      )}
      {...props}
    />
  );
}
```

- [ ] **Step 2: 写 PageHeader** `ui/PageHeader.tsx`：

```tsx
import type { ReactNode } from "react";

// SPEC: 每页固定头 —— 页名 + 一句话用途（必填）+ 右侧主动作（spec §4.2）。
export function PageHeader({
  title,
  purpose,
  action,
}: {
  title: string;
  purpose: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight text-[var(--ad-ink)]">{title}</h2>
        <p className="mt-1 text-sm leading-relaxed text-[var(--ad-text-muted)]">{purpose}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
```

- [ ] **Step 3: 写 FilterBar** `ui/FilterBar.tsx`：

```tsx
"use client";
import { Search } from "lucide-react";

export type FilterSelect = {
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
};

// SPEC: 列表页统一筛选条 —— 搜索框 + 若干下拉。全部受控，父组件本地过滤或改查询参数。
export function FilterBar({
  search,
  onSearch,
  searchPlaceholder,
  selects = [],
}: {
  search: string;
  onSearch: (value: string) => void;
  searchPlaceholder: string;
  selects?: FilterSelect[];
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="flex h-9 min-w-[220px] items-center gap-2 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3">
        <Search className="h-4 w-4 shrink-0 text-[var(--ad-text-muted)]" />
        <input
          aria-label={searchPlaceholder}
          className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--ad-text-muted)]"
          onChange={(event) => onSearch(event.target.value)}
          placeholder={searchPlaceholder}
          value={search}
        />
      </div>
      {selects.map((select) => (
        <select
          aria-label={select.name}
          className="h-9 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-2 text-sm text-[var(--ad-text)] outline-none"
          key={select.name}
          onChange={(event) => select.onChange(event.target.value)}
          value={select.value}
        >
          {select.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: lint/typecheck + 提交**

Run: `cd /Users/kk/code/idream/packages/main && bun run lint && bun run typecheck`
Expected: PASS

```bash
git add packages/main/src/components/admin/ui/
git commit -m "feat(admin): ui primitives — buttons, PageHeader, FilterBar"
```

---

### Task 4: DataTable + CardGrid/EntityCard

**Files:**
- Create: `packages/main/src/components/admin/ui/DataTable.tsx`
- Create: `packages/main/src/components/admin/ui/CardGrid.tsx`

**Interfaces:**
- Produces:
  - `<DataTable headers={string[]} rows={DataTableRow[]} empty?={ReactNode} />`，`DataTableRow = { id: string; cells: ReactNode[]; href?: string }`（有 href 整行可点，用于进详情）。
  - `<CardGrid>{children}</CardGrid>` + `<EntityCard href title image? monogram? meta? status? statusLabel? />`。

- [ ] **Step 1: 写 DataTable** `ui/DataTable.tsx`：

```tsx
"use client";
import Link from "next/link";
import type { ReactNode } from "react";

export type DataTableRow = { id: string; cells: ReactNode[]; href?: string };

// SPEC: 编辑部风表格：无竖线、仅底边分隔、宽松行高；有 href 的行整行可点进详情。
export function DataTable({
  headers,
  rows,
  empty,
}: {
  headers: string[];
  rows: DataTableRow[];
  empty?: ReactNode;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--ad-border)] text-xs uppercase tracking-[0.05em] text-[var(--ad-text-muted)]">
            {headers.map((header) => (
              <th className="px-4 py-3 font-medium" key={header}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              className="border-b border-[var(--ad-border)] transition-colors last:border-b-0 hover:bg-black/[0.02]"
              key={row.id}
            >
              {row.cells.map((cell, index) => (
                <td className="px-4 py-3 align-middle" key={index}>
                  {row.href && index === 0 ? (
                    <Link className="block font-medium text-[var(--ad-ink)]" href={row.href}>
                      {cell}
                    </Link>
                  ) : (
                    cell
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: 写 CardGrid/EntityCard** `ui/CardGrid.tsx`：

```tsx
"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { StatusPill } from "./StatusPill";

export function CardGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{children}</div>;
}

// SPEC: 视觉实体卡片 —— 图（或姓名首字 monogram 兜底）+ 名 + 元信息 + 状态 pill。
// INTENT: 角色/图片是视觉内容，浏览必须直接看到图（spec §1.2）。
export function EntityCard({
  href,
  title,
  image,
  meta,
  status,
  statusLabel,
}: {
  href: string;
  title: string;
  image?: string | null;
  meta?: ReactNode;
  status?: string;
  statusLabel?: string;
}) {
  return (
    <Link
      className="group overflow-hidden rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] transition-shadow hover:shadow-[var(--ad-shadow-hover)]"
      href={href}
    >
      <div className="relative aspect-[4/5] overflow-hidden bg-black/[0.03]">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element -- admin 内部工具，blob URL 不走 next/image 优化
          <img alt={title} className="h-full w-full object-cover" loading="lazy" src={image} />
        ) : (
          <div className="grid h-full w-full place-items-center text-4xl font-semibold text-[var(--ad-text-muted)]">
            {title.slice(0, 1).toUpperCase()}
          </div>
        )}
      </div>
      <div className="space-y-1.5 p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm font-semibold text-[var(--ad-ink)]">{title}</p>
          {status ? <StatusPill label={statusLabel} status={status} /> : null}
        </div>
        {meta ? <div className="text-xs text-[var(--ad-text-muted)]">{meta}</div> : null}
      </div>
    </Link>
  );
}
```

- [ ] **Step 3: lint/typecheck + 提交**

Run: `cd /Users/kk/code/idream/packages/main && bun run lint && bun run typecheck`
Expected: PASS

```bash
git add packages/main/src/components/admin/ui/
git commit -m "feat(admin): ui primitives — DataTable, CardGrid/EntityCard"
```

---

### Task 5: FormPage + DetailPage + ConfirmDialog

**Files:**
- Create: `packages/main/src/components/admin/ui/FormPage.tsx`
- Create: `packages/main/src/components/admin/ui/DetailPage.tsx`
- Create: `packages/main/src/components/admin/ui/ConfirmDialog.tsx`

**Interfaces:**
- Produces:
  - `<FormPage backHref title>{sections}</FormPage>` + `<FormSection title hint?>` + `<Field label>{input}</Field>` + `<FormFooter error? notice?>{buttons}</FormFooter>`。
  - `<DetailPage backHref title status? statusLabel? actions?>{children}</DetailPage>` + `<DetailSection title>`。
  - `<ConfirmDialog spec onClose />`，`ConfirmSpec = { title, summary?, destructive?: { expectedName }, submitLabel, onSubmit(reason) }`——**reason 必填 ≥3；destructive 时还要把实体名称打对才可提交**。这是全后台写操作确认的唯一入口（spec §7 降噪规则）。

- [ ] **Step 1: 写 FormPage** `ui/FormPage.tsx`：

```tsx
"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

// SPEC: 全屏专注表单骨架 —— ← 返回 + 标题 + 分组区块 + 底部操作条（spec §7 新建页）。
export function FormPage({
  backHref,
  backLabel,
  title,
  children,
}: {
  backHref: string;
  backLabel: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl">
      <Link
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-[var(--ad-text-muted)] hover:text-[var(--ad-ink)]"
        href={backHref}
      >
        <ArrowLeft className="h-4 w-4" /> {backLabel}
      </Link>
      <h2 className="mb-6 text-xl font-semibold tracking-tight text-[var(--ad-ink)]">{title}</h2>
      <div className="space-y-6">{children}</div>
    </div>
  );
}

export function FormSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6">
      <h3 className="text-sm font-semibold text-[var(--ad-ink)]">{title}</h3>
      {hint ? <p className="mt-1 text-xs text-[var(--ad-text-muted)]">{hint}</p> : null}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

export function Field({
  label,
  full = false,
  children,
}: {
  label: string;
  full?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={full ? "block sm:col-span-2" : "block"}>
      <span className="mb-1.5 block text-xs font-medium text-[var(--ad-text-muted)]">{label}</span>
      {children}
    </label>
  );
}

export function FormFooter({
  error,
  notice,
  children,
}: {
  error?: string | null;
  notice?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="sticky bottom-0 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      {error ? <p className="mb-2 text-sm text-[var(--ad-red-text)]">{error}</p> : null}
      {notice ? <p className="mb-2 text-sm text-[var(--ad-green-text)]">{notice}</p> : null}
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}
```

统一输入样式常量也放这里导出（表单页直接引用）：

```tsx
export const INPUT_CLASS =
  "h-9 w-full rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)] outline-none placeholder:text-[var(--ad-text-muted)] focus:border-[var(--ad-ink)]";
export const TEXTAREA_CLASS =
  "min-h-24 w-full rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 py-2 text-sm text-[var(--ad-text)] outline-none placeholder:text-[var(--ad-text-muted)] focus:border-[var(--ad-ink)]";
```

- [ ] **Step 2: 写 DetailPage** `ui/DetailPage.tsx`：

```tsx
"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { StatusPill } from "./StatusPill";

// SPEC: 详情页骨架 —— ← 返回 + 名字/状态/主动作区 + 分区内容（spec §7 详情页）。
export function DetailPage({
  backHref,
  backLabel,
  title,
  status,
  statusLabel,
  actions,
  children,
}: {
  backHref: string;
  backLabel: string;
  title: string;
  status?: string;
  statusLabel?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-5xl">
      <Link
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-[var(--ad-text-muted)] hover:text-[var(--ad-ink)]"
        href={backHref}
      >
        <ArrowLeft className="h-4 w-4" /> {backLabel}
      </Link>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold tracking-tight text-[var(--ad-ink)]">{title}</h2>
          {status ? <StatusPill label={statusLabel} status={status} /> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      <div className="space-y-6">{children}</div>
    </div>
  );
}

export function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6">
      <h3 className="mb-4 text-sm font-semibold text-[var(--ad-ink)]">{title}</h3>
      {children}
    </section>
  );
}
```

- [ ] **Step 3: 写 ConfirmDialog** `ui/ConfirmDialog.tsx`：

```tsx
"use client";
import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useAdminI18n } from "@/components/admin/i18n";
import { GhostButton, PrimaryButton } from "./buttons";
import { INPUT_CLASS } from "./FormPage";

export type ConfirmSpec = {
  title: string;
  summary?: ReactNode;
  /** 破坏性操作：要求输入实体名称（不再敲内部 ID —— spec §7）。 */
  destructive?: { expectedName: string };
  submitLabel: string;
  onSubmit: (reason: string) => Promise<void>;
};

// SPEC: 全后台写操作统一确认框。reason ≥3 必填（后端审计契约）；
// destructive 时额外要求名称打对。onSubmit 抛错则就地显示，不关框。
export function ConfirmDialog({ spec, onClose }: { spec: ConfirmSpec; onClose: () => void }) {
  const { t } = useAdminI18n();
  const [reason, setReason] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameOk = !spec.destructive || nameInput.trim() === spec.destructive.expectedName;
  const canSubmit = !busy && reason.trim().length >= 3 && nameOk;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await spec.onSubmit(reason.trim());
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t("Request failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/20 p-4">
      <div className="w-full max-w-md rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6">
        <h3 className="text-sm font-semibold text-[var(--ad-ink)]">{spec.title}</h3>
        {spec.summary ? (
          <div className="mt-2 text-sm text-[var(--ad-text-muted)]">{spec.summary}</div>
        ) : null}
        <div className="mt-4 space-y-3">
          <input
            aria-label={t("Reason (≥3)")}
            className={INPUT_CLASS}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("Reason (≥3)")}
            value={reason}
          />
          {spec.destructive ? (
            <input
              aria-label={t("Type the name to confirm")}
              className={INPUT_CLASS}
              onChange={(event) => setNameInput(event.target.value)}
              placeholder={`${t("Type the name to confirm")}: ${spec.destructive.expectedName}`}
              value={nameInput}
            />
          ) : null}
          {error ? <p className="text-sm text-[var(--ad-red-text)]">{error}</p> : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <GhostButton disabled={busy} onClick={onClose}>
            {t("Cancel")}
          </GhostButton>
          <PrimaryButton disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {spec.submitLabel}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: i18n 新 key 补 zh**（`i18n.tsx` 的 `zh` 表按字母序插入）：

```
"Type the name to confirm": "输入名称以确认",
```
（`"Reason (≥3)"`、`"Cancel"`、`"Request failed"` 已存在，勿重复。）

- [ ] **Step 5: lint/typecheck + 提交**

Run: `cd /Users/kk/code/idream/packages/main && bun run lint && bun run typecheck`
Expected: PASS

```bash
git add packages/main/src/components/admin/ui/ packages/main/src/components/admin/i18n.tsx
git commit -m "feat(admin): ui primitives — FormPage, DetailPage, ConfirmDialog"
```

---

### Task 6: parseAdminPath（TDD）+ AdminConsoleClient 接线

**Files:**
- Modify: `packages/main/src/components/admin/nav-config.ts:113-124`（normalizeSection 区域）
- Modify: `packages/main/src/components/admin/nav-config.test.ts`
- Modify: `packages/main/src/components/admin/AdminConsoleClient.tsx:640`（sectionId 派生）与 `:2182`（renderSection 签名）

**Interfaces:**
- Consumes: `packages/admin/.../[[...section]]/page.tsx` 传 `initialSection={section.join("/") || "dashboard"}`（已确认，无需改 admin 壳）。
- Produces:
  - `type AdminSubview = { kind: "list" } | { kind: "new" } | { kind: "detail"; id: string }`
  - `parseAdminPath(value: string): { sectionId: string; view: AdminSubview }`
  - `normalizeSection(value)` 保持旧签名（= `parseAdminPath(value).sectionId`），旧测试不破。
  - `renderSection(section, subview: AdminSubview, ctx)` —— 后续三件套任务只在 selfFetch 分支消费 `subview`。

- [ ] **Step 1: 写失败测试**（`nav-config.test.ts` 末尾追加）：

```ts
import { parseAdminPath } from "./nav-config";

describe("parseAdminPath (list/new/detail subviews)", () => {
  const SUBVIEW_IDS = [
    "content/official", "content/templates", "generation/recipes",
    "generation/presets", "content/assets", "content/placements",
  ];

  it("known section ids resolve to list view", () => {
    for (const item of navItems) {
      expect(parseAdminPath(item.id)).toEqual({ sectionId: item.id, view: { kind: "list" } });
    }
  });

  it("<section>/new resolves to new view for every subview section", () => {
    for (const id of SUBVIEW_IDS) {
      expect(parseAdminPath(`${id}/new`)).toEqual({ sectionId: id, view: { kind: "new" } });
    }
  });

  it("<section>/<id> resolves to detail view with the id", () => {
    for (const id of SUBVIEW_IDS) {
      expect(parseAdminPath(`${id}/abc123`)).toEqual({
        sectionId: id,
        view: { kind: "detail", id: "abc123" },
      });
    }
  });

  it("extra segments on non-subview sections fall back to dashboard", () => {
    expect(parseAdminPath("users/abc")).toEqual({
      sectionId: "dashboard",
      view: { kind: "list" },
    });
    expect(parseAdminPath("nope/nope/nope")).toEqual({
      sectionId: "dashboard",
      view: { kind: "list" },
    });
  });

  it("keeps the generation/models alias working", () => {
    expect(parseAdminPath("generation/models").sectionId).toBe("generation/config");
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `cd /Users/kk/code/idream/packages/main && bunx vitest run src/components/admin/nav-config.test.ts`
Expected: FAIL（parseAdminPath 未导出）

- [ ] **Step 3: 实现**（`nav-config.ts`，替换现有 `normalizeSection`，保留其上方的 `KNOWN_SECTION_IDS`/`SECTION_ALIASES`）：

```ts
export type AdminSubview =
  | { kind: "list" }
  | { kind: "new" }
  | { kind: "detail"; id: string };

export type AdminPath = { sectionId: string; view: AdminSubview };

// SPEC: 支持 /new 与 /<id> 子视图的三件套 section（spec §6.1/§6.2）。
const SUBVIEW_SECTIONS = new Set([
  "content/official", "content/templates", "generation/recipes",
  "generation/presets", "content/assets", "content/placements",
]);

// SPEC: 路由解析 —— 已知 id → list；<三件套 id>/new → new；<三件套 id>/<id> → detail；
// 其余一律回 dashboard（沿用旧不变式）。"new" 是保留字，不能作实体 id。
export function parseAdminPath(value: string): AdminPath {
  const mapped = SECTION_ALIASES[value] ?? value;
  if (KNOWN_SECTION_IDS.has(mapped)) return { sectionId: mapped, view: { kind: "list" } };
  const segments = mapped.split("/").filter(Boolean);
  if (segments.length >= 2) {
    const last = segments[segments.length - 1];
    const prefixRaw = segments.slice(0, -1).join("/");
    const prefix = SECTION_ALIASES[prefixRaw] ?? prefixRaw;
    if (SUBVIEW_SECTIONS.has(prefix) && KNOWN_SECTION_IDS.has(prefix) && last.length > 0) {
      if (last === "new") return { sectionId: prefix, view: { kind: "new" } };
      return { sectionId: prefix, view: { kind: "detail", id: last } };
    }
  }
  return { sectionId: "dashboard", view: { kind: "list" } };
}

// SPEC: 兼容旧签名；navItems 仍是已知 id 的 SSoT。
export function normalizeSection(value: string): string {
  return parseAdminPath(value).sectionId;
}
```

- [ ] **Step 4: 跑测确认通过**（Step 2 命令 + 全量 `bunx vitest run src/components/admin/`）Expected: PASS（含旧 normalizeSection 测试）

- [ ] **Step 5: AdminConsoleClient 接线**

`AdminConsoleClient.tsx:640` 附近：

```ts
// 旧
const sectionId = normalizeSection(initialSection);
// 新
const { sectionId, view: subview } = parseAdminPath(initialSection);
```

import 行加 `parseAdminPath` 与 `type AdminSubview`。`renderSection` 签名（`:2182`）加第二参数：

```ts
function renderSection(
  section: SectionData | null,
  subview: AdminSubview,
  ctx: { ... 原样 ... },
)
```

调用点（JSX 里 `renderSection(filteredData, {...})`，搜索 `renderSection(`）同步传 `subview`。本任务不改任何分支行为——subview 暂时无人消费。

- [ ] **Step 6: lint/typecheck + 提交**

Run: `cd /Users/kk/code/idream/packages/main && bun run lint && bun run typecheck && bunx vitest run src/components/admin/`
Expected: PASS

```bash
git add packages/main/src/components/admin/nav-config.ts packages/main/src/components/admin/nav-config.test.ts packages/main/src/components/admin/AdminConsoleClient.tsx
git commit -m "feat(admin): parseAdminPath — route-level list/new/detail subviews"
```

---

### Task 7: 壳换皮（sidebar / topbar / 全局容器）

**Files:**
- Modify: `packages/main/src/components/admin/AdminConsoleClient.tsx`（壳 JSX：根容器、`<aside>` 侧栏、sticky `<header>`、移动端 nav、错误横幅、`NavLink`(:1205)、PendingAction 对话框容器）
- Modify: `packages/admin/src/app/admin/AdminConsoleClientOnly.tsx`（loading 骨架）

**Interfaces:**
- Consumes: Task 1 的 `--ad-*` token。
- Produces: **换皮映射表（本表是 Task 8 的 SSoT，两任务共用）**：

| 旧 | 新 |
|---|---|
| `bg-[rgb(13,13,13)]` | `bg-[var(--ad-canvas)]` |
| `bg-[rgba(13,13,13,0.92)]` | `bg-[rgba(247,246,243,0.92)]` |
| `bg-[rgb(18,18,18)]` | `bg-[var(--ad-surface)]` |
| `border-white/10` `border-white/15` `border-white/20` | `border-[var(--ad-border)]` |
| 选中态 `border-white/40 bg-white/10` | `border-[var(--ad-ink)] bg-black/[0.04]` |
| `text-white`（正文/标题） | `text-[var(--ad-ink)]`；**例外**：黑底主按钮内的白字保留 |
| `text-[rgb(230,230,230)]` | `text-[var(--ad-text)]` |
| `text-[rgb(170,170,170)]` `text-[rgb(114,113,112)]` | `text-[var(--ad-text-muted)]` |
| `bg-white/10` | `bg-black/[0.05]` |
| `bg-white/5` `bg-white/[0.04]` | `bg-black/[0.03]` |
| `hover:bg-white/10` `hover:bg-white/5` | `hover:bg-black/[0.04]` |
| 活跃项 `bg-white text-black` | `bg-[var(--ad-ink)] text-white` |
| `border-red-400/30 bg-red-950/30 text-red-100`（错误横幅） | `border-[var(--ad-red-text)]/20 bg-[var(--ad-red-bg)] text-[var(--ad-red-text)]` |
| `border-amber-400/30 bg-amber-950/20`（确认区） | `border-[var(--ad-yellow-text)]/20 bg-[var(--ad-yellow-bg)]` |
| `text-amber-*` / `text-red-200|300` / `text-emerald-*` | `text-[var(--ad-yellow-text)]` / `text-[var(--ad-red-text)]` / `text-[var(--ad-green-text)]` |
| `bg-emerald-950/*` | `bg-[var(--ad-green-bg)]` |
| 暗色 `<option className="bg-[rgb(18,18,18)] text-white">` | 删掉 className（亮色默认即可） |
| 圆角规则 | 有 `border` 的容器区块补 `rounded-lg`；`inline-flex h-9` 的按钮/输入补 `rounded-md` |

- [ ] **Step 1: 应用映射表到壳区域**（`AdminConsoleClient.tsx` 的 return JSX 中：根 `<main>`、`<aside>`、`<header>`、移动端 `<nav>`、内容容器、错误横幅、PendingAction 对话框、`NavLink` 函数）。侧栏改白色表面：`<aside>` 用 `border-r border-[var(--ad-border)] bg-[var(--ad-surface)]`。

- [ ] **Step 2: AdminConsoleClientOnly 的 loading 骨架同表换皮**（`bg-[rgb(13,13,13)]`→canvas、`bg-[rgb(18,18,18)]`→surface、`border-white/10`→border token、`bg-white/[0.04]`→`bg-black/[0.03]`、`text-white` 删）。

- [ ] **Step 3: 验证 + 提交**

Run: `cd /Users/kk/code/idream/packages/main && bun run lint && bun run typecheck`
Expected: PASS

```bash
git add packages/main/src/components/admin/AdminConsoleClient.tsx packages/admin/src/app/admin/AdminConsoleClientOnly.tsx
git commit -m "refactor(admin): reskin console shell to light editorial tokens"
```

---

### Task 8: 全量视图机械换皮（映射表扫一遍）

**Files（Modify，按 Task 7 映射表逐文件过）:**
- `AdminConsoleClient.tsx`（壳以外的全部视图函数）
- `AdminDevLogin.tsx`、`AnnouncementsView.tsx`、`BackendsView.tsx`、`CharacterPregenPanel.tsx`、`ChatImageToolPanel.tsx`、`CmsView.tsx`、`ComplianceView.tsx`、`ContentOpsViews.tsx`、`ExperimentsView.tsx`、`GenerationMetricsView.tsx`、`ImageProductionView.tsx`、`InsightsView.tsx`、`OfficialCharactersView.tsx`、`ReviewQueueView.tsx`、`TagsView.tsx`、`TemplatesView.tsx`、`VisualPassportPanel.tsx`、`WorkflowsView.tsx`
- `generation/OperatorFlow.tsx`、`generation/ReadonlyOpsView.tsx`、`generation/EngineeringDetails.tsx`、`generation/FailureReason.tsx`

（OfficialCharactersView/TemplatesView 之后会被三件套替换删除，但为保证 Phase 1 收尾时全后台观感一致，本任务照扫。）

- [ ] **Step 1: 逐文件应用映射表**。规则性替换用编辑器完成；**语义例外**只有两类：黑底主按钮里的 `text-white` 保留；`bg-white text-black` 活跃态按表改为 `bg-[var(--ad-ink)] text-white`。

- [ ] **Step 2: 验证零残留（本步是硬门槛）**

Run:
```bash
grep -rn "rgb(18,18,18)\|rgb(13,13,13)\|border-white/\|bg-white/\|hover:bg-white/\|text-\[rgb(170,170,170)\]\|text-\[rgb(230,230,230)\]\|text-\[rgb(114,113,112)\]\|red-950\|amber-950\|emerald-950" \
  packages/main/src/components/admin packages/admin/src/app
```
Expected: **0 行输出**

- [ ] **Step 3: lint/typecheck + 提交**

Run: `cd /Users/kk/code/idream/packages/main && bun run lint && bun run typecheck`
Expected: PASS

```bash
git add -A packages/main/src/components/admin packages/admin/src
git commit -m "refactor(admin): sweep all admin views onto light --ad-* tokens"
```

- [ ] **Step 4: Phase 1 收尾门槛**

Run: `cd /Users/kk/code/idream && bun run check`
Expected: 全绿。随后 `bun run dev:admin`，浏览器打开 `http://127.0.0.1:3001/admin`：暖白底、白侧栏、无暗色残留即可（页面结构此时未变，属预期）。

---

# Phase 2 — 官方角色三件套（样板间）

> 本 Phase 建立三件套的**参照实现**。Phase 3 的五个任务在结构上复制这里的模式：
> `<feature>/` 目录 = `<feature>-api.ts`（类型+端点+payload，纯逻辑可测）+ `Section.tsx`（子视图路由）+ 三个页面组件。

### Task 9: official-api.ts + 缩略图映射（TDD）

**Files:**
- Create: `packages/main/src/components/admin/official/official-api.ts`
- Create: `packages/main/src/components/admin/official/official-api.test.ts`

**Interfaces:**
- Produces（三个页面共同消费）：
  - `type OfficialRow`（从 `OfficialCharactersView.tsx:22-42` 原样搬运，含 `visualProfile`）
  - `GENDERS = ["female","male","trans"]`、`STYLES = ["realistic","anime","hybrid","other"]`（as const）
  - `OFFICIAL_LIST = "/api/v1/admin/content/official"`
  - `type OfficialDraft = { name: string; age: string; gender: (typeof GENDERS)[number]; style: (typeof STYLES)[number]; description: string; tags: string; reason: string }`
  - `officialPayload(draft: OfficialDraft): Record<string, unknown>` —— name/description trim、age 转 int（fallback 18）、tags 按逗号拆、reason trim（与旧视图 POST/PATCH body 完全一致）
  - `visualReferenceCount(row: OfficialRow): number`（从 `OfficialCharactersView.tsx:52-60` 原样搬运）
  - `characterThumbnails(assets): Map<string, string>` —— `targetType === "character"` 的资产按 `targetId` 取第一张，优先 `thumbnailUrl` 其次 `url`

- [ ] **Step 1: 写失败测试** `official/official-api.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { characterThumbnails, officialPayload } from "./official-api";

describe("officialPayload", () => {
  it("trims, parses age, splits tags, keeps reason", () => {
    expect(
      officialPayload({
        name: " Luna ", age: "24", gender: "female", style: "realistic",
        description: " desc ", tags: "cute, elf ,, ", reason: " ok3 ",
      }),
    ).toEqual({
      name: "Luna", age: 24, gender: "female", style: "realistic",
      description: "desc", tags: ["cute", "elf"], reason: "ok3",
    });
  });
  it("falls back to age 18 on garbage", () => {
    expect(
      officialPayload({
        name: "A", age: "x", gender: "male", style: "anime",
        description: "d", tags: "", reason: "abc",
      }).age,
    ).toBe(18);
  });
});

describe("characterThumbnails", () => {
  it("maps first character asset per targetId, prefers thumbnailUrl", () => {
    const map = characterThumbnails([
      { targetType: "character", targetId: "c1", thumbnailUrl: "t1.jpg", url: "u1.jpg" },
      { targetType: "character", targetId: "c1", thumbnailUrl: "t2.jpg", url: "u2.jpg" },
      { targetType: "character", targetId: "c2", thumbnailUrl: null, url: "u3.jpg" },
      { targetType: "placement", targetId: "c3", thumbnailUrl: "nope.jpg", url: null },
      { targetType: "character", targetId: null, thumbnailUrl: "nope.jpg", url: null },
    ]);
    expect(map.get("c1")).toBe("t1.jpg");
    expect(map.get("c2")).toBe("u3.jpg");
    expect(map.has("c3")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `cd /Users/kk/code/idream/packages/main && bunx vitest run src/components/admin/official/official-api.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `official/official-api.ts`：

```ts
// SPEC: 官方角色三件套的共享契约 —— 类型/端点/payload 构造（SSoT，三页共用）。
// INVARIANTS: payload 字段与旧 OfficialCharactersView 的 POST/PATCH body 完全一致（后端不变）。

export type OfficialStats = {
  chatsCount: number;
  likesCount: number;
  viewsCount: number;
} | null;

export type OfficialRow = {
  id: string;
  name: string;
  age: number;
  description: string;
  gender: string;
  style: string;
  status: string;
  visibility: string;
  createdAt: string;
  tags: string[];
  stats: OfficialStats;
  visualProfile: {
    id: string;
    version: number;
    status: string;
    style: string;
    anchorAssetIds?: unknown;
    referenceAssetIds?: unknown;
  } | null;
};

export const GENDERS = ["female", "male", "trans"] as const;
export const STYLES = ["realistic", "anime", "hybrid", "other"] as const;
export const OFFICIAL_LIST = "/api/v1/admin/content/official";

export type OfficialDraft = {
  name: string;
  age: string;
  gender: (typeof GENDERS)[number];
  style: (typeof STYLES)[number];
  description: string;
  tags: string;
  reason: string;
};

export function officialPayload(draft: OfficialDraft): Record<string, unknown> {
  const parsedAge = Number.parseInt(draft.age.trim(), 10);
  return {
    name: draft.name.trim(),
    age: Number.isFinite(parsedAge) ? parsedAge : 18,
    gender: draft.gender,
    style: draft.style,
    description: draft.description.trim(),
    tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
    reason: draft.reason.trim(),
  };
}

export function visualReferenceCount(row: OfficialRow): number {
  const anchorCount = Array.isArray(row.visualProfile?.anchorAssetIds)
    ? row.visualProfile.anchorAssetIds.length
    : 0;
  const referenceCount = Array.isArray(row.visualProfile?.referenceAssetIds)
    ? row.visualProfile.referenceAssetIds.length
    : 0;
  return anchorCount + referenceCount;
}

export type ThumbAsset = {
  targetType: string | null;
  targetId: string | null;
  thumbnailUrl?: string | null;
  url?: string | null;
};

export function characterThumbnails(assets: ThumbAsset[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const asset of assets) {
    if (asset.targetType !== "character" || !asset.targetId) continue;
    if (map.has(asset.targetId)) continue;
    const src = asset.thumbnailUrl || asset.url;
    if (src) map.set(asset.targetId, src);
  }
  return map;
}
```

- [ ] **Step 4: 跑测确认通过**（Step 2 命令）Expected: PASS

- [ ] **Step 5: lint/typecheck + 提交**

```bash
git add packages/main/src/components/admin/official/
git commit -m "feat(admin): official characters api module (payload + thumbnails, tested)"
```

---

### Task 10: OfficialListPage（卡片网格列表页）

**Files:**
- Create: `packages/main/src/components/admin/official/OfficialListPage.tsx`

**Interfaces:**
- Consumes: `official-api.ts` 全部导出；`ui/` 的 PageHeader/FilterBar/CardGrid/EntityCard/EmptyState/PrimaryButton；`apiGet`；`useAdminI18n`。
- Produces: `export function OfficialListPage()`（无 props，自取数）。

- [ ] **Step 1: 实现**：

```tsx
"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { FilterBar } from "@/components/admin/ui/FilterBar";
import { CardGrid, EntityCard } from "@/components/admin/ui/CardGrid";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { PrimaryButton } from "@/components/admin/ui/buttons";
import {
  characterThumbnails, GENDERS, OFFICIAL_LIST, STYLES,
  visualReferenceCount, type OfficialRow, type ThumbAsset,
} from "./official-api";

// SPEC: 官方角色列表页 —— 搜索/筛选 + 卡片网格（头像、名字、风格·年龄、参考图数、状态）。
// INTENT: 浏览页只浏览；创建在 /new，详情在 /<id>（spec §7 列表页）。
export function OfficialListPage() {
  const { t } = useAdminI18n();
  const [rows, setRows] = useState<OfficialRow[]>([]);
  const [thumbs, setThumbs] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [gender, setGender] = useState("all");
  const [style, setStyle] = useState("all");
  const [status, setStatus] = useState("all");

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: OfficialRow[] }>(OFFICIAL_LIST);
      setRows(data.items);
      // 缩略图尽力而为：拿一页已审核资产做 characterId → 图 的映射，失败不阻塞列表。
      try {
        const assets = await apiGet<{ items: ThumbAsset[] }>(
          "/api/v1/admin/content/assets?status=approved&limit=100",
        );
        setThumbs(characterThumbnails(assets.items));
      } catch {
        setThumbs(new Map());
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("Request failed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filtered = useMemo(
    () =>
      rows.filter(
        (row) =>
          (search.trim() === "" || row.name.toLowerCase().includes(search.trim().toLowerCase())) &&
          (gender === "all" || row.gender === gender) &&
          (style === "all" || row.style === style) &&
          (status === "all" || row.status === status),
      ),
    [rows, search, gender, style, status],
  );

  const allOption = { value: "all", label: t("All") };
  return (
    <div>
      <PageHeader
        action={
          <Link href="/admin/content/official/new">
            <PrimaryButton>
              <Plus className="h-4 w-4" /> {t("New official character")}
            </PrimaryButton>
          </Link>
        }
        purpose={t("Manage official character profiles and publishing.")}
        title={t("Official Characters")}
      />
      <FilterBar
        onSearch={setSearch}
        search={search}
        searchPlaceholder={t("Search by name")}
        selects={[
          { name: t("Gender"), value: gender, onChange: setGender,
            options: [allOption, ...GENDERS.map((g) => ({ value: g, label: t(g) }))] },
          { name: t("Style"), value: style, onChange: setStyle,
            options: [allOption, ...STYLES.map((s) => ({ value: s, label: t(s) }))] },
          { name: t("Status"), value: status, onChange: setStatus,
            options: [allOption,
              { value: "approved", label: t("approved") },
              { value: "draft", label: t("draft") },
              { value: "archived", label: t("archived") }] },
        ]}
      />
      {error ? <p className="mb-4 text-sm text-[var(--ad-red-text)]">{error}</p> : null}
      {loading ? (
        <p className="text-sm text-[var(--ad-text-muted)]">{t("Loading…")}</p>
      ) : filtered.length === 0 ? (
        <EmptyState
          action={
            <Link href="/admin/content/official/new">
              <PrimaryButton>
                <Plus className="h-4 w-4" /> {t("New official character")}
              </PrimaryButton>
            </Link>
          }
          hint={t("Create the first official character to get started.")}
          title={t("No official characters yet.")}
        />
      ) : (
        <CardGrid>
          {filtered.map((row) => (
            <EntityCard
              href={`/admin/content/official/${row.id}`}
              image={thumbs.get(row.id)}
              key={row.id}
              meta={
                <span>
                  {t(row.style)} · {row.age} · {visualReferenceCount(row)} {t("reference images")}
                </span>
              }
              status={row.status}
              title={row.name}
            />
          ))}
        </CardGrid>
      )}
    </div>
  );
}
```

- [ ] **Step 2: lint/typecheck + 提交**

Run: `cd /Users/kk/code/idream/packages/main && bun run lint && bun run typecheck`
Expected: PASS

```bash
git add packages/main/src/components/admin/official/OfficialListPage.tsx
git commit -m "feat(admin): official characters list page (card grid + filters)"
```

---

### Task 11: OfficialDetailPage（详情 + 就地编辑 + 上下线）

**Files:**
- Create: `packages/main/src/components/admin/official/OfficialDetailPage.tsx`

**Interfaces:**
- Consumes: `official-api.ts`；`ui/` DetailPage/DetailSection/ConfirmDialog/buttons/FormPage(INPUT_CLASS/TEXTAREA_CLASS/Field)/StatusPill；既有 `VisualPassportPanel`（用法先 `grep -n "VisualPassportPanel" packages/main/src/components/admin/OfficialCharactersView.tsx` 找到 JSX 与其 props/状态依赖，**原样搬运**）；`EngineeringDetails`（`generation/EngineeringDetails.tsx`）。
- Produces: `export function OfficialDetailPage({ id }: { id: string })`。

**要点（实现骨架如下，编辑态字段与 Task 12 新建页同构）：**

- 数据：无单条 GET —— `apiGet<{items: OfficialRow[]}>(OFFICIAL_LIST)` 后 `items.find(r => r.id === id)`；找不到渲染 `EmptyState`（标题 `t("Character not found.")`，action 返回列表）。
- 视图态：`mode: "view" | "edit"`。view 态分区展示；edit 态同一 URL 就地切换为表单（spec §7）。
- 动作（全走 `ConfirmDialog`）：
  - 保存修改（edit 态）：normal，`onSubmit: (reason) => apiWrite(\`${OFFICIAL_LIST}/${id}\`, "PATCH", officialPayload({...draft, reason}))` 后 `reload()` 并回 view 态。
  - 上线：normal，`POST ${OFFICIAL_LIST}/${id}/state`，body `{ status: "approved", reason }`。
  - 下线（破坏性）：`destructive: { expectedName: row.name }`，body `{ status: "archived", reason }`。
- 分区：基本资料（性别/风格/年龄/可见性/创建时间，DataTable 不必——用 dl 网格）、描述与标签（StatusPill 风格 tag chips 用中性色）、视觉档案（嵌 `VisualPassportPanel`，标题 `t("Visual Identity")`）、数据（stats 三个数字，若 null 显示 `—`）、生成记录入口（`GhostButton` 包 `<Link href="/admin/content/production">`，文案 `t("Open image production")`:"打开图片生产"——spec §7 的生成记录入口）。
- 工程字段：`<EngineeringDetails>` 折叠段放 `row.id`、`row.visualProfile` 原始 JSON。
- 顶部 actions：view 态 = `GhostButton 编辑资料` + 上/下线按钮（approved 显示下线 DangerButton，否则上线 PrimaryButton）；edit 态 = `GhostButton 取消` + `PrimaryButton 保存修改`。
- 返回：`backHref="/admin/content/official"`，`backLabel={t("Back to official characters")}`。

- [ ] **Step 1: 按上述要点实现**（结构复用 Task 12 的表单字段代码块——两者字段完全一致，先做本任务时直接写出，Task 12 引用之）。
- [ ] **Step 2: lint/typecheck + 提交**

Run: `cd /Users/kk/code/idream/packages/main && bun run lint && bun run typecheck`
Expected: PASS

```bash
git add packages/main/src/components/admin/official/OfficialDetailPage.tsx
git commit -m "feat(admin): official character detail page (view/edit + state actions)"
```

---

### Task 12: OfficialNewPage + Section 路由接线 + 删旧视图 + i18n

**Files:**
- Create: `packages/main/src/components/admin/official/OfficialNewPage.tsx`
- Create: `packages/main/src/components/admin/official/OfficialSection.tsx`
- Modify: `packages/main/src/components/admin/AdminConsoleClient.tsx`（renderSection 的 `section.view === "official"` 分支）
- Delete: `packages/main/src/components/admin/OfficialCharactersView.tsx`
- Modify: `packages/main/src/components/admin/i18n.tsx`（zh 表）
- Create: `packages/main/src/components/admin/i18n-pages.test.ts`

- [ ] **Step 1: 写 OfficialNewPage**（分组表单 + AI 辅助 + 底部操作条）：

```tsx
"use client";
import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { FormPage, FormSection, Field, FormFooter, INPUT_CLASS, TEXTAREA_CLASS } from "@/components/admin/ui/FormPage";
import { GhostButton, PrimaryButton } from "@/components/admin/ui/buttons";
import { GENDERS, OFFICIAL_LIST, STYLES, officialPayload, type OfficialDraft } from "./official-api";

const EMPTY_DRAFT: OfficialDraft = {
  name: "", age: "24", gender: "female", style: "realistic",
  description: "", tags: "", reason: "",
};

// SPEC: 全屏新建页 —— 基本信息→外貌与风格→描述与标签→提交；AI 辅助一句话灵感填充。
// INVARIANTS: 校验就地提示；age≥18 由后端强制，前端 min=18；成功跳详情页。
export function OfficialNewPage() {
  const { t } = useAdminI18n();
  const [draft, setDraft] = useState<OfficialDraft>(EMPTY_DRAFT);
  const [seed, setSeed] = useState("");
  const [assisting, setAssisting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function patch(partial: Partial<OfficialDraft>) {
    setDraft((current) => ({ ...current, ...partial }));
  }

  async function assist() {
    if (seed.trim().length === 0) return;
    setAssisting(true);
    setError(null);
    try {
      const data = await apiWrite<{ description: string; advancedDetails: { personality: string } }>(
        "/api/v1/admin/content/character-assist", "POST", { seed: seed.trim() },
      );
      const traits = data.advancedDetails.personality
        .split(",").map((tag) => tag.trim()).filter(Boolean);
      const existing = draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean);
      patch({
        description: data.description,
        tags: [...new Set([...existing, ...traits])].slice(0, 12).join(", "),
      });
    } catch (assistError) {
      setError(assistError instanceof Error ? assistError.message : t("Request failed"));
    } finally {
      setAssisting(false);
    }
  }

  const canSubmit =
    !creating &&
    draft.name.trim().length >= 1 &&
    draft.description.trim().length >= 1 &&
    draft.reason.trim().length >= 3;

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const created = await apiWrite<{ item?: { id?: string }; character?: { id?: string } }>(
        OFFICIAL_LIST, "POST", officialPayload(draft),
      );
      const newId = created.item?.id ?? created.character?.id;
      window.location.href = newId
        ? `/admin/content/official/${newId}`
        : "/admin/content/official";
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : t("Request failed"));
      setCreating(false);
    }
  }

  return (
    <FormPage
      backHref="/admin/content/official"
      backLabel={t("Back to official characters")}
      title={t("New official character")}
    >
      <FormSection hint={t("One-line inspiration — AI fills description and tags.")} title={t("AI assist")}>
        <Field full label={t("Inspiration")}>
          <div className="flex gap-2">
            <input className={INPUT_CLASS} onChange={(e) => setSeed(e.target.value)} value={seed} />
            <GhostButton disabled={assisting || seed.trim().length === 0} onClick={() => void assist()}>
              {assisting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {t("Generate with AI")}
            </GhostButton>
          </div>
        </Field>
      </FormSection>
      <FormSection title={t("Basic info")}>
        <Field label={t("Name (≥1)")}>
          <input className={INPUT_CLASS} onChange={(e) => patch({ name: e.target.value })} value={draft.name} />
        </Field>
        <Field label={t("Age")}>
          <input className={INPUT_CLASS} min={18} onChange={(e) => patch({ age: e.target.value })} type="number" value={draft.age} />
        </Field>
      </FormSection>
      <FormSection title={t("Appearance & style")}>
        <Field label={t("Gender")}>
          <select className={INPUT_CLASS} onChange={(e) => patch({ gender: e.target.value as OfficialDraft["gender"] })} value={draft.gender}>
            {GENDERS.map((g) => (<option key={g} value={g}>{t(g)}</option>))}
          </select>
        </Field>
        <Field label={t("Style")}>
          <select className={INPUT_CLASS} onChange={(e) => patch({ style: e.target.value as OfficialDraft["style"] })} value={draft.style}>
            {STYLES.map((s) => (<option key={s} value={s}>{t(s)}</option>))}
          </select>
        </Field>
      </FormSection>
      <FormSection title={t("Description & tags")}>
        <Field full label={t("Description")}>
          <textarea className={TEXTAREA_CLASS} onChange={(e) => patch({ description: e.target.value })} value={draft.description} />
        </Field>
        <Field full label={t("Tags (comma-separated, ≤12)")}>
          <input className={INPUT_CLASS} onChange={(e) => patch({ tags: e.target.value })} value={draft.tags} />
        </Field>
      </FormSection>
      <FormFooter error={error}>
        <input
          aria-label={t("Reason (≥3)")}
          className={`${INPUT_CLASS} max-w-xs`}
          onChange={(e) => patch({ reason: e.target.value })}
          placeholder={t("Reason (≥3)")}
          value={draft.reason}
        />
        <PrimaryButton disabled={!canSubmit} onClick={() => void create()}>
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t("Create character")}
        </PrimaryButton>
      </FormFooter>
    </FormPage>
  );
}
```

- [ ] **Step 2: 写 Section 路由** `official/OfficialSection.tsx`：

```tsx
"use client";
import type { AdminSubview } from "@/components/admin/nav-config";
import { OfficialListPage } from "./OfficialListPage";
import { OfficialDetailPage } from "./OfficialDetailPage";
import { OfficialNewPage } from "./OfficialNewPage";

// SPEC: content/official 的子视图路由 —— list / new / detail 三件套（spec §6.1）。
export function OfficialSection({ view }: { view: AdminSubview }) {
  if (view.kind === "new") return <OfficialNewPage />;
  if (view.kind === "detail") return <OfficialDetailPage id={view.id} />;
  return <OfficialListPage />;
}
```

- [ ] **Step 3: renderSection 接线 + 删旧视图**

`AdminConsoleClient.tsx` selfFetch 分支：`if (section.view === "official") return <OfficialCharactersView />;` 改为 `return <OfficialSection view={subview} />;`（import 换成 OfficialSection，删除 OfficialCharactersView import）。然后 `git rm packages/main/src/components/admin/OfficialCharactersView.tsx`。
搜索确认无残余引用：`grep -rn "OfficialCharactersView" packages/main/src packages/admin/src` → 0 行。

- [ ] **Step 4: i18n —— 先写失败测试再补 zh**

Create `i18n-pages.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { hasAdminZh } from "./i18n";

// SPEC: 三件套页面自有文案必须有 zh（运营面不漏英文）。每落一个三件套，扩这张表。
export const OFFICIAL_KEYS = [
  "New official character", "Manage official character profiles and publishing.",
  "Search by name", "reference images", "Create the first official character to get started.",
  "No official characters yet.", "Back to official characters", "AI assist",
  "One-line inspiration — AI fills description and tags.", "Inspiration",
  "Basic info", "Appearance & style", "Description & tags", "Create character",
  "Character not found.", "Edit profile", "Save changes", "approved", "draft", "archived",
  "female", "male", "trans", "realistic", "anime", "hybrid", "other",
];

describe("admin i18n — trio pages have zh", () => {
  it("official characters trio", () => {
    for (const key of OFFICIAL_KEYS) expect(hasAdminZh(key)).toBe(true);
  });
});
```

Run: `bunx vitest run src/components/admin/i18n-pages.test.ts` → Expected: FAIL（缺 key）。
在 `i18n.tsx` zh 表按字母序补齐缺失项（已存在的 key 如 `"Gender"`、`"Style"`、`"Loading…"`、`"Generate with AI"`、`"Tags (comma-separated, ≤12)"`、`"Name (≥1)"` 勿重复；状态词/性别/风格词若已有也勿重复）。建议值：

```
"New official character": "新建官方角色",
"Manage official character profiles and publishing.": "管理平台官方角色的资料与上下线。",
"Search by name": "按名字搜索",
"reference images": "张参考图",
"Create the first official character to get started.": "创建第一个官方角色，从这里开始。",
"No official characters yet.": "还没有官方角色。",
"Back to official characters": "返回官方角色",
"AI assist": "AI 辅助",
"One-line inspiration — AI fills description and tags.": "一句话灵感——AI 自动填充描述与标签。",
"Inspiration": "灵感",
"Basic info": "基本信息",
"Appearance & style": "外貌与风格",
"Description & tags": "描述与标签",
"Create character": "创建角色",
"Character not found.": "未找到该角色。",
"Edit profile": "编辑资料",
"Save changes": "保存修改",
```
（`approved/draft/archived/female/…` 等状态与枚举词：先 `grep '"approved"' i18n.tsx` 查存在性，缺的补上：`"approved": "已上线", "draft": "草稿", "archived": "已下线", "female": "女", "male": "男", "trans": "跨性别", "realistic": "写实", "anime": "动漫", "hybrid": "混合", "other": "其他"`。）
再跑测试 → Expected: PASS。

- [ ] **Step 5: 全量验证 + 冒烟 + 提交**

Run: `cd /Users/kk/code/idream/packages/main && bun run lint && bun run typecheck && bunx vitest run src/components/admin/`
Expected: PASS

冒烟（`bun run dev:admin`）：`/admin/content/official` 看卡片网格 → 点卡片进详情 → 编辑保存（ConfirmDialog 填 reason）→ 返回 → 点新建 → AI 辅助 → 创建成功跳详情。中文模式无英文穿透。

```bash
git add -A packages/main/src/components/admin
git commit -m "feat(admin): official characters trio — new page, section router, drop legacy view"
```

- [ ] **Step 6: Phase 2 收尾门槛**

Run: `cd /Users/kk/code/idream && bun run check`
Expected: 全绿。

---

# Phase 3 — 其余内容页复制样板

> 五个任务同构：`<feature>/` 目录 = api 模块（类型/端点/payload）+ `Section.tsx`（子视图路由，代码与 `OfficialSection` 同形，只换组件名）+ List/Detail/New 页面（组合 Phase 1 原语）。每个任务都包含：renderSection 接线、旧代码删除、i18n（先在 `i18n-pages.test.ts` 加本页 KEYS 常量跑失败 → 补 zh → 跑过）、`grep` 验证无旧引用、lint/typecheck/vitest、commit。以下只写**每页的差异事实**；页面 JSX 组合方式一律参照 Task 10-12 已给出的完整代码。

### Task 13: 角色模板 Starters 三件套

**Files:**
- Create: `packages/main/src/components/admin/starters/{starters-api.ts, starters-api.test.ts, StartersSection.tsx, StartersListPage.tsx, StartersDetailPage.tsx, StartersNewPage.tsx}`
- Modify: `AdminConsoleClient.tsx`（selfFetch `view === "templates"` 分支 → `<StartersSection view={subview} />`）
- Delete: `packages/main/src/components/admin/TemplatesView.tsx`
- Modify: `i18n.tsx`、`i18n-pages.test.ts`

**差异事实：**
- 类型（从 `TemplatesView.tsx:15-27` 原样搬运）：`type Starter = { id: string; scope: string; name: string; summary: string | null; gender: string | null; style: string | null; tags: string[]; isActive: boolean; sortOrder: number }`。
- 端点：`const STARTERS_LIST = "/api/v1/admin/content/templates"`；创建 POST、编辑 PATCH `/:id`、上下线 POST `/:id/active`（body `{ active: boolean, reason }`）。
- `starterPayload(draft)`：**先读 `TemplatesView.tsx` 的提交体构造（130-165 行）原样搬运**——字段 `name`(trim ≥1)、`summary`(≤200)、`gender`、`style`、`scope`、`tags`(逗号拆 ≤12，用其现有 `tagsFromText`)、`sortOrder`(int fallback 0，用其现有 `intFromText`)、`reason`(trim ≥3)。测试同 Task 9 风格（trim/拆 tags/sortOrder fallback 三个用例）。
- 列表页：CardGrid + EntityCard（无图走 monogram），meta = `scope · 排序 {sortOrder} · {tags.length} 个标签`，status = `row.isActive ? "active" : "disabled"`，label `t("Active")/t("Inactive")`；FilterBar：搜索名字 + scope 下拉 + 状态下拉。
- 详情页：view/edit 就地切换（字段与新建页同构）；动作：保存（PATCH，ConfirmDialog normal）、上线（POST active `{active:true}`，normal）、下线（`{active:false}`，**destructive**，expectedName=`row.name`）。工程字段：`EngineeringDetails` 放 `id`/`scope` 原始值。
- 新建页：AI 辅助（**从 `TemplatesView.tsx:170-190` 原样搬运** assist 逻辑：seed → `/api/v1/admin/content/character-assist` → 填 summary + 合并 traits 进 tags）+ 分组表单（基本信息 name/sortOrder/scope；分类 gender/style；摘要与标签 summary/tags）+ FormFooter（reason + 创建）。成功后跳 `/admin/content/templates/<id>`（响应无 id 则回列表）。
- i18n KEYS 常量名 `STARTERS_KEYS`，含：`"New starter template"`:"新建角色模板"、`"Manage starter templates for user character creation."`:"管理用户建角时的起步模板。"、`"Back to starter templates"`:"返回角色模板"、`"No starter templates yet."`:"还没有角色模板。"、`"Active"`:"已上线"、`"Inactive"`:"未上线"、`"Sort order"`:"排序"、`"Scope"`:"范围"、`"Summary (≤200)"` 已存在则不加。

- [ ] Step 1: TDD api 模块（测试先行）
- [ ] Step 2: 三页面 + Section 路由
- [ ] Step 3: renderSection 接线 + `git rm TemplatesView.tsx` + `grep -rn "TemplatesView" packages/main/src packages/admin/src` → 0
- [ ] Step 4: i18n 失败测试 → 补 zh → 通过
- [ ] Step 5: `bun run lint && bun run typecheck && bunx vitest run src/components/admin/` → PASS；commit `feat(admin): starter templates trio`

---

### Task 14: Prompt Recipes 三件套（含 AdminConsoleClient 瘦身）

**Files:**
- Create: `packages/main/src/components/admin/recipes/{recipes-api.ts, RecipesSection.tsx, RecipesListPage.tsx, RecipesDetailPage.tsx, RecipesNewPage.tsx}`
- Modify: `AdminConsoleClient.tsx`（多处，见下）
- Modify: `nav-config.ts`（`configSliceForSection` 收缩）+ `nav-config.test.ts`
- Modify: `i18n.tsx`、`i18n-pages.test.ts`

**差异事实：**
- **搬运（原样，从 `AdminConsoleClient.tsx`）**：`type RecipeDraft`、`defaultRecipeDraft`、`recipeDraftPayload`(:1456)、`recipeStateLabelKey`(:3283) → `recipes-api.ts`；`RecipeDetail`(:3293) 与 `PromptRecipesView`(:3214) 的展示逻辑 → 新页面（布局换成 DataTable/DetailPage）。
- 端点：GET/POST `/api/v1/admin/generation/recipes`；PATCH `/:id`；发布 POST `/:id/publish`，body `{ reason, confirmation: id, dryRunSummary: { source: "admin_console" } }`；回滚 POST `/:id/rollback`，body `{ reason, confirmation: id }`。**`confirmation` 字段程序化填 id（后端契约），不再让运营敲**——UI 仪式降噪，契约不动（spec §7）。
- 数据流改造（AdminConsoleClient 瘦身）：
  1. `fetchSection` 在 `configSliceForSection` 判断**之前**加：`if (sectionId === "generation/recipes") return { kind: "selfFetch", view: "recipes" };` 与 presets 同款（presets 在 Task 15 加）。`SectionData` 的 selfFetch view 联合类型加 `"recipes"`。
  2. `renderSection` 删 `section.slice === "recipes"` 分支，selfFetch 加 `if (section.view === "recipes") return <RecipesSection view={subview} />;`。
  3. 删 AdminConsoleClient 内的 `recipeDraft`/`setRecipeDraft` state、`createRecipe`、`configBusy`、ctx 里对应字段、`PromptRecipesView`/`RecipeDetail`/`recipeTableActions`/`publishRecipeAction`/`rollbackRecipeAction` 函数（全部迁入 recipes/）。
  4. `nav-config.ts` 的 `configSliceForSection`：删 recipes 分支（presets 分支 Task 15 删）；`nav-config.test.ts` 同步改断言（`configSliceForSection("generation/recipes")` → `null`）。
- 列表页：DataTable（列：名称/版本/状态 pill/更新时间），行点进详情；FilterBar 搜索名称 + 状态下拉。
- 详情页：配方内容分区（prompt 文本用 mono 展示）、状态、动作：draft → 发布（ConfirmDialog normal）；active → 回滚（**destructive**，expectedName = 名称字段，取 `stringValue(row.name) || id`）；编辑（PATCH，仅 draft 可编，后端限制 "Only draft templates can be edited"——非 draft 时编辑按钮 disabled 并注明）。工程字段进 `EngineeringDetails`（id/版本/原始 JSON）。
- 新建页：字段 = `RecipeDraft` 现有字段（照 `defaultRecipeDraft` 枚举，逐字段 Field 化）+ FormFooter（recipes POST 的 body 由 `recipeDraftPayload` 生成——**先确认其是否含 reason 字段，含则表单收集，不含则不设 reason 输入**）。
- i18n KEYS 常量 `RECIPES_KEYS`：`"New prompt recipe"`:"新建提示词配方"、`"Manage prompt recipes for image generation."`:"管理生图提示词配方。"、`"Back to prompt recipes"`:"返回提示词配方"、`"Only draft recipes can be edited."`:"只有草稿状态可编辑。"、`"Publish recipe"`:"发布配方"、`"Rollback recipe"`:"回滚配方" 等（实现时按页面实际用到的 key 收全）。

- [ ] Step 1: 建 recipes-api.ts（搬运 4 个函数/类型 + 端点常量）
- [ ] Step 2: 三页面 + Section 路由
- [ ] Step 3: AdminConsoleClient 四步瘦身 + nav-config 收缩 + 测试同步；`grep -rn "PromptRecipesView\|recipeDraftPayload\|publishRecipeAction" packages/main/src/components/admin/AdminConsoleClient.tsx` → 0
- [ ] Step 4: i18n 失败测试 → 补 zh → 通过
- [ ] Step 5: lint/typecheck/vitest 全绿；commit `feat(admin): prompt recipes trio + slim AdminConsoleClient`

---

### Task 15: Presets 三件套

**Files:**
- Create: `packages/main/src/components/admin/presets/{presets-api.ts, presets-api.test.ts, PresetsSection.tsx, PresetsListPage.tsx, PresetsDetailPage.tsx, PresetsNewPage.tsx}`
- Modify: `AdminConsoleClient.tsx`（selfFetch "presets" + 删 `GenerationPresetsView`(:3337)/`presetStateLabelKey`/`presetSecondaryLine`/`PresetDetail`）
- Modify: `nav-config.ts`（configSliceForSection 删 presets → 函数只剩 profiles，简化为 `sectionId === "generation/config" ? "profiles" : null`）+ `nav-config.test.ts`
- Modify: `i18n.tsx`、`i18n-pages.test.ts`

**差异事实：**
- 后端契约（`service.ts:339-346` presetAdminSchema，**无 reason 字段**）：`{ type: "background"|"pose"|"outfit"|"mode", category?: string(≤80), label: string(1-80), controls: Record<string,unknown>(默认{}), visibility: "private"|"public"|"unlisted"(默认public), status: "active"|"archived"(默认active) }`。GET/POST `/api/v1/admin/generation/presets`，PATCH `/:id`（partial）。
- `presets-api.ts`：

```ts
export type PresetRow = {
  id: string; scope: string; type: string; category: string | null;
  label: string; controls: Record<string, unknown>; visibility: string; status: string;
};
export const PRESET_TYPES = ["background", "pose", "outfit", "mode"] as const;
export const PRESET_VISIBILITY = ["public", "private", "unlisted"] as const;
export const PRESETS_LIST = "/api/v1/admin/generation/presets";
export type PresetDraft = {
  type: (typeof PRESET_TYPES)[number]; category: string; label: string;
  controlsJson: string; visibility: (typeof PRESET_VISIBILITY)[number];
};
// controlsJson 非法时抛 Error（表单就地显示），空串视为 {}
export function presetPayload(draft: PresetDraft): Record<string, unknown> {
  const trimmed = draft.controlsJson.trim();
  let controls: Record<string, unknown> = {};
  if (trimmed.length > 0) {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("controls must be a JSON object");
    }
    controls = parsed as Record<string, unknown>;
  }
  return {
    type: draft.type, label: draft.label.trim(),
    category: draft.category.trim() || undefined,
    controls, visibility: draft.visibility,
  };
}
```
测试：合法 JSON、空串、非对象抛错 三个用例（TDD）。
- 列表页：DataTable（label / type / category / visibility / status pill），FilterBar 搜索 label + type 下拉。
- 详情页：字段展示 + controls JSON 放 `EngineeringDetails`；动作：编辑（PATCH，ConfirmDialog normal）、归档（PATCH `{status:"archived"}`，**destructive** expectedName=label）、恢复（`{status:"active"}`，normal）。**注意**：presets 后端无 reason 字段——ConfirmDialog 收集的 reason 仍放进 body（zod 非 strict 会剥掉，不破坏契约），保持全后台确认体验一致。
- 新建页：type/label/category/visibility 四个 Field + controls JSON textarea（mono 字体 `font-mono`）；无 reason 输入。成功回列表（POST 响应 `{preset:{id}}` → 跳 `/admin/generation/presets/<id>`）。
- i18n KEYS 常量 `PRESETS_KEYS`：`"New preset"`:"新建预设"、`"Manage built-in generation presets."`:"管理内置生成预设。"、`"Back to presets"`:"返回预设"、`"Archive preset"`:"归档预设"、`"Restore"`:"恢复"、`"Controls (JSON)"`:"控制参数（JSON）" 等。

- [ ] Step 1: TDD presets-api（presetPayload 三用例先失败后通过）
- [ ] Step 2: 三页面 + Section 路由
- [ ] Step 3: AdminConsoleClient/nav-config 清理 + 测试同步；`grep -n "GenerationPresetsView\|configSliceForSection" AdminConsoleClient.tsx` 确认只剩 profiles 用法
- [ ] Step 4: i18n 失败测试 → 补 zh → 通过
- [ ] Step 5: lint/typecheck/vitest 全绿；commit `feat(admin): generation presets trio`

---

### Task 16: 图片库 Assets（列表网格 + 详情页）

**Files:**
- Create: `packages/main/src/components/admin/ui/AssetImage.tsx`（自 `ContentOpsViews.tsx:1100-1137` 迁入并换 token 皮）
- Create: `packages/main/src/components/admin/assets/{AssetsSection.tsx, AssetsListPage.tsx, AssetsDetailPage.tsx}`
- Modify: `AdminConsoleClient.tsx`（selfFetch `view === "assets"` → `<AssetsSection view={subview} />`）
- Modify: `ContentOpsViews.tsx`（删 `AssetLibraryView`(479-686)；`AssetImage` 改从 `ui/AssetImage` import；`ProductionStudioView` 等其余保留）
- Modify: `i18n.tsx`、`i18n-pages.test.ts`

**差异事实：**
- 图片库「新建」= 既有上传/导入流程，**不做 /new 页**——`AssetsSection` 只路由 list/detail，`view.kind === "new"` 回落列表。
- `AssetsListPage`：把 `AssetLibraryView` 的**全部既有能力原样保留**（筛选参数拼 `/api/v1/admin/content/assets?...`、上传/导入动作、审核 PATCH），布局重排为 PageHeader（用途：`"Browse and curate generated image assets."`:"浏览与治理生成图片资产。"）+ FilterBar + **图片网格**（EntityCard 换成图优先卡：AssetImage + 状态 pill + purpose 一行），点卡进 `/admin/content/assets/<id>`。批量选择等现有交互保留在列表页。
- `AssetsDetailPage({ id })`：列表接口取数后 `find`；大图（AssetImage 非 compact）+ 元数据分区（purpose/targetType/targetId/tags/description/platformStatus + sourceJob/sourceBatch）+ 审核动作（**原样搬运** `AssetLibraryView` 内两处 `apiWrite(\`/api/v1/admin/content/assets/${'{'}asset.id{'}'}\`, "PATCH", …)`（:540、:561）的 body 构造，接到 ConfirmDialog：通过=normal、拒绝/下架=destructive expectedName=资产 id 前 8 位——资产无名字，此处例外用短 id，label 写明）。工程字段（sourceJob 原始 JSON、完整 id）进 `EngineeringDetails`。
- i18n KEYS 常量 `ASSETS_KEYS`（用途句、`"Back to image library"`:"返回图片库"、`"Asset not found."`:"未找到该资产。" 等）。

- [ ] Step 1: 迁 `AssetImage` 到 `ui/`（换 token）+ ContentOpsViews import 改线
- [ ] Step 2: AssetsListPage（能力等价重排）+ AssetsDetailPage + Section
- [ ] Step 3: 接线 + 删 `AssetLibraryView` + `grep -rn "AssetLibraryView" packages/main/src packages/admin/src` → 0
- [ ] Step 4: i18n 失败测试 → 补 zh → 通过
- [ ] Step 5: lint/typecheck/vitest；commit `feat(admin): asset library — grid list + detail page`

---

### Task 17: Placements 三件套 + Tags 收尾

**Files:**
- Create: `packages/main/src/components/admin/placements/{PlacementsSection.tsx, PlacementsListPage.tsx, PlacementsDetailPage.tsx, PlacementsNewPage.tsx}`
- Modify: `AdminConsoleClient.tsx`（selfFetch `view === "placements"` 接线）
- Modify: `ContentOpsViews.tsx`（删 `PlacementsView`(686-965)；`placementActionLabel` 等只被它用的 helper 一并迁走或删除）
- Modify: `packages/main/src/components/admin/TagsView.tsx`（轻改造，不拆页）
- Modify: `i18n.tsx`、`i18n-pages.test.ts`

**差异事实（Placements）：**
- 数据：**原样搬运** `PlacementsView` 的双取数（`/content/assets?status=approved&limit=100` + `/content/placements?limit=100`）与资产配对逻辑。
- 列表页：DataTable + 缩略图列（`ui/AssetImage` compact）+ slot/status pill；点行进详情。
- 新建页：**原样搬运** `ContentOpsViews.tsx:751` 的 POST body 构造成表单（Field 化每个字段）；FormFooter reason 输入（若原 body 含 reason 则保留，不含则不设——以搬运的 body 为准）。
- 详情页：字段 + 动作 publish/pause/archive（**原样搬运** `:781` PATCH body；archive 为 destructive，expectedName=placement 的 slot 或 title 字段，以实际字段为准）。
- i18n KEYS 常量 `PLACEMENTS_KEYS`。

**差异事实（Tags——例外，不拆三件套，spec §6.2）：**
- 保持单页；加 `PageHeader`（用途 `"Manage the tag vocabulary for characters."`:"管理角色标签词表。"）；行内新建/改名/合并保留；其自带确认块改用 `ConfirmDialog`（合并 tag 为 destructive，expectedName=目标 tag 名）。

- [ ] Step 1: Placements 三页 + Section + 接线 + 删旧 + `grep -rn "PlacementsView" packages/main/src packages/admin/src` → 0
- [ ] Step 2: TagsView 轻改造（PageHeader + ConfirmDialog）
- [ ] Step 3: i18n 失败测试 → 补 zh → 通过
- [ ] Step 4: lint/typecheck/vitest；commit `feat(admin): placements trio + tags page polish`

- [ ] **Step 5: Phase 3 收尾门槛**

Run: `cd /Users/kk/code/idream && bun run check`
Expected: 全绿。

---

# Phase 4 — i18n 扫尾 + 全后台冒烟

### Task 18: 中文覆盖终检

**Files:**
- Modify: `packages/main/src/components/admin/i18n.tsx`、`i18n-pages.test.ts`

- [ ] **Step 1: 机器扫**：`grep -rhoE 't\("([^"]+)"' packages/main/src/components/admin/{official,starters,recipes,presets,assets,placements,ui} | sort -u` 得到全部 key，与 `i18n-pages.test.ts` 各 KEYS 常量比对，漏的补进对应常量 → 跑测失败 → 补 zh → 通过。
- [ ] **Step 2: 全量测试**：`cd packages/main && bunx vitest run src/components/admin/` → PASS。
- [ ] **Step 3: commit** `i18n(admin): zh coverage for trio pages`

### Task 19: 终检 + 浏览器冒烟

- [ ] **Step 1: 硬门槛复查**

```bash
cd /Users/kk/code/idream && bun run check
# 暗色残留终检（同 Task 8 Step 2 的 grep）→ 0 行
```

- [ ] **Step 2: Chrome 冒烟（中文模式，`bun run dev:admin` → http://127.0.0.1:3001/admin）**

| 动线 | 验收 |
|---|---|
| Dashboard / 侧栏 | 暖白编辑部观感；折叠组/daily 正常；无英文穿透 |
| 官方角色 列表→详情→编辑→保存→新建→上线 | 三件套可走通；ConfirmDialog 只要 reason；下线要求输入名称 |
| 角色模板 同上 | 同上 |
| Recipes 列表→详情→发布 / Presets 列表→新建 | 发布不需敲 ID；presets controls JSON 报错就地显示 |
| 图片库 网格→详情→审核 / Placements 列表→新建→详情→暂停 | 图片直接可见 |
| Tags / 其余换皮页抽查 5 个（用户、计费、审核队列、Moderation、Jobs） | 无暗色残留、无布局塌陷 |
| 直接访问深链 `/admin/content/official/new` 与未知路径 `/admin/xx/yy` | 前者进新建页，后者回 Dashboard |

- [ ] **Step 3: 已知坑复查**：语言切换持久化（localStorage 读在 useEffect，勿动）；改动后 dev server 重启再验。
- [ ] **Step 4: 冒烟发现的问题就地修复**，复跑 `bun run check`，commit `fix(admin): smoke fixes for operator ux redesign`。

---

## Self-Review 记录（写计划时已核）

- **Spec 覆盖**：§4.1 token→Task 1；§4.2 九原语→Task 2-5；§5 偏离→约束区；§6.1 路由→Task 6；§6.2 七页→Task 10-17（Tags 例外按 spec）；§6.3 只换皮→Task 7-8；§7 动线/降噪→Task 10-17 + ConfirmDialog；§8 验证→各任务 + Task 18-19；§9 分批→四个 Phase 门槛。
- **类型一致性**：`AdminSubview`/`parseAdminPath`（Task 6 定义，10-17 消费）；`ConfirmSpec.destructive.expectedName`（Task 5 定义，11-17 消费）；`OfficialDraft/officialPayload`（Task 9 定义，11-12 消费）——名称已逐一核对。
- **无占位符**：所有"原样搬运"均给出源文件+行号；presets/recipes 的 reason 契约差异已显式写明。

