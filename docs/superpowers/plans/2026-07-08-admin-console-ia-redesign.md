# Admin Console IA Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the admin console's Generation Ops + Content Ops into three pipeline groups (角色 / 生成 / 图片), un-bury the prompt-recipes & presets screens, merge the two image-production entries, and unify the collided vocabulary — presentation layer only.

**Architecture:** The admin console is one giant client component (`packages/main/src/components/admin/AdminConsoleClient.tsx`, ~7300 lines) plus per-screen `*View` components. A flat `navItems` array drives the sidebar; four places must stay in sync (`navItems`, `normalizeSection`, `fetchSection`, `renderSection`). We extract `navItems` + `normalizeSection` into a small tested SSoT module, reshape the nav, carve the buried `ConfigView` tabs into their own nav destinations, and merge `ProductionStudioView` + `CharacterPregenPanel` into one `ImageProductionView`. No schema, no API, no new endpoints.

**Tech Stack:** Next.js 16, React 19, TypeScript strict, Tailwind v4, lucide-react icons, vitest (node env), bun + turbo.

## Global Constraints

- **Zero DB migration, zero API change.** Do not touch `schema.prisma` or any `/api/v1/admin/**` route/handler. Reuse existing endpoints and existing `*View` components verbatim. Renames happen in UI copy (`i18n.tsx` + nav labels) only.
- **TypeScript strict, no `any`.** Named exports, PascalCase components, camelCase utils, 2-space indent, Tailwind utilities (no inline styles).
- **The four-place sync rule:** any section id that appears in `navItems` MUST be accepted by `normalizeSection` and handled by both `fetchSection` and `renderSection`, or the screen white-screens. After this refactor `normalizeSection` derives its known-id set from `navItems`, so `navItems` is the single source of truth for valid ids.
- **Canonical vocabulary (UI copy only — DB names unchanged):**
  | DB / concept | New EN nav label | New ZH label |
  |---|---|---|
  | `GenerationModelProfile` | `Model Profiles` | `模型配置` |
  | `GenerationPromptTemplate` | `Prompt Recipes` | `提示词配方` |
  | `GenerationPreset` | `Presets` | `预设` |
  | `CharacterTemplate` | `Character Starters` | `角色起始模板` |
  | `CharacterSubmission` review | `Character Review` | `角色审核队列` |
  | pregen/production | `Image Production` | `图片生产` |
  | asset library | `Image Library` | `图片库` |
  | featured curation | `Featured` | `精选` |
  | `CharacterVisualProfile` (角色页 tab) | `Visual Identity` | `视觉身份` |
  - **CONFIRMED (2026-07-08):** use the **existing** `模型配置` for `GenerationModelProfile` (already used by ~15 strings in `i18n.tsx`). The user chose this over the spec's `模型档案` to avoid a 档案/配置 split. Do **not** introduce `模型档案`.
  - **CONFIRMED (2026-07-08):** the `Visual Passport` → `视觉身份` panel rename (spec §6.3) IS in scope this round (Task 4). It disambiguates "profile" (模型配置 vs 视觉身份). Only the displayed label changes — component/file/DB names (`VisualPassportPanel`, `CharacterVisualProfile`) stay.
- **Three new group keys** (English keys passed through `t()`): `Characters` → `角色`, `Generation` → `生成` (already in dict), `Media` → `图片`.
- **Nav group order:** `Overview`, `Characters`, `Generation`, `Media`, `Trust Ops`, `Business Ops`, `Insights`, `System`. The last four groups + `Overview` are copied **verbatim** from the current array (do not renumber or relabel them).

---

## File Structure

**New files:**
- `packages/main/src/components/admin/nav-config.ts` — SSoT: `NavItem` type, `navItems`, `NAV_GROUP_ORDER`, `SECTION_ALIASES`, `normalizeSection`, `ConfigSlice` type, `configSliceForSection`. Owns nav data + section-id validation. No JSX.
- `packages/main/src/components/admin/nav-config.test.ts` — pure invariants: unique ids, migration completeness, group order, intra-domain-group icon uniqueness, `normalizeSection` behavior, `configSliceForSection` mapping.
- `packages/main/src/components/admin/ImageProductionView.tsx` — merges `ProductionStudioView` (batch) + `CharacterPregenPanel` (per-character, behind a character picker) under two tabs.

**Modified files:**
- `packages/main/src/components/admin/AdminConsoleClient.tsx` — import `navItems`/`normalizeSection`/`configSliceForSection` from nav-config (delete the in-file copies); add `fetchGenerationConfig` + slice routing; carve `ConfigView` (drop `templates` tab + presets-from-settings); add `PromptRecipesView` + `GenerationPresetsView`; swap production view to `ImageProductionView`.
- `packages/main/src/components/admin/i18n.tsx` — add zh entries for new group headers + renamed/new labels; export `hasAdminZh`.

**Test prerequisite:** vitest here runs a global Postgres setup for every `*.test.ts` (`vitest.config.ts` → `globalSetup`, `environment: "node"`, `include: ["src/**/*.test.ts"]`). Start the test DB before running vitest (repo convention: compose Postgres on `localhost:5433`, or set `TEST_DATABASE_URL`). The new tests are pure logic but still pay the global-setup cost. `bun run typecheck` needs no DB and is the fast inner-loop gate.

Run a single test file: `cd packages/main && bunx vitest run src/components/admin/nav-config.test.ts`

---

## Task 1: Extract nav config + normalizeSection into a tested SSoT module

Pure refactor — **no visual/behavior change**. Establishes the tested single-source-of-truth that the later tasks build on.

**Files:**
- Create: `packages/main/src/components/admin/nav-config.ts`
- Create (test): `packages/main/src/components/admin/nav-config.test.ts`
- Modify: `packages/main/src/components/admin/AdminConsoleClient.tsx` (delete in-file `navItems` at 625-658 and `normalizeSection` at 7219-7253; import from nav-config)

