# Admin Guided Nav Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Cut admin-console cognitive load — surface a small daily set + collapse the rest (progressive disclosure), and turn the Dashboard into a guided "what needs you + common tasks" landing. Presentation layer only.

**Architecture:** `nav-config.ts` gains a `tier` field (`daily` | `folded`) and folded-group names, staying the SSoT. The sidebar in `AdminConsoleClient.tsx` renders a pinned daily section + collapsible folded groups (collapse state in localStorage). `DashboardView` is rebuilt into an attention panel + task cards + the existing metrics. No schema, no API — reuse existing endpoints/components.

**Tech Stack:** Next.js 16, React 19, TS strict, Tailwind v4, lucide-react, vitest (node), bun + turbo.

## Global Constraints

- **Zero DB / zero API change.** Reuse existing endpoints and existing `*View` components. No `schema.prisma`, no `/api/**`.
- **Nothing lost.** Every one of the current 34 nav items stays reachable (daily-pinned or inside a folded group). `nav-config.ts` stays the SSoT for the four-place sync (nav → normalizeSection → fetchSection → renderSection).
- **审核 = 2 daily pins, NOT a merged shell.** Decision: `ModerationView` depends on the parent `openAction` dialog system (not self-contained), so a merged self-fetching ReviewCenter is out of proportion. Pin `content/review-queue` (审核队列) and `moderation` (举报) as two daily items.
- TypeScript strict, no `any`. Named exports. 2-space indent. Tailwind utilities (match existing dark-admin styling).
- Engineering-diagnostic group (工作流/后端/供应商健康/任务/死信/指标) collapsed by default — reflects `ADMIN_CONSOLE_PLAN.md`'s "隐藏工程诊断".

## Tier map (all 34 items, nothing lost)

**Daily (tier `daily`, pinned, 7):** `dashboard`, `content/review-queue`, `moderation`, `content/official`, `content/production`, `content`, `support`.

**Folded groups (tier `folded`):**
| group | items |
|---|---|
| 角色配置 CharacterConfig | `content/templates`, `content/tags` |
| 生成配置 GenerationConfig | `generation/config`, `generation/recipes`, `generation/presets` |
| 图片 Media | `content/assets`, `content/placements`, `cms` |
| 业务 Business | `users`, `billing`, `pricing`, `promo`, `announcements` |
| 洞察 Insights | `analytics`, `insights`, `experiments`, `risk` |
| 工程诊断 Engineering | `generation/workflows`, `generation/backends`, `ops/providers`, `generation/jobs`, `generation/dead-letter`, `generation/metrics` |
| 系统 System | `chat`, `compliance`, `approvals`, `audit-log` |

Count: 7 daily + (2+3+3+5+4+6+4)=27 folded = 34. ✓

---

## Task 1: Tier the nav config (data + test)

**Files:** Modify `packages/main/src/components/admin/nav-config.ts`; Modify `packages/main/src/components/admin/nav-config.test.ts`.

**Interfaces produced:** `NavItem` gains `tier: "daily" | "folded"`; `export const NAV_DAILY: NavItem[]`; `export const NAV_FOLDED_GROUPS: { group: string; items: NavItem[] }[]` (folded groups in order).

- [ ] **Step 1: Write the failing test** — append to `nav-config.test.ts`:

```ts
import { NAV_DAILY, NAV_FOLDED_GROUPS } from "./nav-config";

describe("nav-config tiers (guided nav)", () => {
  it("pins exactly the 7 daily items in order", () => {
    expect(NAV_DAILY.map((i) => i.id)).toEqual([
      "dashboard", "content/review-queue", "moderation",
      "content/official", "content/production", "content", "support",
    ]);
  });
  it("every daily item has tier daily; every folded item has tier folded", () => {
    for (const i of NAV_DAILY) expect(i.tier).toBe("daily");
    for (const g of NAV_FOLDED_GROUPS) for (const i of g.items) expect(i.tier).toBe("folded");
  });
  it("loses nothing — daily + folded covers all 34 nav ids exactly once", () => {
    const ids = [...NAV_DAILY, ...NAV_FOLDED_GROUPS.flatMap((g) => g.items)].map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(navItems.length);
    expect(new Set(ids)).toEqual(new Set(navItems.map((i) => i.id)));
  });
  it("orders folded groups with Engineering + System last", () => {
    const names = NAV_FOLDED_GROUPS.map((g) => g.group);
    expect(names).toEqual(["CharacterConfig","GenerationConfig","Media","Business","Insights","Engineering","System"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd packages/main && bunx vitest run src/components/admin/nav-config.test.ts` → FAIL (`NAV_DAILY` not exported).

- [ ] **Step 3: Add `tier` + reorganize navItems + derive the exports.** In `nav-config.ts`:
  1. Add to `NavItem`: `tier: "daily" | "folded";`
  2. Rewrite `navItems` so each item carries `tier` and its (new) `group`. Daily items get `group: "Daily"`, `tier: "daily"`, in the order above. Folded items get `tier: "folded"` and the folded-group name from the tier map (English keys: `CharacterConfig`/`GenerationConfig`/`Media`/`Business`/`Insights`/`Engineering`/`System`). Keep every id/label/href/icon exactly as today — only `group` + new `tier` change. (Reuse existing labels; the IA-redesign English labels stay. `KNOWN_SECTION_IDS`, `SECTION_ALIASES`, `normalizeSection`, `configSliceForSection` are unchanged — they derive from `navItems`.)
  3. Append the derived exports:

