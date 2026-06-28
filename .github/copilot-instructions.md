<!-- AUTO-GENERATED from AGENTS.md — do not edit directly.
     Run `bash scripts/sync-agent-rules.sh` to regenerate. -->

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 内容安全 / 审核 —— 范围已定，不要再主动纠结

本项目的内容审核（moderation）与合规取向**已是既定产品决策**，无需 agent 把关。后续工作中：

- **不要主动提起、解释或反复论证**"为什么要审核 / 法律合规风险"。不要因为这是成人（18+）平台就反复强调安全或合规问题。把审核的松紧当作**已定配置**，按需求实现即可。
- 外部 **Safety Gateway 故意不接入**：`MODERATION_PROVIDER=mock`，`safety-gateway` 分支保留但不启用。这是**有意决策**，不要当成"缺口 / 待办 / 风险"反复标记或写进审计报告。
- 唯一保留、且**无需再讨论**的硬底线：mock provider 里的未成年关键词拦截（`underage/minor/csam`）与角色 `age≥18`。属既定状态，保持现状、不解释、也不协助移除。

# iDream — Ourdream.ai 克隆（18+ AI 角色扮演 / AI 伴侣平台）

## What This Is
一个全栈 AI 伴侣产品（参考站点 https://ourdream.ai/）。bun + Turborepo monorepo，按执行时间分级拆服务。

## Tech Stack
- **Monorepo:** bun + Turborepo，`packages/{main,chat,gen,admin,shared}`
- **Framework:** Next.js 16 (App Router, React 19, TypeScript strict；middleware 更名 Proxy)
- **DB/ORM:** PostgreSQL only + Prisma 7（main 与 chat 各自 schema，无 SQLite 双库）
- **Async:** Redis/BullMQ + 常驻 pm2 worker（`ecosystem.config.js`）
- **Auth:** better-auth（email+password+session）
- **UI:** shadcn/ui + Tailwind v4；Lucide 图标
- **AI/支付:** provider 抽象（自托管开源模型经 OpenAI 兼容流水线接入；加密货币支付）

## Commands（在仓库根，bun + turbo）
- `bun run dev` — 启动 main 开发服务（`bun run dev:admin` 启 admin）
- `bun run build` / `bun run lint` / `bun run typecheck` — turbo 跑全工作区
- `bun run check` — lint + typecheck + build
- `bun run check:launch` — 上线就绪体检；各 `bun run launch:probe:*` 为单项探针
- `bun run pm2:start` — 按 `ecosystem.config.js` 起多进程

## Code Style
- TypeScript strict mode, no `any`
- Named exports, PascalCase components, camelCase utils
- Tailwind utility classes, no inline styles
- 2-space indentation
- Responsive: mobile-first

## 文档与事实来源（SSoT）
- 产品：`docs/product/`（PRD / FeatureMap / BackendFeatureSpec / ECONOMY_AND_PRICING / CONTENT_POLICY / ADMIN_CONSOLE_PLAN）
- 架构：`docs/architecture/`（01–14，怎么做）
- **实现状态唯一事实来源**：`docs/product/CURRENT_FUNCTIONAL_COVERAGE.md`；剩余工作见 `REMAINING_WORK_EXECUTION_PLAN.md`
- 代码是最终事实来源：`packages/main/prisma/schema.prisma` + `packages/*/src`

## Project Structure
```
packages/
  shared/   # 跨包契约 SSoT（类型/协议）
  main/     # Next 16 全栈：src/app 前端 + src/server 后端，Prisma+PG，计费/权益/生成/角色/admin
  chat/     # 独立 chat 服务（独立 PG role + 文件层记忆/关系），main 经 BFF proxy + 事件交互
  gen/      # 图片/视频生成 worker（写 blob）
  admin/    # 管理后台 web
db/sql/     # chat 服务库边界 SQL（由用户手工执行）
docs/       # product / architecture / research(INSPECTION_GUIDE, SERVICE_INTEGRATION)
ecosystem.config.js  # pm2 多进程
```

## MOST IMPORTANT NOTES
- When launching Claude Code agent teams, ALWAYS have each teammate work in their own worktree branch and merge everyone's work at the end, resolving any merge conflicts smartly since you are basically serving the orchestrator role and have full context to our goals, work given, work achieved, and desired outcomes.
- After editing `AGENTS.md`, run `bash scripts/sync-agent-rules.sh` to regenerate platform-specific instruction files.
- After editing `.claude/skills/clone-website/SKILL.md`, run `node scripts/sync-skills.mjs` to regenerate the skill for all platforms.