**Interfaces:**
- Produces: `export type NavItem = { id: string; label: string; href: string; icon: LucideIcon; group: string }`; `export const navItems: NavItem[]`; `export const NAV_GROUP_ORDER: string[]`; `export function normalizeSection(value: string): string`.

- [ ] **Step 1: Write the failing test**

Create `packages/main/src/components/admin/nav-config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { navItems, normalizeSection, NAV_GROUP_ORDER } from "./nav-config";

describe("nav-config (baseline SSoT)", () => {
  it("has unique section ids", () => {
    const ids = navItems.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every href matches /admin/<id> (dashboard = /admin)", () => {
    for (const item of navItems) {
      const expected = item.id === "dashboard" ? "/admin" : `/admin/${item.id}`;
      expect(item.href).toBe(expected);
    }
  });

  it("normalizeSection returns each known id unchanged", () => {
    for (const item of navItems) {
      expect(normalizeSection(item.id)).toBe(item.id);
    }
  });

  it("normalizeSection aliases generation/models to generation/config", () => {
    expect(normalizeSection("generation/models")).toBe("generation/config");
  });

  it("normalizeSection falls back to dashboard for unknown ids", () => {
    expect(normalizeSection("nope/nope")).toBe("dashboard");
  });

  it("NAV_GROUP_ORDER lists each group once, in first-seen order", () => {
    expect(new Set(NAV_GROUP_ORDER).size).toBe(NAV_GROUP_ORDER.length);
    expect(NAV_GROUP_ORDER[0]).toBe("Overview");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/main && bunx vitest run src/components/admin/nav-config.test.ts`
Expected: FAIL — `Cannot find module './nav-config'`.

- [ ] **Step 3: Create nav-config.ts (verbatim current data + derived normalizeSection)**

Create `packages/main/src/components/admin/nav-config.ts`. Copy the **current** `navItems` verbatim (labels/icons/groups/order unchanged — Task 2 reshapes it):