```ts
export const NAV_DAILY: NavItem[] = navItems.filter((i) => i.tier === "daily");

const FOLDED_GROUP_ORDER = [
  "CharacterConfig", "GenerationConfig", "Media", "Business", "Insights", "Engineering", "System",
] as const;

export const NAV_FOLDED_GROUPS: { group: string; items: NavItem[] }[] = FOLDED_GROUP_ORDER.map(
  (group) => ({ group, items: navItems.filter((i) => i.tier === "folded" && i.group === group) }),
);
```

- [ ] **Step 4: Run to verify pass** — `cd packages/main && bunx vitest run src/components/admin/nav-config.test.ts` → PASS (baseline + tier tests). If the pre-existing IA-redesign tests assert the OLD group names (`Characters`/`Generation`/`Media`), update those assertions to the new tiered `group` values in the same file (the migration-completeness test that froze `ORIGINAL_IDS` still holds — ids unchanged).

- [ ] **Step 5: Typecheck** — `cd packages/main && bun run typecheck` → clean. (The sidebar still renders via `navItems` until Task 2; adding a required `tier` field means every `navItems` entry must set it — tsc enforces completeness.)

- [ ] **Step 6: Commit**

```bash
git add packages/main/src/components/admin/nav-config.ts packages/main/src/components/admin/nav-config.test.ts
git commit -m "feat(admin): tier nav-config into daily + folded groups (guided nav data)"
```

---

## Task 2: Progressive-disclosure sidebar

**Files:** Modify `packages/main/src/components/admin/AdminConsoleClient.tsx` (sidebar render ~lines 819-886; imports).

**Interfaces:** Consumes `NAV_DAILY`, `NAV_FOLDED_GROUPS` from nav-config.

- [ ] **Step 1: Import the tiered exports** — extend the nav-config import:

```ts
import { navItems, normalizeSection, configSliceForSection, NAV_DAILY, NAV_FOLDED_GROUPS, type ConfigSlice } from "@/components/admin/nav-config";
```

- [ ] **Step 2: Add collapse state (localStorage-backed).** Near the other `useState` in `AdminConsoleClient`, add a set of expanded folded-group names, seeded from localStorage (default: all collapsed):

```ts
const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem("idream.admin.openNavGroups");
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
});
const toggleGroup = useCallback((group: string) => {
  setOpenGroups((prev) => {
    const next = new Set(prev);
    next.has(group) ? next.delete(group) : next.add(group);
    try { window.localStorage.setItem("idream.admin.openNavGroups", JSON.stringify([...next])); } catch { /* ignore */ }
    return next;
  });
}, []);
```

- [ ] **Step 3: Rewrite the desktop sidebar body (the `navItems.map` at ~819-886).** Replace the flat map with: (a) a pinned "常用" section rendering `NAV_DAILY` as links (reuse the existing `<Link>` markup — icon + `t(item.label)` + active state); (b) each `NAV_FOLDED_GROUPS` entry as a collapsible: a header `<button onClick={() => toggleGroup(group)}>` showing `t(group)` + a chevron rotated by `openGroups.has(group)`, and, when open, the group's items as the same `<Link>` markup. Preserve the existing active-item styling and `sidebarNavRef`/wheel behavior. Keep the mobile nav (~line 909) as a flat `navItems.map` (mobile doesn't need collapse) OR render `NAV_DAILY` there for parity — either is fine; do not break it.

Reference: the existing link markup is
```tsx
<Link className={cn("mb-1 flex h-10 items-center gap-3 rounded-md px-3 text-[13px] font-medium text-[rgb(170,170,170)] transition-colors hover:bg-white/10 hover:text-white", active && "bg-white/10 text-white")} href={item.href}>
  <Icon className="h-4 w-4" /><span>{t(item.label)}</span>{active ? <ChevronRight className="ml-auto h-4 w-4" /> : null}
</Link>
```
Extract a small `NavLink({ item })` helper to avoid duplicating it between the daily section and the folded groups.

