# Character operations visual roster — design QA（2026-07-29 历史记录）

> **这是一次性比对的存档，不是当前状态。** 下面记录的是 2026-07-29 对 `/admin/characters` 角色列表页做的一次视觉稿比对，`Result: passed` 只对那一天的那一版实现成立。此后后台经历了 2026-07-31 的暗色→浅色 token 化重构，以及 2026-08-15–16 的信息架构与列表平台层重构，页面已经变过两轮。**当前后台的视觉层没有任何有效的浏览器复验记录**——2026-08-15–16 那一轮明确没有做真实浏览器验证，详见 `docs/product/CURRENT_FUNCTIONAL_COVERAGE.md` 同名小节的「验证边界」。
>
> 保留本文的理由是它记录的三条设计约束仍然有效，回归时能对照：卡片高度契约（媒体容器不得吃掉卡片高度）、featured 卡片在 1024px 以下堆叠、缺图角色渲染显式空态而不是一块空白。这三条在当前代码里都还在（`CharacterPortfolioVisual.tsx` 的 `variant: "featured"` 与 `No primary role portrait` 空态）。
>
> **已经失效、不要照着它验收的部分**：下面「Responsive and interaction checks」里的运营筛选轨（attention / setup / production / launch / live 五个子集切换）和 “More filters” 紧凑弹层都已不存在——2026-08-15–16 把「需要处理」提成了列表顶部的常驻开关，理由写在 `src/features/characters/CharacterPortfolio.tsx` 的 INTENT 注释里（藏进折叠等于没人会用）。截图仍在 `output/product-design/character-operations-visual-roster-2026-07-29/`。

---

## Inputs

- Reference: `/Users/kk/.codex/generated_images/019fadfb-95f3-7250-8b6f-e889184ae85b/call_OjxCbGaFwlQ0FrkvLjvg9Zve.png`
  - Source pixels: 1487 × 1058
  - Normalized comparison source: `/Users/kk/code/idream/output/product-design/character-operations-visual-roster-2026-07-29/source-option-3-1440x1024.png`
- Implementation: `http://127.0.0.1:3001/admin/characters`
  - Screenshot: `/Users/kk/code/idream/output/product-design/character-operations-visual-roster-2026-07-29/implementation-final.png`
- Comparison viewport: 1440 × 1024 CSS pixels at 1× density
- Full comparison: `/Users/kk/code/idream/output/product-design/character-operations-visual-roster-2026-07-29/comparison-final.png`
- Focused comparison: `/Users/kk/code/idream/output/product-design/character-operations-visual-roster-2026-07-29/comparison-focus.png`

## Comparison history

1. `implementation-pass-1.png`
   - P1: regular cards lost their details because the media wrapper consumed the card height.
   - P2: the attention view reordered the entire portfolio around fixture rows instead of preserving the authoritative response order around the current focus.
   - Fixed the card height contract and kept the server order while moving only the authoritative focus item first.
2. `implementation-pass-2.png`
   - P1: at 768px the featured card stayed split into two narrow columns.
   - P2: an image-less featured role looked like a broken blank surface.
   - Changed the featured card to stack below 1024px, span both roster columns from 640px upward, and made the missing-portrait state visible and intentional.
3. `implementation-final.png`
   - No open P0, P1, or P2 visual findings.

## Final visual assessment

- The implementation matches the selected roster hierarchy: slim operational filter rail, one featured action card, image-led supporting cards, three-stage production progress, and one primary action per card.
- Existing Admin typography, spacing, borders, colors, navigation, provenance strip, and controls are retained.
- Real authoritative role images are used. Missing images render an explicit empty state; no example portrait is invented.
- The reference uses illustrative people and names. The implementation intentionally uses the current authoritative portfolio, so the featured role can be image-less when it is the highest-priority operation.
- “More filters” is retained as a compact popover because search and server-backed status filters remain part of the production workflow.

## Responsive and interaction checks

- 1440 × 1024: no horizontal overflow; desktop four-column roster and featured two-column card render correctly.
- 1024 × 900: no horizontal overflow; featured card uses a full-width left/right layout.
- 768 × 900: no horizontal overflow; featured card stacks image and action content.
- Operational rail switches between attention, setup, production, launch, and live subsets.
- “More filters” opens and closes.
- Alexa Reeves’ primary action navigates to `/admin/characters/alexa-reeves?tab=assets`.
- Rendered role images completed with positive natural dimensions.
- Fresh reload produced no console warnings or errors.

## Result

passed