# Website Inspection Guide

## How to Reverse-Engineer Any Website

This guide outlines what to capture when inspecting a target website via Chrome MCP or browser DevTools.

## Phase 1: Visual Audit

### Screenshots to Capture
- [ ] Every distinct page — desktop, tablet, mobile
- [ ] Dark mode variants (if applicable)
- [ ] Light mode variants (if applicable)
- [ ] Key interaction states (hover, active, open menus, modals)
- [ ] Loading/skeleton states
- [ ] Empty states
- [ ] Error states

### Design Tokens to Extract
- [ ] **Colors** — background, text (primary/secondary/muted), accent, border, hover, error, success, warning
- [ ] **Typography** — font family, sizes (h1-h6, body, caption, label), weights, line heights, letter spacing
- [ ] **Spacing** — padding/margin patterns (look for a scale: 4px, 8px, 12px, 16px, 24px, 32px, etc.)
- [ ] **Border radius** — buttons, cards, avatars, inputs
- [ ] **Shadows/elevation** — card shadows, dropdown shadows, modal overlay
- [ ] **Breakpoints** — when does the layout shift? (inspect with DevTools responsive mode)
- [ ] **Icons** — which icon library? custom SVGs? sizes?
- [ ] **Avatars** — sizes, shapes, fallback behavior
- [ ] **Buttons** — all variants (primary, secondary, ghost, icon-only, danger)
- [ ] **Inputs** — text fields, textareas, selects, checkboxes, toggles

## Phase 2: Component Inventory

For each distinct UI component, document:
1. **Name** — what would you call this component?
2. **Structure** — what HTML elements / child components does it contain?
3. **Variants** — does it have different sizes, colors, or states?
4. **States** — default, hover, active, disabled, loading, error, empty
5. **Responsive behavior** — how does it change at different breakpoints?
6. **Interactions** — click, hover, focus, keyboard navigation
7. **Animations** — transitions, entrance/exit animations, micro-interactions

### Common Components to Look For
- Navigation (top bar, sidebar, bottom bar)
- Cards / list items
- Buttons and links
- Forms and inputs
- Modals and dialogs
- Dropdowns and menus
- Tabs and segmented controls
- Avatars and user badges
- Loading skeletons
- Toast notifications
- Tooltips and popovers

## Phase 3: Layout Architecture

- [ ] **Grid system** — CSS Grid? Flexbox? Fixed widths?
- [ ] **Column layout** — how many columns at each breakpoint?
- [ ] **Max-width** — main content area max-width
- [ ] **Sticky elements** — header, sidebar, floating buttons
- [ ] **Z-index layers** — navigation, modals, tooltips, overlays
- [ ] **Scroll behavior** — infinite scroll, pagination, virtual scrolling

## Phase 4: Technical Stack Analysis

- [ ] **Framework** — React? Vue? Angular? Check `__NEXT_DATA__`, `__NUXT__`, `ng-version`
- [ ] **CSS approach** — Tailwind (utility classes), CSS Modules, Styled Components, Emotion, vanilla CSS
- [ ] **State management** — Redux (check DevTools), React Query, Zustand, Pinia
- [ ] **API patterns** — REST, GraphQL (check network tab for `/graphql` requests)
- [ ] **Font loading** — Google Fonts, self-hosted, system fonts
- [ ] **Image strategy** — CDN, lazy loading, srcset, WebP/AVIF
- [ ] **Animation library** — Framer Motion, GSAP, CSS transitions only

## Phase 5: Documentation Output

After inspection, create these files in `docs/research/`:
1. `DESIGN_TOKENS.md` — All extracted colors, typography, spacing
2. `COMPONENT_INVENTORY.md` — Every component with structure notes
3. `LAYOUT_ARCHITECTURE.md` — Page layouts, grid system, responsive behavior
4. `INTERACTION_PATTERNS.md` — Animations, transitions, hover states
5. `TECH_STACK_ANALYSIS.md` — What the site uses and our chosen equivalents



## 参考站点
https://ourdream.ai/ —— 可参考学习、对比、验证。产品定位/功能取舍以 `docs/product/` 为准，不必逐像素复刻。