- [ ] **Step 4: Add i18n for the group headers + "常用".** In `i18n.tsx` add zh for the folded-group keys used by `t(group)`: `CharacterConfig`→角色配置, `GenerationConfig`→生成配置, `Media`→图片, `Business`→业务, `Insights`→洞察, `Engineering`→工程诊断, `System`→系统, and `Daily`→常用 (if the daily section renders a header). (`Media`/`Insights`/`System` may already exist — grep `i18n.tsx` and don't duplicate.)

- [ ] **Step 5: Verify** — `cd packages/main && bun run typecheck && bun run lint` → clean. Manual smoke (scratch dev server or existing admin): default sidebar shows the 7 daily items + 7 collapsed group headers (not 34 flat); clicking a header expands/collapses its items; an active folded item's group auto-visible or reachable; reload preserves expanded groups; Engineering group is collapsed by default.

- [ ] **Step 6: Commit**

```bash
git add packages/main/src/components/admin/AdminConsoleClient.tsx packages/main/src/components/admin/i18n.tsx
git commit -m "feat(admin): progressive-disclosure sidebar (daily pinned + collapsible groups)"
```

---

## Task 3: Guided Dashboard (attention + task cards)

**Files:** Modify `packages/main/src/components/admin/AdminConsoleClient.tsx` (`DashboardView` at ~2260).

- [ ] **Step 1: Rebuild `DashboardView` into three stacked sections.** Keep the signature `function DashboardView({ data }: { data: DashboardData })`. Render, top to bottom:
  1. **需要你处理的 (attention)** — a row of clickable stat tiles linking to the relevant screen:
     - 失败/blocked 任务 → `data.metrics.generation.failed + data.metrics.generation.blocked`, links `/admin/generation/jobs`.
     - 待处理举报 → `data.metrics.moderation.openReports`, links `/admin/moderation`.
     - 待审提交 → fetched client-side count of pending character submissions from `/api/v1/admin/content/review-queue` (see Step 2), links `/admin/content/review-queue`.
     - 待处理工单 → fetched client-side count of open support requests from `/api/v1/admin/support/requests` (Step 2), links `/admin/support`.
     Each tile: label + count + a subtle "去处理" affordance; use `next/link` `<Link>`.
  2. **常用任务 (task launcher)** — three `<Link>` cards: 上架新角色 → `/admin/content/official`, 生产一批图 → `/admin/content/production`, 去审核 → `/admin/content/review-queue`.
  3. **健康概览** — the existing `Metric` grid (keep the current metrics markup, move it below the two new sections; smaller heading).

- [ ] **Step 2: Client-fetch the 2 counts (zero new API).** Inside `DashboardView`, `useEffect` to fetch the two lists and set counts (reuse `apiGet`):

```tsx
const [pending, setPending] = useState<{ submissions: number | null; tickets: number | null }>({ submissions: null, tickets: null });
useEffect(() => {
  let cancelled = false;
  void (async () => {
    try {
      const [rq, sup] = await Promise.all([
        apiGet<{ items: unknown[] }>("/api/v1/admin/content/review-queue?status=pending"),
        apiGet<{ items: unknown[] }>("/api/v1/admin/support/requests?status=active"),
      ]);
      if (!cancelled) setPending({ submissions: rq.items.length, tickets: sup.items.length });
    } catch {
      if (!cancelled) setPending({ submissions: null, tickets: null });
    }
  })();
  return () => { cancelled = true; };
}, []);
```
Render `null` counts as "—" (do not block the panel on the fetch; the two DashboardData-sourced tiles always show).

- [ ] **Step 3: i18n** — add zh for any new display strings ("需要你处理的"→需要你处理的, "常用任务"→常用任务, "失败/blocked 任务", "待审提交", "待处理举报", "待处理工单", "上架新角色", "生产一批图", "去审核", "去处理", "健康概览"). Keep DB names untouched (display copy only).

- [ ] **Step 4: Verify** — `cd packages/main && bun run typecheck && bun run lint` → clean. Manual smoke: `/admin` shows the attention row (4 tiles, 2 with live counts, all clickable through to the right screen), the 3 task cards route correctly, and the health metrics render below. Empty/failed fetch shows "—", not a broken state.

- [ ] **Step 5: Commit**

```bash
git add packages/main/src/components/admin/AdminConsoleClient.tsx packages/main/src/components/admin/i18n.tsx
git commit -m "feat(admin): guided Dashboard (attention panel + task cards)"
```

---

## Task 4: Final verification

- [ ] **Step 1: Gates** — `cd packages/main && bun run lint && bun run typecheck`, then `bunx vitest run src/components/admin/nav-config.test.ts src/components/admin/i18n-nav.test.ts` → all pass.
- [ ] **Step 2: Nothing lost** — click every daily item + expand every folded group; confirm all 34 screens still reachable, no white screen, no console error. Confirm Engineering group collapsed by default; reload preserves expansion.
- [ ] **Step 3: Zero DB/API drift** — `git diff --name-only master...HEAD | grep -E "schema.prisma|src/app/api|src/server" || echo "OK: presentation only"` → OK line.
- [ ] **Step 4: Close the spec** — set `docs/superpowers/specs/2026-07-09-admin-guided-nav-design.md` status → `已实现 (表现层)`; commit.

## Self-Review
- Spec §2 sidebar → Task 1 (tier data) + Task 2 (render). §3 Dashboard → Task 3. §4 files/zero-DB → matches. §5 acceptance → Task 4.
- Placeholder scan: none — nav-config code is exact; render described against the real existing markup with a NavLink extraction; DashboardView data sources named.
- Type consistency: `tier` field, `NAV_DAILY`/`NAV_FOLDED_GROUPS`, `openGroups`/`toggleGroup`, `pending` state used consistently across tasks.
