# Design QA — Admin Image Production

## Comparison target

- Source visual truth: `/Users/kk/.codex/generated_images/019f4ef5-feaa-7cc1-a26f-552f6fe22753/exec-24b7a529-c3f7-4d35-8863-d8ca35bd9273.png`
- Implementation screenshot: `/Users/kk/code/idream/.codex/design-qa/content-production/06-directions-final-accepted.png`
- Combined comparison evidence: `/Users/kk/code/idream/.codex/design-qa/content-production/07-reference-vs-implementation.png`
- Route: `http://127.0.0.1:3001/admin/content/production`
- Captured viewport: 1280 × 720 (the in-app Browser surface remained capped at this size despite requesting the 1440 × 1024 design viewport)
- State: Nova Vale selected; creative brief, Scene prompt, mood, setting, outfit, camera, and lighting filled; four generated directions selected; Advanced collapsed.

## Full-view comparison evidence

The combined comparison confirms the implementation preserves the selected concept's core composition: existing 248px admin sidebar, three-stage production navigation, a compact creative-brief control column, a dominant directions workspace, neutral warm canvas, thin borders, restrained radii, black primary actions, and dense operations-tool typography.

The production implementation deliberately uses editable shot-plan surfaces before image generation instead of presenting speculative image previews as if they were already generated. Real generated images appear in the Generate & review contact sheet. This is an intentional product-truth deviation from the visual mock, not a placeholder asset substitution.

## Focused-region comparison evidence

- Creative brief controls: character identity status, use case, brief, Scene prompt, structured creative fields, consistency control, references, cost, primary action, and collapsed Advanced are all implemented and keyboard-addressable.
- Direction cards: four independent editable directions, selection controls, camera/lighting shot plans, prompt text, and structured chips are visible at production density.
- Review workspace: `/Users/kk/code/idream/.codex/design-qa/content-production/03-review-failed.png` verifies failed items use a stable failure state and Retry action rather than the old Loading placeholder.

## Required fidelity surfaces

- Fonts and typography: uses the existing Geist admin typography and matches the source hierarchy closely; headings, form labels, body copy, counters, and chips remain readable at 1280px.
- Spacing and layout rhythm: the main split grid, card gaps, section padding, radii, and dividers match the selected direction. The desktop split now activates at `lg`, preventing the 1280px single-column drift found in the first pass.
- Colors and visual tokens: implementation reuses the existing `--ad-*` warm neutral, ink, border, green, and red tokens. No gradients, glass effects, or unrelated dark surfaces were introduced.
- Image quality and asset fidelity: character and reference images use real `MediaAsset` URLs through Next Image/AssetImage. Direction-stage shot plans avoid fake or repeated unrelated imagery; generated assets appear in the review contact sheet.
- Copy and content: operator-facing language now centers on creative brief, Scene prompt, directions, consistency, cost, review, retry, and placement. Engineering controls are contained in Advanced.
- Icons: existing Lucide outline icons are used consistently with the established admin shell and the source design.
- Accessibility: all primary inputs have accessible names; stages expose `tablist`/`tab`/`aria-selected`; consistency uses `aria-pressed`; direction and item selection use labeled checkboxes; errors and notices use live regions.

## Comparison history

### Pass 1

- [P1] Direction cards repeated an unrelated existing poster image, implying it was a preview for four different concepts.
  - Fix: only use real inspiration images when enough distinct assets exist; otherwise render an explicit camera/lighting Shot plan surface.
  - Post-fix evidence: `06-directions-final-accepted.png`.
- [P2] The active production step was a large black block, heavier than the source and visually competing with the workspace.
  - Fix: reduced the step treatment to a black numbered circle and ink label.
  - Post-fix evidence: `06-directions-final-accepted.png`.
- [P2] The two-column studio could collapse at the 1280px validation width because it began at `xl`.
  - Fix: moved the split grid and sticky brief panel to the `lg` breakpoint; verified `scrollWidth === clientWidth === 1280`.
  - Post-fix evidence: `06-directions-final-accepted.png`.
- [P2] An unfinished creative draft was lost on reload.
  - Fix: added validated session draft persistence for form values, generated directions, and workflow stage.
  - Post-fix evidence: the accepted screenshot was captured immediately after reload with the full draft restored.

### Final pass

- Primary interactions tested: fill brief and structured inputs; generate four directions; edit/select directions; expand/collapse Advanced; restore the draft after reload; open a recent failed batch; inspect stable failure/Retry states.
- Browser console: no warnings or errors.
- Horizontal overflow: none at 1280px.
- Remaining differences are intentional product constraints or P3 polish only; no actionable P0/P1/P2 findings remain.

## Follow-up polish

- [P3] When low-cost preview generation becomes a supported product capability, the Shot plan area can be upgraded to asynchronous concept thumbnails without changing the current information architecture.
- [P3] A dedicated 1024px and narrow mobile Browser capture would add visual evidence for the already implemented stacked responsive layout.

final result: passed