```ts
import {
  Activity,
  AlertTriangle,
  BadgeDollarSign,
  BarChart3,
  Bookmark,
  ClipboardCheck,
  Coins,
  FileText,
  Flag,
  Gauge,
  History,
  ImageIcon,
  Inbox,
  Library,
  MessageSquare,
  Play,
  Server,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Ticket,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  group: string;
};

export const navItems: NavItem[] = [
  { id: "dashboard", label: "Dashboard", href: "/admin", icon: Gauge, group: "Overview" },
  { id: "generation/jobs", label: "Jobs & Incidents", href: "/admin/generation/jobs", icon: Activity, group: "Generation Ops" },
  { id: "generation/config", label: "Profiles & Rollout", href: "/admin/generation/config", icon: SlidersHorizontal, group: "Generation Ops" },
  { id: "generation/dead-letter", label: "Dead-letter", href: "/admin/generation/dead-letter", icon: Inbox, group: "Generation Ops" },
  { id: "ops/providers", label: "Provider Health", href: "/admin/ops/providers", icon: Server, group: "Generation Ops" },
  { id: "generation/backends", label: "Backends", href: "/admin/generation/backends", icon: Server, group: "Generation Ops" },
  { id: "generation/workflows", label: "Workflows", href: "/admin/generation/workflows", icon: Workflow, group: "Generation Ops" },
  { id: "generation/metrics", label: "Metrics", href: "/admin/generation/metrics", icon: BarChart3, group: "Generation Ops" },
  { id: "content/production", label: "Production Studio", href: "/admin/content/production", icon: Play, group: "Content Ops" },
  { id: "content/assets", label: "Asset Library", href: "/admin/content/assets", icon: ImageIcon, group: "Content Ops" },
  { id: "content/placements", label: "Placements", href: "/admin/content/placements", icon: Bookmark, group: "Content Ops" },
  { id: "content", label: "Content", href: "/admin/content", icon: Library, group: "Content Ops" },
  { id: "content/official", label: "Official Characters", href: "/admin/content/official", icon: ShieldCheck, group: "Content Ops" },
  { id: "content/templates", label: "Templates", href: "/admin/content/templates", icon: SlidersHorizontal, group: "Content Ops" },
  { id: "content/tags", label: "Tags", href: "/admin/content/tags", icon: Flag, group: "Content Ops" },
  { id: "content/review-queue", label: "Review Queue", href: "/admin/content/review-queue", icon: ClipboardCheck, group: "Content Ops" },
  { id: "cms", label: "CMS / SEO", href: "/admin/cms", icon: FileText, group: "Content Ops" },
  { id: "moderation", label: "Moderation", href: "/admin/moderation", icon: ShieldAlert, group: "Trust Ops" },
  { id: "chat", label: "Chat Ops", href: "/admin/chat", icon: MessageSquare, group: "Trust Ops" },
  { id: "support", label: "Support Requests", href: "/admin/support", icon: Ticket, group: "Trust Ops" },
  { id: "users", label: "Users", href: "/admin/users", icon: Users, group: "Business Ops" },
  { id: "billing", label: "Billing", href: "/admin/billing", icon: BadgeDollarSign, group: "Business Ops" },
  { id: "pricing", label: "Pricing", href: "/admin/pricing", icon: Coins, group: "Business Ops" },
  { id: "promo", label: "Promo", href: "/admin/promo", icon: Ticket, group: "Business Ops" },
  { id: "announcements", label: "Announcements", href: "/admin/announcements", icon: MessageSquare, group: "Business Ops" },
  { id: "analytics", label: "Analytics", href: "/admin/analytics", icon: BarChart3, group: "Insights" },
  { id: "insights", label: "Insights", href: "/admin/insights", icon: BarChart3, group: "Insights" },
  { id: "experiments", label: "Experiments", href: "/admin/experiments", icon: Flag, group: "Insights" },
  { id: "risk", label: "Risk & Abuse", href: "/admin/risk", icon: AlertTriangle, group: "Insights" },
  { id: "compliance", label: "Compliance", href: "/admin/compliance", icon: ShieldAlert, group: "System" },
  { id: "approvals", label: "Approvals", href: "/admin/approvals", icon: ClipboardCheck, group: "System" },
  { id: "audit-log", label: "Audit Log", href: "/admin/audit-log", icon: History, group: "System" },
];

export const NAV_GROUP_ORDER: string[] = navItems.reduce<string[]>((groups, item) => {
  if (!groups.includes(item.group)) groups.push(item.group);
  return groups;
}, []);

const KNOWN_SECTION_IDS = new Set(navItems.map((item) => item.id));

const SECTION_ALIASES: Record<string, string> = {
  "generation/models": "generation/config",
};

// SPEC: normalize an incoming route section to a known nav id; unknown → dashboard.
// INVARIANT: the known-id set is derived from navItems, so navItems is the SSoT.
export function normalizeSection(value: string): string {
  const mapped = SECTION_ALIASES[value] ?? value;
  return KNOWN_SECTION_IDS.has(mapped) ? mapped : "dashboard";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/main && bunx vitest run src/components/admin/nav-config.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Point AdminConsoleClient at the module**

In `AdminConsoleClient.tsx`:
1. Delete the in-file `const navItems = [ … ];` block (currently lines 625-658).
2. Delete the in-file `function normalizeSection(value: string) { … }` (currently 7219-7253).
3. Add to the existing i18n/import block near the top:

```ts
import { navItems, normalizeSection } from "@/components/admin/nav-config";
```

4. Remove now-unused icon imports from the lucide-react import block **only if** they are no longer referenced anywhere else in `AdminConsoleClient.tsx` (let typecheck/lint tell you — `eslint` flags unused imports). Do not remove icons still used by buttons/actions.

- [ ] **Step 6: Verify typecheck + full test file**

Run: `cd packages/main && bun run typecheck`
Expected: no errors.
Run: `cd packages/main && bunx vitest run src/components/admin/nav-config.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/main/src/components/admin/nav-config.ts packages/main/src/components/admin/nav-config.test.ts packages/main/src/components/admin/AdminConsoleClient.tsx
git commit -m "refactor(admin): extract navItems + normalizeSection into tested nav-config SSoT"
```

---

## Task 2: Reshape nav into 角色 / 生成 / 图片 and split ConfigView

Reorders/regroups/relabels `navItems`, adds the two un-buried destinations (`generation/recipes`, `generation/presets`), and carves `ConfigView`'s buried tabs into their own screens. These are one unit because a new nav item without its routing white-screens (Global Constraint: four-place sync).

**Files:**
- Modify: `packages/main/src/components/admin/nav-config.ts` (new navItems + `ConfigSlice`/`configSliceForSection`)
- Modify: `packages/main/src/components/admin/nav-config.test.ts` (migration + slice invariants)
- Modify: `packages/main/src/components/admin/AdminConsoleClient.tsx` (`SectionData` config variant, `fetchGenerationConfig`, `fetchSection` slice routing, `renderSection` config branch, `ConfigView` carve, new `PromptRecipesView` + `GenerationPresetsView`, `ConfigTab` type trim)

**Interfaces:**
- Consumes (from Task 1): `navItems`, `normalizeSection`.
- Produces: `export type ConfigSlice = "profiles" | "recipes" | "presets"`; `export function configSliceForSection(sectionId: string): ConfigSlice | null`. New nav ids `generation/recipes`, `generation/presets`. New in-file components `PromptRecipesView`, `GenerationPresetsView`.

- [ ] **Step 1: Write the failing tests (migration completeness + slice map)**

Append to `packages/main/src/components/admin/nav-config.test.ts`:

```ts
import { configSliceForSection } from "./nav-config";

// Frozen snapshot of the pre-redesign section ids — none may be lost.
const ORIGINAL_IDS = [
  "dashboard", "generation/jobs", "generation/config", "generation/dead-letter",
  "ops/providers", "generation/backends", "generation/workflows", "generation/metrics",
  "content/production", "content/assets", "content/placements", "content",
  "content/official", "content/templates", "content/tags", "content/review-queue",
  "cms", "moderation", "chat", "support", "users", "billing", "pricing", "promo",
  "announcements", "analytics", "insights", "experiments", "risk", "compliance",
  "approvals", "audit-log",
];

function idsInGroup(group: string) {
  return navItems.filter((item) => item.group === group).map((item) => item.id);
}

describe("nav-config (redesigned IA)", () => {
  it("keeps every original screen (nothing lost in migration)", () => {
    const ids = new Set(navItems.map((item) => item.id));
    for (const id of ORIGINAL_IDS) expect(ids.has(id)).toBe(true);
  });

  it("orders groups as the three pipeline groups between Overview and Trust Ops", () => {
    expect(NAV_GROUP_ORDER).toEqual([
      "Overview", "Characters", "Generation", "Media",
      "Trust Ops", "Business Ops", "Insights", "System",
    ]);
  });

  it("puts each concept in exactly one declared home", () => {
    expect(idsInGroup("Characters")).toEqual([
      "content/official", "content/templates", "content/review-queue", "content/tags",
    ]);
    expect(idsInGroup("Generation")).toEqual([
      "generation/config", "generation/recipes", "generation/presets",
      "generation/workflows", "generation/backends", "ops/providers",
      "generation/jobs", "generation/dead-letter", "generation/metrics",
    ]);
    expect(idsInGroup("Media")).toEqual([
      "content/production", "content/assets", "content/placements", "content", "cms",
    ]);
  });

  it("uses distinct icons within each pipeline group", () => {
    for (const group of ["Characters", "Generation", "Media"]) {
      const icons = navItems.filter((i) => i.group === group).map((i) => i.icon);
      expect(new Set(icons).size).toBe(icons.length);
    }
  });

  it("maps generation config sections to slices", () => {
    expect(configSliceForSection("generation/config")).toBe("profiles");
    expect(configSliceForSection("generation/recipes")).toBe("recipes");
    expect(configSliceForSection("generation/presets")).toBe("presets");
    expect(configSliceForSection("content/tags")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/main && bunx vitest run src/components/admin/nav-config.test.ts`
Expected: FAIL — `configSliceForSection` not exported; group order/membership assertions fail.

- [ ] **Step 3: Rewrite navItems + add slice helper in nav-config.ts**

Replace the `navItems` array in `nav-config.ts` with the reshaped version, and add `Layers`, `ScrollText`, `Sparkles` to the lucide import (and keep the rest). Replace the three domain groups; copy `Overview` + `Trust Ops` + `Business Ops` + `Insights` + `System` rows **verbatim** from Task 1:

```ts
// add to the lucide-react import: Layers, ScrollText, Sparkles
export const navItems: NavItem[] = [
  { id: "dashboard", label: "Dashboard", href: "/admin", icon: Gauge, group: "Overview" },

  // ① 角色 Characters
  { id: "content/official", label: "Official Characters", href: "/admin/content/official", icon: ShieldCheck, group: "Characters" },
  { id: "content/templates", label: "Character Starters", href: "/admin/content/templates", icon: Sparkles, group: "Characters" },
  { id: "content/review-queue", label: "Character Review", href: "/admin/content/review-queue", icon: ClipboardCheck, group: "Characters" },
  { id: "content/tags", label: "Tags", href: "/admin/content/tags", icon: Flag, group: "Characters" },

  // ② 生成 Generation
  { id: "generation/config", label: "Model Profiles", href: "/admin/generation/config", icon: SlidersHorizontal, group: "Generation" },
  { id: "generation/recipes", label: "Prompt Recipes", href: "/admin/generation/recipes", icon: ScrollText, group: "Generation" },
  { id: "generation/presets", label: "Presets", href: "/admin/generation/presets", icon: Layers, group: "Generation" },
  { id: "generation/workflows", label: "Workflows", href: "/admin/generation/workflows", icon: Workflow, group: "Generation" },
  { id: "generation/backends", label: "Backends", href: "/admin/generation/backends", icon: Server, group: "Generation" },
  { id: "ops/providers", label: "Provider Health", href: "/admin/ops/providers", icon: Gauge, group: "Generation" },
  { id: "generation/jobs", label: "Jobs & Incidents", href: "/admin/generation/jobs", icon: Activity, group: "Generation" },
  { id: "generation/dead-letter", label: "Dead-letter", href: "/admin/generation/dead-letter", icon: Inbox, group: "Generation" },
  { id: "generation/metrics", label: "Metrics", href: "/admin/generation/metrics", icon: BarChart3, group: "Generation" },

  // ③ 图片 Media
  { id: "content/production", label: "Image Production", href: "/admin/content/production", icon: Play, group: "Media" },
  { id: "content/assets", label: "Image Library", href: "/admin/content/assets", icon: ImageIcon, group: "Media" },
  { id: "content/placements", label: "Placements", href: "/admin/content/placements", icon: Bookmark, group: "Media" },
  { id: "content", label: "Featured", href: "/admin/content", icon: Library, group: "Media" },
  { id: "cms", label: "CMS / SEO", href: "/admin/cms", icon: FileText, group: "Media" },

  // untouched groups (verbatim)
  { id: "moderation", label: "Moderation", href: "/admin/moderation", icon: ShieldAlert, group: "Trust Ops" },
  { id: "chat", label: "Chat Ops", href: "/admin/chat", icon: MessageSquare, group: "Trust Ops" },
  { id: "support", label: "Support Requests", href: "/admin/support", icon: Ticket, group: "Trust Ops" },
  { id: "users", label: "Users", href: "/admin/users", icon: Users, group: "Business Ops" },
  { id: "billing", label: "Billing", href: "/admin/billing", icon: BadgeDollarSign, group: "Business Ops" },
  { id: "pricing", label: "Pricing", href: "/admin/pricing", icon: Coins, group: "Business Ops" },
  { id: "promo", label: "Promo", href: "/admin/promo", icon: Ticket, group: "Business Ops" },
  { id: "announcements", label: "Announcements", href: "/admin/announcements", icon: MessageSquare, group: "Business Ops" },
  { id: "analytics", label: "Analytics", href: "/admin/analytics", icon: BarChart3, group: "Insights" },
  { id: "insights", label: "Insights", href: "/admin/insights", icon: BarChart3, group: "Insights" },
  { id: "experiments", label: "Experiments", href: "/admin/experiments", icon: Flag, group: "Insights" },
  { id: "risk", label: "Risk & Abuse", href: "/admin/risk", icon: AlertTriangle, group: "Insights" },
  { id: "compliance", label: "Compliance", href: "/admin/compliance", icon: ShieldAlert, group: "System" },
  { id: "approvals", label: "Approvals", href: "/admin/approvals", icon: ClipboardCheck, group: "System" },
  { id: "audit-log", label: "Audit Log", href: "/admin/audit-log", icon: History, group: "System" },
];
```

Then append the slice helper at the end of `nav-config.ts`:

```ts
export type ConfigSlice = "profiles" | "recipes" | "presets";

// SPEC: which slice of the generation-config data a section renders.
// generation/config → model profiles; /recipes → prompt recipes; /presets → presets.
export function configSliceForSection(sectionId: string): ConfigSlice | null {
  if (sectionId === "generation/config") return "profiles";
  if (sectionId === "generation/recipes") return "recipes";
  if (sectionId === "generation/presets") return "presets";
  return null;
}
```

- [ ] **Step 4: Run to verify nav-config tests pass**

Run: `cd packages/main && bunx vitest run src/components/admin/nav-config.test.ts`
Expected: PASS (all baseline + redesigned-IA tests).

- [ ] **Step 5: Add the config `slice` to SectionData + a shared fetch**

In `AdminConsoleClient.tsx`:

1. Import the slice helper — extend the existing nav-config import:

```ts
import { navItems, normalizeSection, configSliceForSection, type ConfigSlice } from "@/components/admin/nav-config";
```

2. Change the `SectionData` config member (currently line 206) to carry the slice:

```ts
  | { kind: "config"; data: ConfigData; slice: ConfigSlice }
```

3. Add a shared fetch near `fetchSection` (above it):

```ts
async function fetchGenerationConfig(): Promise<ConfigData> {
  const [profiles, templates, presets, flags, jobs] = await Promise.all([
    apiGet<{ items: Row[] }>("/api/v1/admin/generation/model-profiles"),
    apiGet<{ items: Row[] }>("/api/v1/admin/generation/prompt-templates"),
    apiGet<{ items: Row[] }>("/api/v1/admin/generation/presets"),
    apiGet<{ items: Row[] }>("/api/v1/admin/feature-flags"),
    apiGet<{ items: Row[] }>("/api/v1/admin/generation/jobs?mode=image&limit=12"),
  ]);
  return {
    profiles: profiles.items,
    templates: templates.items,
    presets: presets.items,
    flags: flags.items,
    recentJobs: jobs.items,
  };
}
```

4. Replace the existing `if (sectionId === "generation/config") { … }` block in `fetchSection` (currently 1197-1215) with:

```ts
  const configSlice = configSliceForSection(sectionId);
  if (configSlice) {
    return { kind: "config", data: await fetchGenerationConfig(), slice: configSlice };
  }
```

(Leave the `generation/models` recursion at 1190-1192 as-is; `normalizeSection` already remaps it, so it resolves to the `profiles` slice.)

- [ ] **Step 6: Route the three slices in renderSection**

In `AdminConsoleClient.tsx`, replace the `if (section.kind === "config") { return <ConfigView … /> }` block (currently 2161-2175) with:

```ts
  if (section.kind === "config") {
    if (section.slice === "recipes") {
      return (
        <PromptRecipesView
          configBusy={ctx.configBusy}
          createPromptTemplate={ctx.createPromptTemplate}
          data={section.data}
          openAction={ctx.openAction}
          setTemplateDraft={ctx.setTemplateDraft}
          templateDraft={ctx.templateDraft}
        />
      );
    }
    if (section.slice === "presets") {
      return <GenerationPresetsView data={section.data} />;
    }
    return (
      <ConfigView
        data={section.data}
        openAction={ctx.openAction}
        reload={ctx.reload}
        selectedProfileId={ctx.selectedProfileId}
        setSelectedProfileId={ctx.setSelectedProfileId}
      />
    );
  }
```

- [ ] **Step 7: Carve ConfigView (drop templates tab + presets-from-settings) and add the two carved views**

In `AdminConsoleClient.tsx`:

1. Trim the `ConfigTab` type (currently line 157) — drop `"templates"`:

```ts
type ConfigTab = "drafts" | "published" | "settings";
```

2. Update `configTabValue` (currently 7157-7163) to drop `"templates"`:

```ts
function configTabValue(value: string | null): ConfigTab | null {
  if (value === "create") return "drafts";
  if (value === "drafts" || value === "published" || value === "settings") {
    return value;
  }
  return null;
}
```

3. Rewrite `ConfigView` (3103-3236). Remove the four props that only served the templates tab (`configBusy`, `createPromptTemplate`, `setTemplateDraft`, `templateDraft`), delete the `templates` tab body, and reduce the `settings` body to feature flags only:

```tsx
function ConfigView({
  data,
  openAction,
  reload,
  selectedProfileId,
  setSelectedProfileId,
}: {
  data: ConfigData;
  openAction: (action: PendingAction) => void;
  reload: () => void | Promise<void>;
  selectedProfileId: string | null;
  setSelectedProfileId: (value: string | null) => void;
}) {
  const [initialUrlState] = useState(() => readConfigUrlState());
  const [configTab, setConfigTab] = useState<ConfigTab>(() => initialUrlState.tab ?? "drafts");
  const selectedProfile = useMemo(
    () => selectedGenerationProfile(data.profiles, selectedProfileId),
    [data.profiles, selectedProfileId],
  );
  const draftProfiles = useMemo(
    () => data.profiles.filter((profile) => stringValue(profile.status) === "draft"),
    [data.profiles],
  );
  const publishedProfiles = useMemo(
    () => data.profiles.filter((profile) => stringValue(profile.status) !== "draft"),
    [data.profiles],
  );
  const tabCounts = useMemo<Record<ConfigTab, number | string>>(
    () => ({
      drafts: draftProfiles.length,
      published: publishedProfiles.length,
      settings: data.flags.length,
    }),
    [data.flags.length, draftProfiles.length, publishedProfiles.length],
  );

  useEffect(() => {
    if (selectedProfileId || !selectedProfile) return;
    const profileId = stringValue(selectedProfile.id);
    if (profileId) setSelectedProfileId(profileId);
  }, [selectedProfile, selectedProfileId, setSelectedProfileId]);

  return (
    <div className="space-y-6">
      <ConfigOverviewHeader jobs={data.recentJobs} profiles={data.profiles} templates={data.templates} />
      <ConfigTabNav active={configTab} counts={tabCounts} onChange={setConfigTab} />

      {configTab === "drafts" && (
        <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(360px,440px)_minmax(0,1fr)]">
          <ProfileDraftManager
            drafts={draftProfiles}
            jobs={data.recentJobs}
            onOpenAction={openAction}
            onSelectProfile={setSelectedProfileId}
            selectedProfileId={selectedProfileId}
          />
          <ProfileReleaseWorkbench
            jobs={data.recentJobs}
            onOpenAction={openAction}
            onReload={reload}
            onSelectProfile={setSelectedProfileId}
            profiles={data.profiles}
            selectedProfile={selectedProfile}
          />
        </div>
      )}

      {configTab === "published" && (
        <DataTable
          actions={(row) => profileTableActions(row, openAction, setSelectedProfileId)}
          columns={[
            "id", "profileKey", "label", "mode", "runner", "pipelineModel",
            "status", "version", "enabled", "rolloutPercent", "requiredEntitlement", "dryRunSummary",
          ]}
          rows={publishedProfiles}
          title="Published profiles"
        />
      )}

      {configTab === "settings" && (
        <DataTable
          actions={(row) => featureFlagActions(row, openAction)}
          columns={["key", "enabled", "rolloutPercent", "version", "hardPolicy"]}
          rows={data.flags}
          title="Feature Flags"
        />
      )}
    </div>
  );
}
```

4. Update `ConfigTabNav` (2946-…) so its `items` array drops the `templates` entry. Locate the `const items: Array<{ id: ConfigTab; label: string; meta: string }> = [ … ]` and remove the object whose `id` is `"templates"`. Keep `drafts`, `published`, `settings`.

5. Add the two carved views immediately after `ConfigView` (reusing the in-file `PromptTemplateDraftForm`, `DataTable`, `templateTableActions`):

```tsx
function PromptRecipesView({
  configBusy,
  createPromptTemplate,
  data,
  openAction,
  setTemplateDraft,
  templateDraft,
}: {
  configBusy: "template" | null;
  createPromptTemplate: () => void;
  data: ConfigData;
  openAction: (action: PendingAction) => void;
  setTemplateDraft: (value: TemplateDraft) => void;
  templateDraft: TemplateDraft;
}) {
  return (
    <div className="space-y-6">
      <PromptTemplateDraftForm
        busy={configBusy === "template"}
        draft={templateDraft}
        onCreate={createPromptTemplate}
        onDraftChange={setTemplateDraft}
      />
      <DataTable
        actions={(row) => templateTableActions(row, openAction)}
        columns={["id", "templateKey", "label", "mode", "useCase", "status", "version"]}
        rows={data.templates}
        title="Prompt Recipes"
      />
    </div>
  );
}

function GenerationPresetsView({ data }: { data: ConfigData }) {
  return (
    <div className="space-y-6">
      <DataTable
        columns={["id", "type", "category", "label", "visibility", "status"]}
        rows={data.presets}
        title="Built-in Presets"
      />
    </div>
  );
}
```

- [ ] **Step 8: Verify typecheck + tests**

Run: `cd packages/main && bun run typecheck`
Expected: no errors. (If `ConfigData.templates`/`presets` now flag as unused in some path, they are still consumed by `ConfigOverviewHeader`/the carved views — leave them.)
Run: `cd packages/main && bunx vitest run src/components/admin/nav-config.test.ts`
Expected: PASS.

- [ ] **Step 9: Manual smoke (the four-place sync + carve)**

Run the admin dev server (`bun run dev:admin` from repo root, or `bun run dev` in packages/main) and open:
- `/admin/generation/config` → **Model Profiles**, tabs = Drafts / Published / Settings (Settings shows Feature Flags only, no presets table). No "Prompt Recipes" tab.
- `/admin/generation/recipes` → **Prompt Recipes** page (draft form + recipes table).
- `/admin/generation/presets` → **Presets** page (Built-in Presets table).
- Sidebar shows groups: Overview, 角色/Characters, 生成/Generation, 图片/Media, then Trust/Business/Insights/System.
Expected: all render, no white screen, no console error.

- [ ] **Step 10: Commit**

```bash
git add packages/main/src/components/admin/nav-config.ts packages/main/src/components/admin/nav-config.test.ts packages/main/src/components/admin/AdminConsoleClient.tsx
git commit -m "feat(admin): reshape nav into 角色/生成/图片 and un-bury prompt recipes + presets"
```

---

## Task 3: Merge Production Studio + Pregen into ImageProductionView

Gives the two image-production entries one home with a tab switch; the per-character pregen panel gains a standalone entry (via a character picker) instead of being reachable only from a character's edit page. The embedded pregen panel inside `OfficialCharactersView` stays as-is (nothing lost).

**Files:**
- Create: `packages/main/src/components/admin/ImageProductionView.tsx`
- Modify: `packages/main/src/components/admin/AdminConsoleClient.tsx` (swap `renderSection` production view + import)

**Interfaces:**
- Consumes: `ProductionStudioView` (no props) from `ContentOpsViews`; `CharacterPregenPanel({ characterId })` from `CharacterPregenPanel`; `apiGet` from `admin/api`; `useAdminI18n` from `admin/i18n`.
- Produces: `export function ImageProductionView(): JSX.Element`.

- [ ] **Step 1: Create ImageProductionView.tsx**

```tsx
"use client";

// SPEC: 图片生产合一 —— 通用批量 (ProductionStudioView) + 为角色生成 (CharacterPregenPanel)
//       两 tab 同壳。为角色生成需先选角色 (复用 /content/characters)，选中即挂 CharacterPregenPanel。
// INTENT: 纯前端合并，不新增生成链路/接口；两子组件均维持原有自取数行为。
import { useEffect, useState } from "react";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { cn } from "@/lib/utils";
import { ProductionStudioView } from "@/components/admin/ContentOpsViews";
import { CharacterPregenPanel } from "@/components/admin/CharacterPregenPanel";

type ProductionTab = "batch" | "character";
type CharacterOption = { id: string; name: string };

export function ImageProductionView() {
  const { t } = useAdminI18n();
  const [tab, setTab] = useState<ProductionTab>("batch");
  const [characters, setCharacters] = useState<CharacterOption[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");

  useEffect(() => {
    if (tab !== "character" || characters.length > 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const payload = await apiGet<{ items: Array<Record<string, unknown>> }>(
          "/api/v1/admin/content/characters",
        );
        if (cancelled) return;
        const options = payload.items
          .map((row) => ({ id: String(row.id ?? ""), name: String(row.name ?? row.id ?? "") }))
          .filter((row) => row.id.length > 0);
        setCharacters(options);
        setSelectedId((current) => current || options[0]?.id || "");
      } catch {
        if (!cancelled) setCharacters([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, characters.length]);

  return (
    <div className="space-y-5">
      <div className="flex gap-2 border-b border-white/10">
        <TabButton active={tab === "batch"} label={t("Batch production")} onClick={() => setTab("batch")} />
        <TabButton
          active={tab === "character"}
          label={t("Generate for character")}
          onClick={() => setTab("character")}
        />
      </div>

      {tab === "batch" ? (
        <ProductionStudioView />
      ) : (
        <div className="space-y-4">
          <label className="flex max-w-md flex-col gap-1 text-sm">
            <span className="text-[rgb(170,170,170)]">{t("Character")}</span>
            <select
              className="h-9 border border-white/10 bg-[rgb(18,18,18)] px-3 text-sm outline-none"
              onChange={(event) => setSelectedId(event.target.value)}
              value={selectedId}
            >
              {characters.length === 0 ? <option value="">{t("Loading…")}</option> : null}
              {characters.map((character) => (
                <option className="bg-[rgb(18,18,18)]" key={character.id} value={character.id}>
                  {character.name}
                </option>
              ))}
            </select>
          </label>
          {selectedId ? <CharacterPregenPanel characterId={selectedId} /> : null}
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "h-9 border-b-2 px-3 text-sm font-medium transition-colors",
        active
          ? "border-white text-white"
          : "border-transparent text-[rgb(170,170,170)] hover:text-white",
      )}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}
```

- [ ] **Step 2: Swap the production view in renderSection**

In `AdminConsoleClient.tsx`:
1. Add the import:

```ts
import { ImageProductionView } from "@/components/admin/ImageProductionView";
```

2. In `renderSection`'s `selfFetch` block, change the production line (currently 2254):

```ts
    if (section.view === "production") return <ImageProductionView />;
```

3. Remove the now-unused `ProductionStudioView` import from `AdminConsoleClient.tsx`'s `ContentOpsViews` import (keep `AssetLibraryView`, `PlacementsView`) — let eslint confirm it is unused there.

- [ ] **Step 3: Verify typecheck**

Run: `cd packages/main && bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Manual smoke**

Open `/admin/content/production` → header **Image Production**; two tabs: "Batch production" renders the old Production Studio; "Generate for character" shows a character `<select>` then the pregen packs panel for the chosen character (cover×4 / hero×4 / chat×8). Switching characters re-mounts the panel.
Expected: both tabs work; no console error; `/admin/content/official` still shows its embedded pregen panel (unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/main/src/components/admin/ImageProductionView.tsx packages/main/src/components/admin/AdminConsoleClient.tsx
git commit -m "feat(admin): merge Production Studio + character pregen into ImageProductionView"
```

---

## Task 4: Vocabulary — zh translations + Visual Identity rename

The nav labels and group headers render through `t()`. Add the zh entries so the redesigned IA reads correctly in Chinese, rename the character-page `Visual Passport` tab to `Visual Identity` / `视觉身份` (the last "profile" collision), and lock it with a test that the keys this refactor owns are all translated.

**Files:**
- Modify: `packages/main/src/components/admin/i18n.tsx` (add zh entries; export `hasAdminZh`)
- Modify: `packages/main/src/components/admin/VisualPassportPanel.tsx:92` (label `Visual Passport` → `Visual Identity`)
- Create (test): `packages/main/src/components/admin/i18n-nav.test.ts`

**Interfaces:**
- Produces: `export function hasAdminZh(key: string): boolean`.

- [ ] **Step 1: Write the failing test**

Create `packages/main/src/components/admin/i18n-nav.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hasAdminZh } from "./i18n";
import { navItems, NAV_GROUP_ORDER } from "./nav-config";

// Keys this redesign introduced or renamed — each must have a zh translation.
const OWNED_KEYS = [
  "Characters", "Generation", "Media", // group headers
  "Character Starters", "Character Review", "Model Profiles", "Prompt Recipes",
  "Presets", "Image Production", "Image Library", "Featured",
  "Batch production", "Generate for character", "Character",
  "Visual Identity",
];

describe("admin i18n — redesigned nav has zh", () => {
  it("translates every key this refactor owns", () => {
    for (const key of OWNED_KEYS) expect(hasAdminZh(key)).toBe(true);
  });

  it("translates all three pipeline group headers", () => {
    for (const group of NAV_GROUP_ORDER.filter((g) =>
      ["Characters", "Generation", "Media"].includes(g),
    )) {
      expect(hasAdminZh(group)).toBe(true);
    }
  });

  it("translates the labels of every Characters/Generation/Media nav item", () => {
    const owned = navItems.filter((i) => ["Characters", "Generation", "Media"].includes(i.group));
    for (const item of owned) expect(hasAdminZh(item.label)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/main && bunx vitest run src/components/admin/i18n-nav.test.ts`
Expected: FAIL — `hasAdminZh` not exported / keys missing.

- [ ] **Step 3: Add zh entries + hasAdminZh in i18n.tsx**

In `i18n.tsx`, add these keys to the `zh` record (place near related entries; `"Generation": "生成"` already exists so do not duplicate it):

```ts
  // redesigned admin nav — group headers
  "Characters": "角色",
  "Media": "图片",
  // redesigned admin nav — item labels
  "Character Starters": "角色起始模板",
  "Character Review": "角色审核队列",
  "Model Profiles (nav)": "模型配置",
  "Prompt Recipes": "提示词配方",
  "Presets": "预设",
  "Image Production": "图片生产",
  "Image Library": "图片库",
  "Featured": "精选",
  // image production tabs
  "Batch production": "通用批量",
  "Generate for character": "为角色生成",
  "Character": "角色",
  // character visual identity (was "Visual Passport")
  "Visual Identity": "视觉身份",
```

Note: `"Model Profiles": "模型配置"` already exists in the dict (used elsewhere) — the nav label key is `"Model Profiles"`, which is already translated, so no new entry is needed for it (remove the placeholder `"Model Profiles (nav)"` line above — it was only a reminder). Verify with `grep -n '"Model Profiles"' i18n.tsx`.

Then add the exported predicate after `translateAdmin` (near line 831):

```ts
export function hasAdminZh(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(zh, key);
}
```

Then rename the character-page panel heading. In `VisualPassportPanel.tsx` line 92, change the heading key:

```tsx
          <h2 className="text-sm font-semibold">{t("Visual Identity")}</h2>
```

(Only the displayed label changes — leave the `VisualPassportPanel` component name, file name, and `characterId` prop untouched.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/main && bunx vitest run src/components/admin/i18n-nav.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify in browser (zh)**

Open the admin console, switch the language selector to 中文. Sidebar group headers read 角色 / 生成 / 图片; items read 官方角色 / 角色起始模板 / 角色审核队列 / 模型配置 / 提示词配方 / 预设 / 图片生产 / 图片库 / 精选. Open a character in 官方角色 → the identity panel heading reads 视觉身份 (not "Visual Passport").
Expected: no English fallbacks in the three pipeline groups.

- [ ] **Step 6: Commit**

```bash
git add packages/main/src/components/admin/i18n.tsx packages/main/src/components/admin/i18n-nav.test.ts packages/main/src/components/admin/VisualPassportPanel.tsx
git commit -m "feat(admin): zh labels for redesigned nav + Visual Identity rename"
```

---

## Task 5: Final verification & spec close-out

**Files:**
- Modify: `docs/superpowers/specs/2026-07-08-admin-console-ia-redesign-design.md` (mark status done)

- [ ] **Step 1: Old collided labels are gone from the UI layer**

Run:
```bash
cd packages/main && grep -rn -e "Profiles & Rollout" -e "Production Studio" -e "Asset Library" src/components/admin/nav-config.ts
```
Expected: no matches (nav labels updated). Note: `"Open Profiles & Rollout"` / `"Profiles & Rollout"` may still exist as **i18n dict keys / helper copy** referenced elsewhere — that is fine; only the nav labels must be updated.

- [ ] **Step 2: Full check gate**

Run: `cd packages/main && bun run lint && bun run typecheck`
Expected: both clean.
Run: `cd packages/main && bunx vitest run src/components/admin/nav-config.test.ts src/components/admin/i18n-nav.test.ts`
Expected: PASS.

- [ ] **Step 3: Confirm zero DB / API drift**

Run:
```bash
git diff --name-only master...HEAD | grep -E "schema.prisma|src/app/api|src/server" || echo "OK: no schema/api/server files changed"
```
Expected: `OK: no schema/api/server files changed`.

- [ ] **Step 4: Full click-through smoke**

With the admin dev server running, click every item in 角色 / 生成 / 图片 and confirm each renders (no white screen, no console error). Confirm the four moved/renamed screens specifically: Character Starters, Character Review, Prompt Recipes, Presets, Image Production (both tabs), Image Library, Featured.

- [ ] **Step 5: Mark the spec done and commit**

Edit `docs/superpowers/specs/2026-07-08-admin-console-ia-redesign-design.md` header `状态：` → `已实现 (表现层)`.

```bash
git add docs/superpowers/specs/2026-07-08-admin-console-ia-redesign-design.md
git commit -m "docs: mark admin IA redesign spec implemented"
```

---

## Self-Review

**Spec coverage:**
- §4 IA (three groups + migration map) → Task 2 (nav reshape) + `nav-config.test.ts` migration-completeness + group-membership tests.
- §5 vocabulary → Task 2 (EN labels) + Task 4 (ZH) + `i18n-nav.test.ts`.
- §6.1 image-production merge → Task 3.
- §6.2 recipes/presets promoted + ConfigView carve → Task 2 Steps 5-7.
- §6.3 visual identity stays embedded, tab renamed → Task 4 renames the `VisualPassportPanel` heading to `视觉身份`; the panel itself stays embedded in `OfficialCharactersView` (untouched otherwise).
- §6.4 review-queue relabel + regroup → Task 2 (label "Character Review", group Characters).
- §7 files → matches File Structure. §8 acceptance → Task 5 checklist. §3 zero-DB/API → Task 5 Step 3 guard.

**Decisions confirmed (2026-07-08):** (1) `模型配置` used instead of spec's `模型档案` — see Global Constraints. (2) `Visual Passport` → `视觉身份` rename is IN scope, handled in Task 4 (label-only edit at `VisualPassportPanel.tsx:92`).

**Placeholder scan:** none — all steps carry full code or exact commands.

**Type consistency:** `ConfigSlice`, `configSliceForSection`, `fetchGenerationConfig`, `PromptRecipesView`/`GenerationPresetsView` prop shapes match their call sites in `renderSection`; `ConfigView` prop list reduced consistently in both definition and call site; `ConfigTab` trimmed in type + `configTabValue` + `ConfigTabNav` items + `tabCounts`.
