# Design QA — Character List and Detail Simplification

## Comparison target

- Selected list visual truth: `/Users/kk/.codex/generated_images/019fbb03-5a89-7353-be3b-2d6b99a9d4d7/exec-7fb2681a-b451-4550-9b3d-c63e61f5f329.png`
- Generated detail visual truth: `/Users/kk/.codex/generated_images/019fbb03-5a89-7353-be3b-2d6b99a9d4d7/exec-d7721e79-da65-4aa9-8cf5-eb7587fdb219.png`
- Final list implementation: `/Users/kk/code/idream/output/product-design/character-list-simplification-2026-07-31/05-implemented-list.png`
- Final detail implementation: `/Users/kk/code/idream/output/product-design/character-detail-simplification-2026-07-31/02-implemented-detail.png`
- Same-input list comparison: `/Users/kk/code/idream/output/product-design/character-list-simplification-2026-07-31/06-reference-vs-implementation.png`
- Same-input detail comparison: `/Users/kk/code/idream/output/product-design/character-detail-simplification-2026-07-31/03-reference-vs-implementation.png`
- Routes: `http://127.0.0.1:3001/admin/characters` and `http://127.0.0.1:3001/admin/characters/alexa-reeves`
- Viewport: 1488 × 1058 CSS px, effective device scale factor 1. Implementation captures are 1488 × 1058 px; both source visuals are 1487 × 1058 px. The 1px source-width difference was retained and both comparisons were aligned at equal height without density rescaling.
- State: Chinese locale; 24-character list with search empty and filters closed; Alexa Reeves detail with Details selected, editor closed, and project collaboration collapsed.

## Full-view comparison evidence

The combined list comparison confirms the selected direction's core structure: quiet Character-only navigation, visible search, one compact filter control, one Create action, a four-column portrait roster, and only name plus factual state below each image. Workflow summary tabs, featured-card hierarchy, progress steppers, repeated next-action cards, and instructional copy are absent.

The combined detail comparison confirms the generated detail direction's core structure: back navigation, large identity portrait and factual state, direct section tabs, open character facts, current status, and a three-image recent-assets strip. Editing and collaboration are secondary disclosures. No server-projected “next step” is rendered and direct tab selection does not append a guided anchor.

## Focused-region comparison evidence

No separate crop was needed because the 2975 × 1058 original-resolution comparison images keep the header, toolbar, card labels, tabs, factual values, and recent-asset controls legible in one input. Browser semantic snapshots were used in addition to the visual comparisons to verify the controls and labels rather than inferring interaction from pixels.

## Required fidelity surfaces

- Fonts and typography: the implementation uses the existing Admin type system and matches the source's restrained hierarchy: compact shell title, 30px character title, 16px roster names, 14px factual states, and small metadata. Long real names truncate instead of changing card height.
- Spacing and layout rhythm: the list uses four equal tracks at the verified desktop width, 4:5 images, restrained horizontal gaps, and no card chrome. The detail uses a 192px square identity portrait, a plain tab divider, two factual columns, and border-only section separation.
- Colors and visual tokens: the existing warm canvas, surface, ink, muted, border, green, blue, and yellow `--ad-*` tokens map directly to the visual direction. No gradients, decorative shadows, or new badge system were introduced.
- Image quality and asset fidelity: all visible portraits and recent assets are genuine current Character/MediaAsset URLs. Characters without permitted or available portraits show the existing factual empty image state; no generated placeholder artwork, CSS art, or repeated unrelated image was substituted.
- Copy and content: cards state only Draft, In production, Ready for preview, Pending release, or Live. Detail copy names the actual character facts and authority state. “Next”, production workflow steps, setup instructions, and forced-action descriptions are absent.
- Accessibility and interaction: each roster item is one named link, search and filters have accessible labels, tabs retain tab semantics and keyboard behavior, edit disclosure has a named toggle, and real mutation locks remain enforced.

## Findings

No actionable P0, P1, or P2 visual or interaction differences remain.

## Comparison history

### Pass 1

- [P2] The initial implementation still exposed Character Starters, Taxonomy, and unrelated shell groups beside the simplified roster.
  - Fix: on the Character workspace, navigation now contains Today plus Characters and Character Review only.
  - Post-fix evidence: `06-reference-vs-implementation.png`.
- [P2] The first detail capture compressed the identity header around a small portrait.
  - Fix: increased the desktop identity portrait to a 192px square so header height and identity emphasis match the selected direction.
  - Post-fix evidence: `03-reference-vs-implementation.png`.
- [P2] Hot reload briefly mixed the old server shell with the new client shell and produced a recoverable hydration issue.
  - Fix: restarted only the `admin-web` development process and repeated both captures from a cold page load.
  - Post-fix evidence: the final Browser snapshots report no Issue, Recoverable Error, or hydration error on either route.

### Final pass

- Primary interactions tested: search for Alexa and return to all Characters; open and close Filters; open a Character through the whole roster item; expand and close the 10-field details editor; switch directly to Visual identity and back; return to the list.
- Direct-tab evidence: Visual identity resolves to `/admin/characters/alexa-reeves?tab=visual` with no guided hash.
- Runtime evidence: 24 Characters loaded; the final list and detail Browser snapshots had no Next.js issue or hydration error; the Admin development process remained online and the final open route is the Character list.
- Verification: 22 focused tests passed, Admin TypeScript check passed, focused ESLint passed, and `git diff --check` passed.

## Follow-up polish

- [P3] The real development roster contains long fixture names and missing portraits, so its content is less curated than the concept image. The implementation intentionally keeps those factual states instead of hiding data or fabricating imagery.
- [P3] Language, Refresh, and Logout remain as compact shell utilities; they are product controls rather than workflow guidance.

final result: passed

---

# Visual Identity History Gallery - 2026-08-01

## Visual source and implementation

- Selected visual target: `/Users/kk/.codex/generated_images/019fbb03-5a89-7353-be3b-2d6b99a9d4d7/exec-3c6fd842-7578-4f30-b6fc-730d1df6d804.png` at 1487 x 1058.
- Full comparison input: `output/product-design/character-visual-history-redesign-2026-08-01/qa-source-and-implementation.png` at 2560 x 911. The source and implementation were normalized to the same 1280 px comparison width.
- Final implementation: `output/product-design/character-visual-history-redesign-2026-08-01/final-visual-desktop.png` at 1280 x 1413 full-page capture.
- Focused selected-history state: `output/product-design/character-visual-history-redesign-2026-08-01/final-history-selected-desktop.png` at 1280 x 1918 full-page capture.
- Browser state: real Alexa Reeves workspace at `?tab=visual`, Chinese locale, five successful historical images and three failed runs.
- Design controls: `DESIGN_VARIANCE=5`, `MOTION_INTENSITY=2`, `VISUAL_DENSITY=3`.

## Visible comparison and iteration

- Preserved the selected target's calm two-column editor: current identity on the left, one free-form generation composer on the right, and prompt, negative prompt, seed, reference action, and Generate as the visible controls.
- Replaced the hidden date/status history disclosure with a persistent image gallery below the composer. This is the only intentional structural difference from the target because history discovery and re-selection were the reported usability failure.
- Clicking a historical image opens a large preview with the actual seed, generation mode, prompt disclosure, and direct reuse actions. Failed runs remain visible without occupying image-card space.
- Removed the false `current` label from historical candidates by projecting the active identity's authoritative `anchorAssetIds`. Legacy images without the required composition evidence can be reused for a new run but are not offered an impossible activation action.
- Rechecked Details, Images, Video, Voice, Launch Preview, Release, and Live Performance at desktop width. No new stage navigation, explanatory hero, or card stack was added.

## Interaction and implementation QA

- Browser verified five discoverable history buttons, opened an older image, confirmed prompt and actual seed visibility, and used `沿用生成参数` to restore seed `143891318` into the composer.
- Browser console contained zero errors. One pre-existing Next.js LCP warning remains for `/images/ourdream/card-alexa-reeves.webp` and is unrelated to this visual-history change.
- Character frontend suite: 14 files, 145 tests passed.
- Workspace integration: 10 tests passed against PostgreSQL, including `anchorAssetIds` projection.
- Admin, Main, and Shared typecheck passed. Admin lint, production build, and `git diff --check` passed.

final result: passed

---

# Final closeout — Full Character Workspace Audit

## Comparison target

- Source visual truth: `/Users/kk/.codex/generated_images/019fbb03-5a89-7353-be3b-2d6b99a9d4d7/exec-3c6fd842-7578-4f30-b6fc-730d1df6d804.png`
- Rendered implementation: `output/product-design/character-workspace-full-audit-2026-08-01/32-visual-final-desktop.png`
- Responsive evidence: `output/product-design/character-workspace-full-audit-2026-08-01/21-detail-final-mobile.png` through `28-performance-final-mobile.png`
- Desktop state: Alexa Reeves, Chinese locale, 1440 × 1024 CSS viewport, screenshot 1440 × 1024 px, device density 1.
- Mobile state: Alexa Reeves, Chinese locale, 410 × 734 CSS viewport, screenshot 410 × 734 px, device density 1.
- Source pixels: 1487 × 1058. The source and implementation were opened together at original resolution. No density resampling was needed; the comparison judged the shared composition and interaction hierarchy while preserving the authoritative live Alexa content.

## Full-view comparison evidence

The implementation retains the selected source hierarchy: compact character authority header, direct desktop tabs, dominant current visual, free-form prompt, visible negative prompt and seed, one primary Generate action, and secondary production controls below the fold. The final Details, Voice, Release, and Live Performance screenshots confirm that the same warm monochrome tokens, crisp borders, low visual density, and disclosure pattern now carry across the workspace.

## Focused-region evidence

A separate crop was not needed because the original-resolution screenshots keep the typography, field labels, status tokens, and primary controls readable. The exact interactive regions were additionally inspected through the live DOM: mobile workspace selector, Details editor, Visual Identity prompt/negative prompt/seed, Images filmstrip/settings, Video model disclosure, Voice advanced settings, Release history, and portfolio-decision disclosure.

## Findings and iteration history

- P2 mobile navigation: the eight-tab horizontal strip clipped earlier destinations when an end tab was active. Fixed with one complete mobile workspace selector while preserving the desktop tablist and keyboard behavior. Post-fix evidence: `21-detail-final-mobile.png` through `28-performance-final-mobile.png`.
- P2 localization: the Voice upload control exposed browser-native English copy. Fixed with an accessible localized picker and selected-file label. Post-fix evidence: `25-voice-final-mobile.png` and `35-voice-final-desktop.png`.
- P2 empty-state density: Live Performance repeated four rows of N/A metrics with zero samples. Fixed with one diagnosis and one factual monitored-window empty state. Post-fix evidence: `28-performance-final-mobile.png` and `38-performance-final-desktop.png`.
- P2 release hierarchy: current and superseded Releases appeared as equivalent cards and showed contradictory readiness emphasis. Fixed by separating current live Release, candidate, and collapsed history; historical versions no longer show readiness as a current action. Post-fix evidence: `27-release-final-mobile.png` and `37-release-final-desktop.png`.
- P2 detail duplication: updated timestamp, Character ID, serving state, and visibility repeated the shared header. Fixed by keeping identity fields in Technical Status and showing only distinct operational facts in Details. Post-fix evidence: `21-detail-final-mobile.png` and `31-detail-final-desktop.png`.

## Required fidelity surfaces

- Typography: existing Admin system typography, compact weight hierarchy, wrapping, and small-label contrast are consistent across all eight tabs.
- Spacing and layout: desktop keeps the source two-column task composition; mobile reflows to one column without horizontal page overflow or clipped navigation.
- Colors and tokens: warm canvas, white surfaces, hairline borders, muted semantic blue/green/yellow states, and black primary actions remain consistent.
- Image quality: real Character images and videos are preserved with correct aspect ratios and object-fit behavior; no placeholder or CSS-drawn media was introduced.
- Copy and content: visible controls are Chinese, internal IDs stay in Technical Status or Technical Evidence, and blocked states provide one direct action.

## Verification

- Character module: 14 files, 144 tests passed.
- Admin typecheck, focused ESLint, production build, and targeted `git diff --check` passed.
- Live Browser covered all eight desktop tabs and all eight mobile selector destinations plus the primary safe interactions. There were no console errors. The development session still contains one earlier Next.js LCP warning for the Alexa image; the image is already eager in the shared header and no new warning appeared after the final HMR pass. This is retained as P3 runtime follow-up rather than a UX blocker.

final result: passed

---

# Final closeout - Video, Voice, Launch Preview, and Live Performance

## Comparison target

- source visual truth path: `/Users/kk/.codex/generated_images/019fbb03-5a89-7353-be3b-2d6b99a9d4d7/exec-3c6fd842-7578-4f30-b6fc-730d1df6d804.png`
- same-state source captures:
  - `output/product-design/character-secondary-tabs-simplification-2026-08-01/01-current-video.png`
  - `output/product-design/character-secondary-tabs-simplification-2026-08-01/02-current-voice.png`
  - `output/product-design/character-secondary-tabs-simplification-2026-08-01/03-current-preview.png`
  - `output/product-design/character-secondary-tabs-simplification-2026-08-01/04-current-performance.png`
- implementation screenshots:
  - `output/product-design/character-secondary-tabs-simplification-2026-08-01/16-final-video-desktop.png`
  - `output/product-design/character-secondary-tabs-simplification-2026-08-01/17-final-voice-desktop.png`
  - `output/product-design/character-secondary-tabs-simplification-2026-08-01/18-final-preview-desktop.png`
  - `output/product-design/character-secondary-tabs-simplification-2026-08-01/15-final-performance-desktop.png`
- viewport: desktop 1440 x 1024 CSS px; mobile 410 x 734 CSS px
- pixels and density: desktop captures are 1440 x 1024 pixels, mobile captures are 410 x 734 pixels, device density is normalized 1:1 by the in-app Browser viewport override. The selected style target is 1487 x 1058 pixels and was compared for hierarchy and design language, not pixel matching, because it depicts a different tab.
- state: authenticated Chinese Admin, Alexa Reeves, real video result, inherited system voice, image-pack-blocked launch preview, and zero-observation live performance.

## Full-view comparison evidence

The selected Visual Identity target and all four final desktop captures were opened together in one comparison input. All four tabs now carry the selected hierarchy: compact Character header, one dominant fact or task, one primary action, warm neutral tokens, 8px surfaces, no decorative effects, and technical or historical content behind disclosures.

## Required fidelity surfaces

- Fonts and typography: existing Admin type family and weights are preserved. Headings stay at compact tool-scale sizes; helper copy and metadata use the existing muted token without cramped wrapping.
- Spacing and layout rhythm: Video uses a media/composer split, Voice uses one full-width form after the current voice, Launch Preview stops after the blocker and compact comparison, and Performance uses one compact fact surface. Desktop and mobile captures show no overlapping controls or horizontal page overflow.
- Colors and tokens: all changes use existing `--ad-*` surface, border, text, blue, yellow, green, and red tokens. No gradients, heavy shadows, or new accent system were introduced.
- Image quality: the real authorized Character portrait, video, live image, and draft image are preserved with stable crops and no substitute art.
- Copy and content: repeated guidance, route IDs, model IDs, duplicate zero-data diagnoses, and disabled QA choices were removed from the default view. Operator labels remain direct and localized.
- Icons and affordances: existing Lucide icons and WorkspaceButton states are retained. Disclosures are visible, keyboard-native `details` elements.
- Accessibility and responsiveness: semantic regions, headings, labels, audio/video controls, links, and status roles remain intact. The 410 x 734 captures show single-column stacking and usable controls.

Focused region comparison was not needed after the full 1440 x 1024 captures because all affected controls and copy were legible at original resolution. The browser interaction pass separately opened Video model details, portfolio decisions, and release monitoring, and verified the Voice preview button and Launch Preview repair link.

## Comparison history

- P2, first mobile pass: the latest video occupied too much of the 410 x 734 first screen. Fix: cap the mobile video height while retaining the larger desktop media stage. Post-fix evidence: `output/product-design/character-secondary-tabs-simplification-2026-08-01/13-final-video-mobile.png`.
- P2, first mobile pass: Performance metric fields stacked into a long single column. Fix: use a two-column fact grid on mobile and the compact six-column row at desktop. Post-fix evidence: `output/product-design/character-secondary-tabs-simplification-2026-08-01/14-final-performance-mobile.png`.
- Post-fix comparison found no remaining actionable P0, P1, or P2 issue.

## Browser and build evidence

- Primary interactions tested: all four tabs, Video model disclosure, portfolio-decision disclosure, release-monitor disclosure, Voice preview availability, and Launch Preview repair deep link.
- Mobile evidence: Preview, Voice, Video, and Performance were captured at 410 x 734.
- Runtime evidence: current Admin requests returned 200 and the dev server compiled after the final edits. PM2's error tail contains an older resolved parse error plus an existing Next.js LCP warning for the shared Alexa header image; no new runtime error appeared during this pass.
- Verification: 34 focused tests passed, Admin typecheck passed, focused ESLint passed, Admin production build passed, and targeted `git diff --check` passed.

## Findings

- No actionable P0, P1, or P2 findings remain.
- P3 follow-up: the existing Next.js development LCP warning for the shared Character header image remains even though the image currently declares eager loading. It is outside the four-tab layout change and does not block the workflow redesign.

final result: passed

---

# Design QA — Visual Identity Simple Generation Flow

## Comparison target

- Selected and revised source visual: `/Users/kk/.codex/generated_images/019fbb03-5a89-7353-be3b-2d6b99a9d4d7/exec-3c6fd842-7578-4f30-b6fc-730d1df6d804.png`
- Final desktop implementation: `/Users/kk/code/idream/output/product-design/visual-identity-usability-redesign-2026-07-31/04-implementation-desktop.png`
- Final narrow-screen top: `/Users/kk/code/idream/output/product-design/visual-identity-usability-redesign-2026-07-31/04-implementation-mobile-top.png`
- Final narrow-screen controls: `/Users/kk/code/idream/output/product-design/visual-identity-usability-redesign-2026-07-31/05-implementation-mobile-controls.png`
- Route: `http://127.0.0.1:3001/admin/characters/alexa-reeves?tab=visual`
- Desktop viewport: 1440 × 1024 CSS px. Narrow-screen viewport: 410 × 734 CSS px at device scale factor 2.
- State: Chinese locale; prompt empty; real negative prompt and seed visible; Generate disabled until the prompt is entered; History and Advanced settings collapsed.

## Full-view comparison evidence

The source and implementation were opened together at original resolution in one comparison input. The implementation matches the selected information hierarchy: the current real character image occupies the left track; the right track contains one creative prompt, a compact visible negative prompt, a visible seed with a quiet Random action, optional reference upload, one primary Generate action, and only two secondary disclosures. The model, workflow, route, identity version, experiment terminology, candidate comparison, evidence, and adoption flow are absent from the default visible state.

The implementation intentionally uses Alexa's current authoritative image and current negative prompt instead of the source mock's generated face and abbreviated sample copy. This is a factual data difference, not a component deviation.

## Focused-region comparison evidence

- Prompt and generation controls: the large prompt area, single-line negative prompt, seed field, Random action, Add reference image, Generate, History, and Advanced settings align with the selected source in the same desktop viewport.
- Narrow-screen flow: the composer moves before the large current image, so the operator reaches the task without scrolling past a portrait. The visible control order remains prompt → negative prompt → seed → optional reference → Generate.
- Result and authority flow: existing result review and activation controls remain in the DOM and retain their backend contracts, but they appear only after a new generation or an explicit History selection.

## Comparison history

### Pass 1

- [P2] The first narrow-screen pass put the full current image before the composer.
  - Fix: composer is first on narrow screens and returns to the right column at the desktop breakpoint.
- [P2] The negative prompt used a multiline textarea and competed with the primary prompt.
  - Fix: changed it to a compact single-line field while preserving the full stored value.
- [P2] The Generate action began too close to Add reference image and consumed the whole row.
  - Fix: reserved a quiet left action column and kept the black primary action dominant on desktop.

### Final pass

- No open P0, P1, or P2 visual or interaction differences remain.
- Browser interaction evidence: blank prompt truthfully disables Generate; filling the prompt enables it; Random changes the visible seed; History opens eight real prior runs; Advanced settings opens generation method, aspect ratio, identity constraint, and image-to-image controls; no generation mutation was submitted during QA.
- Responsive evidence: the default 410px viewport and explicit 1440 × 1024 viewport both have no visible horizontal overflow or clipped primary controls.
- Verification: 17 focused tests passed; focused ESLint, Admin TypeScript check, production build, and `git diff --check` passed.

## Follow-up polish

- [P3] The live Alexa negative prompt is longer than the source sample. The compact field intentionally keeps the real stored value and allows horizontal text navigation instead of expanding the page.
- [P3] Formal identity and production controls remain as one collapsed disclosure after the primary workspace so existing authority operations stay reachable without returning to the first screen.

final result: passed

---

# Design QA — Character Detail Media Workspace (Option 2)

## Comparison target

- Source visual truth: `/Users/kk/.codex/generated_images/019fbb03-5a89-7353-be3b-2d6b99a9d4d7/exec-3ef45301-5abe-40cb-83a0-f9f5fe38c799.png`
- Images implementation: `/Users/kk/code/idream/output/product-design/character-detail-redesign-2026-08-01/03-implemented-images.png`
- Video implementation: `/Users/kk/code/idream/output/product-design/character-detail-redesign-2026-08-01/04-implemented-video.png`
- Route: `http://127.0.0.1:3001/admin/characters/alexa-reeves?tab=assets`
- Viewport: 1488 × 1058 CSS px at device scale factor 1.
- Pixel normalization: source 1487 × 1058 px; both implementation captures 1488 × 1058 px. The 1px source-width difference was retained; no density rescaling was needed.
- State: Chinese locale; Alexa Reeves; Images selected with the existing image library and New image inspector visible. Video was captured separately with a real completed clip and New video inspector visible.

## Full-view comparison evidence

The source and latest Images implementation were opened together in the same original-resolution comparison input. Both use the same compact Character header, direct section tabs, a quiet identity/route line, a dominant media preview, a horizontal thumbnail filmstrip, and a fixed-width right inspector with `Inspect / New image` modes. The implementation keeps the existing Admin shell title instead of moving back navigation into the shell; redundant in-content back navigation was removed so the Character header and media workspace align with the source's vertical rhythm.

The source's curated landscape portrait and the implementation's current Character assets differ by data, not component treatment. The implementation uses genuine current MediaAsset URLs, preserves the selected image's full crop with neutral gutters when needed, and does not fabricate a source-matching asset.

## Focused-region comparison evidence

No extra crop was required: at original resolution, the combined comparison keeps the header status, tab labels, route line, inspector labels, prompt, primary action, selected thumbnail border, and filmstrip crops legible. The separate Video capture verifies the user-requested state that does not exist in the source mock: a dominant playable clip, horizontal run history, and the same two-mode inspector structure.

## Required fidelity surfaces

- Fonts and typography: existing Admin typography matches the source's compact 14px controls, restrained 16px section headings, semibold Character name, muted metadata, and unembellished labels. No oversized display treatment or instructional headline was introduced.
- Spacing and layout rhythm: the workspace uses one dominant media track plus a 380px inspector, 5-unit track gap, thin dividers, restrained 8px radii, and no decorative shadows. Header and tabs were tightened so media starts at the same visual level as the selected direction.
- Colors and tokens: warm canvas, white surfaces, ink, muted text, hairline borders, black primary action, and factual green serving dot all reuse existing `--ad-*` tokens. No gradients, decorative fills, or new color system was added.
- Image quality and asset fidelity: the main image, thumbnails, source image, and video are real authorized Character assets. `object-contain` preserves the full media; thumbnails use consistent square crops. No placeholder art, CSS art, inline SVG art, or repeated fake imagery was used.
- Copy and content: Images and Video are separate top-level tabs. The right panels ask only for the current creative brief or motion brief; purpose/source controls are secondary. Long setup steps, forced next-action cards, and customer-preview explanations are absent.
- Icons: existing Lucide outline icons remain aligned with the Admin shell and are limited to actionable controls or factual empty states.
- Accessibility and interaction: workspace and inspector tabs keep tab semantics and selected state; thumbnails expose named pressed-state buttons; inputs and media sources are labeled; video has native controls; disabled Inspect states are truthful when no reviewable Creative Run exists.
- Responsiveness: the desktop target matches at 1488px. The same browser session also exercised the default 1280px viewport without overlap or loss of the Images, Video, Inspect, or New controls; below the `xl` breakpoint the inspector follows the media in document flow.

## Comparison history

### Pass 1

- [P2] The first implementation showed an empty first-run canvas even though the Character already had usable images.
  - Fix: added a de-duplicated existing-image library, selected-purpose-first ordering, a large real preview, and a horizontal thumbnail filmstrip. Review authority remains limited to actual Creative Run candidates.
  - Post-fix evidence: `03-implemented-images.png` shows 13 real images, a selected preview, and the filmstrip in the first viewport.
- [P2] Redundant in-content back navigation pushed the Character header and media workspace below the source rhythm.
  - Fix: removed the duplicate back row; the persistent Character navigation in the Admin sidebar remains available.
  - Post-fix evidence: the final source/implementation comparison aligns the Character header, tabs, identity line, media canvas, and inspector above the fold.

### Final pass

- No actionable P0, P1, or P2 visual, behavior, localization, accessibility, or responsive findings remain.
- Primary interactions tested in the in-app Browser: direct Images/Video tab switching with URL persistence; thumbnail selection; Video Inspect/New video switching; real video playback surface; source selection and motion composer presence.
- Fresh browser run: zero console warnings and zero errors after the final LCP loading fix.
- Verification: 6 focused files / 57 tests passed; Admin TypeScript check passed; focused ESLint passed; Next 16 production build passed; `git diff --check` passed.
- The full Admin test run still contains one unrelated pre-existing Character-list search-placeholder expectation in `operator-domain-workspaces.test.tsx`; this media-workspace change does not touch that flow.

## Follow-up polish

- [P3] The source mock uses one curated landscape identity set, while Alexa's live library mixes portrait, face-reference, and group-image crops. The implementation intentionally shows factual current media instead of hiding or fabricating assets.
- [P3] The source shows optional reference and advanced-setting rows in the New image inspector. The implementation keeps only the currently supported purpose setting visible to honor the user's request for less guidance and fewer restrictions.

final result: passed

---

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

---

# Visual Identity Experiment Workbench

## Evidence

- Source design:
  `/Users/kk/.codex/generated_images/019f93eb-bb11-7cb3-a87e-70344c562681/call_P7OHFqUFEjdxMYYMxyy1SgRU.png`
- Final implementation viewport:
  `/Users/kk/code/idream/output/product-design/visual-identity-experiment/final-workbench.png`
- Final implementation full page:
  `/Users/kk/code/idream/output/product-design/visual-identity-experiment/final-workbench-full.png`
- Same-input comparison:
  `/Users/kk/code/idream/output/product-design/visual-identity-experiment/reference-vs-implementation.png`
- Route:
  `http://127.0.0.1:3001/admin/characters/alexa-reeves?tab=visual`
- Browser viewport: default 1280 × 720.

## First-principles fidelity

- The primary unit is a reversible experiment round, not an editable identity
  form. Prompt, negative prompt, generation mode, source image, strength,
  profile, orientation, consistency mode, and seed strategy are frozen with
  each run.
- Exploration and authority are separate. Generating a candidate does not
  mutate the active identity, Reference Set, asset pack, or live placement.
  Candidate review is also separate from identity activation.
- Text-to-image is the first-run path. Any completed candidate can become an
  image-to-image source while preserving the positive and negative prompts and
  exposing the real source seed.
- The active identity and selected candidate remain visible together so the
  operator can judge identity drift instead of remembering the baseline.

## Mandatory comparison passes

- Layout and hierarchy: the implementation preserves the source's compact
  experiment composer and dominant comparison canvas inside the existing
  Character workspace shell. The formal identity and production controls are
  moved behind a secondary disclosure.
- Typography, spacing, and surfaces: the warm neutral Admin system, restrained
  radii, thin borders, compact labels, and dense operator rhythm match the
  source direction without adding a competing visual language.
- States and colors: active identity, experiment draft, running, successful,
  candidate selection, source selection, and immutable review confirmation
  remain visually distinct.
- Images: the final canvas uses the real active Character image and a real
  generated `MediaAsset`; no placeholder artwork or simulated completion state
  is used.
- Copy: the Chinese operator copy makes the reversible boundary explicit and
  names the actual frozen parameters and seed lineage.
- Accessibility: mode controls expose tab semantics, candidate buttons expose
  pressed state, form controls are labeled, status and error messages use live
  regions, and the destructive-looking authority transition requires a reason
  plus an explicit quality acknowledgment.
- Layout measurement: `scrollWidth === clientWidth` at 1280px. The final route
  emitted zero browser console warnings and zero errors.

## Interaction and runtime evidence

- A real text-to-image run completed for Alexa Reeves with locked base seed
  `184732` and actual item seed `184732:variant:1`.
- The result survived a fresh page load and appeared in `最近实验轮次`.
- `从这张继续（图生图）` selected the generated asset as the source, restored
  both prompts, switched to the image-to-image profile, exposed strength, and
  selected `沿用所选图` with the source seed.
- Opening `提交候选身份` exposed the immutable-review explanation, mandatory
  reason, quality acknowledgment, and disabled final submit before evidence was
  complete. No review or identity activation was written during QA.
- The active identity remained `v1` throughout generation, finalization,
  reload, and image-to-image preparation.
- Focused shared, Main, and Admin contract, workflow, integration, and UI suites
  passed. Shared, Main, and Admin typechecks passed; focused lint,
  `git diff --check`, and both Main/Admin production builds passed.
- The live Admin route returned HTTP 200. The generation worker completed the
  real job, and the restarted finalizer projected the durable result into the
  Admin comparison canvas.

## Remaining differences

- The source design uses a taller presentation canvas; the implementation was
  verified in the real 1280 × 720 Admin viewport, so the lower prompt controls
  continue below the fold while baseline and candidate remain visible at the
  top.
- The implementation keeps the existing Character workspace header, tabs, data
  provenance, and authority status because they are part of the real product
  context rather than decoration in the source concept.

final result: passed

---

# Design QA — Character List Production Entry

## Comparison target and evidence

- Selected visual truth:
  `/Users/kk/.codex/generated_images/019f7f31-e4e0-7841-a9c8-beb5e76b82af/exec-8890ff3f-2000-4659-9cb2-91c13bf455b1.png`
- Existing combined source/implementation comparison for the selected recurring
  production direction:
  `/Users/kk/code/idream/output/product-design/alexa-character-production/reference-vs-implementation-top.png`
- Authoritative first-time Character-list state:
  `/Users/kk/code/idream/output/product-design/alexa-character-production/character-list-next-action.png`
- Session-only recurring Character-list projection:
  `/Users/kk/code/idream/output/product-design/alexa-character-production/character-list-create-more.png`
- Mobile Character-list entry:
  `/Users/kk/code/idream/output/product-design/alexa-character-production/character-list-mobile.png`
- Live route: `http://127.0.0.1:3001/admin/characters`
- Source pixels: 1672 × 941. List screenshots: 1680 × 941 at a 1680 ×
  941 CSS viewport and device scale factor 1. The selected direction and list
  are different screens, so the source is used for design-language grounding;
  the two equal-size list screenshots are used for exact state comparison.

## Focused state comparison

- First-time state: the Alexa card exposes one compact action region labeled
  `首次设置`, with `完成图片生产设置` as the only next action and a one-sentence
  explanation of identity, references, and route setup.
- Recurring state: the same card and layout change only the production intent:
  `后续图片生产`, `创建更多图片`, and an explicit note that first-time setup is
  not repeated. The action deep-links to the same Character image workspace.
- Performance mode continues to use live monitoring rather than the Studio
  production override, preserving the separation between making images and
  evaluating a live Character.
- The API-provided English label is no longer rendered directly. Chinese state,
  readiness, serving, phase, action, and helper copy are all localized.
- Focused regions were sufficient because this continuation changes only the
  right-side action region within otherwise identical cards. The full 1680 ×
  941 captures confirm card rhythm, alignment, wrapping, and above-the-fold
  density remain stable.

## Required fidelity surfaces

- Typography: reuses the existing Admin font, weights, compact uppercase state
  label, and 14px action hierarchy; no oversized or decorative type was added.
- Spacing and layout: the three-column card reserves a 220–280px action region;
  first-time and recurring copy remain aligned without changing card height.
- Colors and tokens: action cards use the existing warm surface, border, ink,
  muted text, and status tokens from the selected direction.
- Images: genuine Character primary portraits remain unchanged; no placeholder
  or generated replacement asset was introduced.
- Copy: each card now answers current production state, exact next action, and
  why it is next. The raw `Prepare image production` label is absent.
- Accessibility and interaction: action links retain visible focus treatment;
  permission-gated image actions do not expose inaccessible deep links. Browser
  activation verified both first-time and recurring links navigate to
  `/admin/characters/alexa-reeves?tab=assets`.
- Responsive layout: the mobile list stacks the image, Character summary, and
  next-action region; the 390 × 844 check measured `scrollWidth === clientWidth
  === 390`, with no document-level horizontal overflow.

## Verification and result

- Browser QA used the real Alexa first-time authority for the first capture.
  Recurring QA modified only the browser-session response and changed no API,
  database, draft, review, Release, or Serving authority; interception was
  disabled before the final clean page was opened.
- Final clean-page browser console: zero errors and zero warnings.
- Focused Character and i18n suite: 6 files / 43 tests passed. Admin typecheck,
  focused lint, Next 16 production build, PM2 `admin-web` restart, and HTTP 200
  probe passed.
- No actionable P0, P1, or P2 visual, interaction, localization, or responsive
  findings remain.

final result: passed

---

# Design QA — Adaptive Character Image Production Entry

## Selected direction and comparison evidence

- Selected recurring-production direction:
  `/Users/kk/.codex/generated_images/019f7f31-e4e0-7841-a9c8-beb5e76b82af/exec-8890ff3f-2000-4659-9cb2-91c13bf455b1.png`
- Combined selected direction and final implementation:
  `/Users/kk/code/idream/output/product-design/alexa-character-production/reference-vs-implementation-top.png`
- Final project overview:
  `/Users/kk/code/idream/output/product-design/alexa-character-production/final-project-overview.png`
- Final first-time guidance:
  `/Users/kk/code/idream/output/product-design/alexa-character-production/final-first-time-guidance.png`
- Final recurring image library:
  `/Users/kk/code/idream/output/product-design/alexa-character-production/final-recurring-library-top.png`
- Live route:
  `http://127.0.0.1:3001/admin/characters/alexa-reeves?tab=project`

## Product-state result

- The Project landing state now answers three questions immediately: current
  production status, the single next action, and where that action sits in the
  Character production sequence. Strategy fields and collaboration evidence
  remain available in collapsed secondary sections.
- The first-time/blocked Assets state exposes one prominent visual-setup action,
  collapses later setup steps, disables purpose wandering, pauses candidate
  history, and does not render the candidate review inspector or action bar.
- Once visual identity and the image route are ready, Assets becomes the
  recurring image workspace: purpose filters, image library, locked-identity
  ribbon, and a right-side New image batch composer. It does not repeat the
  first-time setup or duplicate the Character page title.
- Candidate review is a separate mode. Opening an image hides the batch composer
  and exposes review evidence; Back to image library restores recurring
  production. Review, draft adoption, Release, and live publication remain
  separate authority actions.

## Visual comparison

- The implementation preserves the real Admin shell, warm neutral tokens,
  typography, borders, radii, Lucide icon language, and genuine Character
  assets. No placeholder art or new visual system was introduced.
- Against the selected direction, the final recurring state keeps the same
  hierarchy: compact Character status, purpose filters, locked visual identity,
  dominant image grid, and a narrow new-batch composer.
- The production UI intentionally uses the real Alexa candidate history rather
  than the direction's uniform concept images. The differing image content is
  data, not a layout mismatch.
- The previous redundant recurring hero was removed after the combined-image
  comparison, leaving one `Alexa Reeves 的图片` page heading and more room for
  the library/composer pair.

## Interaction and runtime evidence

- Project overview uses translated operator-facing tabs and contains no raw
  `project`, `visual`, `assets`, or `preview` tab labels.
- Real Alexa authority on the local database exercised the first-time/repair
  state: one next action is visible, candidate history is paused, and no review
  inspector is mounted.
- The local database contains no active visual profile/reference-set pair, so
  recurring-state browser QA used a session-only intercepted Character detail
  response. It changed no API, database, draft, review, or Release authority.
- In that non-persistent ready state, purpose selection changed Portrait to Hero,
  batch size changed from 6 to 4, and the Chinese brief changed with the purpose.
  Opening candidate 1 entered review and hid New image batch; returning restored
  the composer.
- Final browser console: zero errors and zero warnings in both the authoritative
  first-time state and the session-only recurring projection.
- Focused Character/i18n regression suite: 100/100 passed before final polish;
  final focused suite: 41/41 passed. Admin typecheck, focused lint, Next 16
  production build, PM2 `admin-web` restart, and HTTP 200 probe passed.

final result: passed

---

# Design QA — Character Asset Studio

## Comparison target

- Source: `/Users/kk/.codex/generated_images/019f5ab5-ed1c-7b22-b80d-19fecb0a008d/exec-a68e5595-93f4-423f-b8ab-0e35fdd2e4b2.png`
- Desktop implementation: `/Users/kk/code/idream/.tmp/character-asset-studio-desktop-viewport.png`
- Full comparison: `/Users/kk/code/idream/.tmp/character-asset-studio-comparison-final.png`
- Focused decision comparison: `/Users/kk/code/idream/.tmp/character-asset-studio-comparison-focus.png`
- Tablet: `/Users/kk/code/idream/.tmp/character-asset-studio-tablet.png`
- Mobile pack: `/Users/kk/code/idream/.tmp/character-asset-studio-mobile-pack.png`
- Mobile decision: `/Users/kk/code/idream/.tmp/character-asset-studio-mobile-decision.png`
- Route: `http://localhost:3001/admin/characters/asset-studio-demo-character?tab=assets`
- Viewports: 1440 × 1024, 834 × 1024, and 375 × 812.

## Full and focused comparison findings

- The implementation preserves the source's three-part decision model: locked identity, generated candidates, and customer-placement previews.
- Candidate actions remain visible above the large image; the selected state is explicit and links to the real signed renderer preview.
- Existing iDream Admin navigation, workspace tabs, typography, tokens, spacing, buttons, and responsive shell are retained.
- Pack progress promotes the three operator outcomes—primary portrait, character hero, and chat moments—while identity, references, workflow, and qualified route remain automatic.
- Technical lineage and the human-readable creative brief use progressive disclosure.

## Comparison history

1. Initial build left the primary decision below the first desktop fold; the action row moved above the candidate canvas.
2. Review found a stale Run-detail race, coupled review/project-write authority, a nested `main`, and an unnamed textarea; all were corrected before the final comparison.
3. Review also found Hero and Chat were only reviewed, not pinned. All three exact Run Item/Asset choices now persist in `CharacterProject.draftAssetPack` and enter the immutable Release manifest.
4. Final combined comparison found no remaining P0, P1, or P2 visual or interaction defects.

## Intentional differences

- The source is a dedicated full-page studio. The implementation lives in Character Project so project phase, Release authority, preview, and audit evidence remain visible.
- The source compare toggle becomes a persistent canonical identity rail.
- Pack progress is promoted above the studio because the operator outcome spans portrait, hero, and chat assets.

## Functional QA

- Assets loads only character-scoped Creative Runs; candidate selection and progressive-disclosure controls work.
- Live browser closure generated real Hero and Chat candidates through the running BullMQ workers, approved identity as soon as the first candidate was ready, and selected both assets without waiting for the rest of each batch.
- Selecting the Hero advanced the Project from v2 to v3 and moved directly to Chat moments; selecting Chat advanced it to v4 and opened the real signed Preview renderer.
- The production integration test covers create Run → queued attempts/outbox dispatch → worker completion → generated assets → review, including a selected-candidate variation reference.
- Asset Studio and Release lifecycle integration tests pin portrait, hero, and chat choices to the Project draft pack and immutable Release manifest.
- Release validation and publish execution re-check that every pack asset remains available and that its exact latest review decision still authorizes publication.
- Review and Project selection are separate permissions and actions.
- The signed draft renderer displays the selected portrait in discovery card, detail, opening/five-turn, and chat-image surfaces without changing live Serving.
- PM2 now injects one shared internal callback token into main, admin, chat, generation, finalizer, event, and command processes; the live worker callback path was verified after restart.
- The final full-suite run exposed and fixed a pre-existing queue-order assumption in the character preview test; the test now waits for its exact preview job instead of assuming it is among the first four global jobs.
- Desktop, tablet, and mobile have no document-level horizontal overflow; the final browser console has no warnings or errors.

final result: passed

## 2026-07-17 final remediation closure

This section supersedes any pre-remediation workflow assumptions above while
preserving the earlier comparison history.

### Reviewed bootstrap evidence

![Character Asset Studio reviewed bootstrap](/Users/kk/code/idream/output/playwright/character-asset-studio-bootstrap-review.png)

- Evidence: `/Users/kk/code/idream/output/playwright/character-asset-studio-bootstrap-review.png`
- Route pattern: `/admin/characters/{characterId}?tab=assets`
- Capture: 496 × 2000 focused full-page view of the real first-portrait state.
- The screen names the job as establishing the face customers will recognize,
  states that the route has no reference input, locks Hero and Chat until an
  identity is committed, and keeps `identityConsistency` intentionally
  unscored while requiring the four visible quality checks.
- Identity authority, candidate decision, customer-surface previews, creative
  brief and technical lineage remain separate surfaces; the empty canonical
  rail does not pretend that a reference already exists.

### Latest authority and interaction changes

- Signed Preview now renders three exact, distinct surfaces: Feed uses the
  selected portrait, Detail uses the selected hero, and Chat uses the selected
  chat asset. Missing/unavailable/drifted slots are explicit and block QA;
  portrait fallback no longer masks an incomplete pack.
- `More like this` exposes one server-projected readiness result and a concrete
  blocker instead of implying every approved candidate is a valid variation
  source.
- An unused approved Character candidate has a dedicated terminal-disposition
  panel. The original evidence stays visible; a selected candidate explains
  that it must be replaced first.
- The Visual workbench exposes Character Looks that use role images and gives
  the operator a precise archive flow rather than leaving an invisible
  dependency.
- Image Library bulk archive uses selection, preflight, dependency repair links,
  exact sorted-id confirmation, and one atomic write. The client sends one
  batch POST instead of one detail request per asset; stale/missing targets are
  named, and no partial success is implied.
- Featured curation labels configured and effectively live Characters as
  separate facts. Dirty-history diagnostics are visible. A version conflict
  refreshes current authority and version while preserving the operator's
  unsaved ids, reason, and confirmation.
- Live Preview links are visibly disposable authority receipts rather than
  permanent URLs: Serving pause/resume, rollback, or Release/version changes
  revoke the old token.
- Lost-response recovery is now a visible product state rather than an
  invisible retry. Create, review, selection, and Character Create retain the
  exact request snapshot and idempotency key; `Resume` reuses them, while a
  committed `Verify` performs projection reads only.
- A receipt older than 24 hours, or one whose request snapshot is no longer
  safely replayable, remains visibly locked in `reconciliation_required`.
  Reconcile either returns exact typed projection evidence for the committed
  mutation or creates a durable cancelled tombstone that blocks a late writer;
  it never silently deletes the receipt or invents a replacement request.
- A second tab for the same actor/scope adopts the first recoverable intent and
  locks conflicting inputs instead of replacing its receipt. Actor changes
  remount the workspace, and an explicit Character Create `?draft=` remains
  isolated from unrelated new-character recovery.

These changes preserve the selected minimalist operations direction: one
dominant next action, compact status/evidence, progressive disclosure, thin
borders, restrained radii, and no ornamental or fake generation surfaces.

### Verification and closeout status

- The isolated Main/Admin Playwright run against image/asset checkpoint
  `f17a2034` passed 9/9 in 1.6 minutes. Main/Shared/Chat changed later in the
  shared worktree, so the unified current-worktree rerun remains pending.
- The blank-character journey intentionally opens `Visual identity` first,
  verifies the reviewed-anchor warning and disabled `Create & activate
  version`, follows `Open Character Assets`, then completes the reviewed
  bootstrap, Portrait/Hero/Chat pack, immutable QA, Release, Serving, monitor
  and rollback authority checks.
- The same suite completes targetless generic image creation, structured review,
  verified Campaign placement and withdrawal, and authoritative Incident/Case
  follow-through.
- Desktop, 375px and 834px gates cover keyboard operation, axe WCAG 2.2 AA,
  focus trapping/restoration, page-level horizontal overflow and console/LCP
  failure assertions.
- The final implementation introduces no gradients, fake generated previews,
  ornamental hero treatment or parameter-heavy model controls. It retains the
  warm monochrome Admin system, restrained radii, thin borders, progressive
  disclosure and decision-first hierarchy required by the selected design
  direction.
- Character receipt recovery now authorizes both the expected Character and the
  trusted receipt's actual Character before revealing or resolving authority.
  Bootstrap and draft selection unlock only against their exact typed
  projections; an asset in the wrong purpose slot remains locked. Legacy
  wrong-type cancelled tombstones use the server-returned trusted type for a
  safe read-only retry.
- Image/asset checkpoint automated results: Shared 35 files / 170 tests; Admin 87 / 381; Gen
  14 / 117; Chat 25 / 190; Main 206 files / 1,418 tests passed plus 2 files /
  3 tests explicitly skipped, for 208 Main files / 1,421 Main tests total and
  2,276 passed tests across all five packages.
- Root lint completed with 0 errors and 0 warnings in the applicable workspace
  tasks. Root typecheck completed 6/6 workspace tasks. `git diff --check`
  passed after documentation closeout.
- An earlier isolated development-server probe returned 200 for Main home and
  Characters, Admin Characters, Character Create, Creative Runs, and the Admin
  bootstrap proxy. The receipt reconciliation route compiled and returned the
  expected unauthenticated 401 directly and through the Admin proxy. The
  isolated servers were stopped after the probe; the later production probe
  below is the latest-source runtime evidence.
- Main/Admin production standalone outputs were built at the image/asset
  checkpoint (`BUILD_ID` at 19:50:56 / 19:50:48 PDT). After the intentional
  rollout restart, default PM2 had all eight entries online; the same
  Main/Admin pages and new recovery route passed on ports 3000/3001, and
  repeated probes returned the expected statuses. Main/Shared/Chat source
  changed afterward, so this is scoped checkpoint runtime evidence rather than
  the current shared-worktree final state.
- The checkpoint browser run covers the exact blank-Character bootstrap,
  Portrait/Hero/Chat generation-review-selection loop, the real Draft Preview
  renderer, immutable QA, strict-v2 Release, public Serving, monitor/rollback,
  durable actor-scoped recovery, desktop/375px/834px, keyboard, WCAG, overflow,
  and console/LCP gates. A legacy avatar-only Release was verified to fail
  closed and was never used by a publish write path.
- A post-checkpoint Release authority audit closed the migration-only
  qualification ordering/DELETE gap, exact policy/nested-route gap, and the
  malformed non-legacy DTO gap. Fresh and baseline-upgrade migration rehearsals
  pass; the development database is 57/57 with no drift, zero malformed
  generated qualifications, and zero broken live/public qualification chains.
  Focused Release/Asset Studio tests pass 65/65 and the Shared strict manifest
  parser passes 7/7. The unified current-worktree runtime rerun remains owned by
  the final qualification task.

final result: DONE_WITH_CONCERNS

### Environment concerns

- The 9/9 is isolated local evidence for the image/asset checkpoint. The later
  shared worktree requires a unified rerun. External production providers,
  production data backfill, capacity, canary/error-budget observation, and
  public-launch readiness remain `NOT_EVALUATED`.
- The final default PM2 snapshot has all eight Main/Admin/Chat/Gen consumer and
  worker entries online after the intentional rollout restart. Existing restart
  counters reflect that rollout; the final probes caused no new error-log or
  restart activity. This is local runtime evidence, not a public-production
  claim.
- During test-harness hardening, an early Vitest global setup accidentally reset
  the local `idream` development database. Schema and seed data were restored,
  and the harness now refuses non-test-scoped database names. Unbacked local
  records from before the reset may be unrecoverable.

---

# Design QA — Character Asset Studio 2.1

## Comparison target

- Selected source visual:
  `/Users/kk/code/idream/output/product-design/character-asset-studio/contact-sheet-triage.png`
- Desktop implementation:
  `/Users/kk/code/idream/output/product-design/character-asset-studio/implementation-candidate-grid-final.png`
- Two-candidate comparison:
  `/Users/kk/code/idream/output/product-design/character-asset-studio/implementation-comparison-final.png`
- Mobile workspace and candidate controls:
  `/Users/kk/code/idream/output/product-design/character-asset-studio/implementation-mobile-viewport-final.png`
  and
  `/Users/kk/code/idream/output/product-design/character-asset-studio/implementation-mobile-candidate-controls-final.png`
- Combined source and implementation evidence:
  `/Users/kk/code/idream/output/product-design/character-asset-studio/reference-vs-implementation-final.png`
- Route:
  `http://localhost:3011/admin/characters/alexa-reeves?tab=assets`
- Viewports: default 1280 × 720 plus explicit 1440 × 1024, 1024 × 900,
  and 390 × 844 checks.

## First-principles fidelity

- The candidate batch remains the dominant work surface: a dense 3 × 2 contact
  sheet at desktop width, a narrow decision inspector, and an always-visible
  bottom decision bar.
- The selected visual's multi-select state is intentionally refined into one
  active decision target plus at most one comparison candidate. Comparison is
  a local viewing mode and does not mutate review, draft, or Release authority.
- Approval, draft-slot adoption, and Release publication remain three separate
  states and actions. The UI does not imply that reviewing a candidate changes
  the live Character.
- The compact identity ribbon preserves the locked identity, reference set, and
  qualified route context without competing with the candidate images.
- Portrait, Hero, and Chat remain explicit production outcomes in the
  three-step rail. Customer context shows the active candidate in the relevant
  real surface rather than a generic preview.

## Mandatory comparison passes

- Typography and spacing: the implementation retains the existing Admin
  typography and warm neutral shell. Candidate numbers, state labels, evidence
  controls, and the fixed action bar preserve the source hierarchy without
  oversized headings or ornamental treatment.
- Layout and surfaces: the desktop split activates at 1280px, uses thin borders
  and restrained radii, and gives the contact sheet materially more space than
  the inspector. There is no document-level horizontal overflow at any tested
  viewport.
- Colors and states: active, comparison, draft, approved, rejected, and ready
  are distinct semantic states. Active selection uses ink; comparison uses the
  existing blue token; approval and draft authority use green.
- Images: the UI renders real `MediaAsset` URLs through `AssetImage`. The local
  QA fixture uses existing Character images only to exercise crop, density, and
  mixed visual content; no placeholder art or CSS illustration was added to
  the product.
- Icons: Lucide outline icons are used for comparison, pinning, rejection,
  approval, refresh, generation, and authority status with consistent stroke
  weight and button alignment.
- Copy: localized Chinese and English operator copy explicitly distinguishes
  current candidate, comparison candidate, review evidence, draft adoption,
  and Release publication.
- Accessibility: candidate cards are semantic buttons with pressed state and
  exact accessible names; compare pins are separate controls; the evidence
  checklist, score, identity consistency, and reason are labeled; visible focus
  treatment is preserved. The review-evidence region also has a stable
  accessible name independent of the active candidate number.
- Responsiveness: desktop uses the 3 × 2 sheet and sticky inspector; tablet
  stacks the inspector; mobile becomes a single-column flow with compact fixed
  action labels. Measured `scrollWidth === clientWidth` at 1440, 1024, and
  390px. Candidate comparison controls measure 44 × 44px on mobile.

## Interaction and implementation evidence

- Selecting a candidate changes the only active review target.
- Pinning candidate 2 opens the two-candidate comparison stage; returning to the
  batch preserves the active candidate. `Make current` moves the single active
  authority target to candidate 2 and updates the inspector and fixed action
  bar together.
- The full browser journey proves that comparison and local candidate
  activation create no review decision and do not advance the Character
  Project version before an explicit review or draft-adoption action.
- The decision action bar remains visible while scanning the batch and becomes
  compact on mobile.
- The inspector shows customer context and requires explicit quality,
  consistency, score, and reason evidence before approval.
- Admin full suite: 89 files and 401 tests passed.
- Focused Character Asset Studio and i18n suite: 3 files and 37 tests passed.
- Isolated Admin v2 workspace Playwright suite: 9/9 passed in 1.5 minutes,
  including the blank-Character Portrait/Hero/Chat pack, immutable QA and
  Release path, keyboard operation, WCAG 2.2 AA gates, 375px mobile and 834px
  tablet workflows.
- Admin and Main typecheck, focused lint, Admin production build, and
  `git diff --check` passed.
- Browser console had zero errors and zero warnings on the final Studio route.

## Remaining differences

- The source visual is a standalone studio, while the implementation keeps the
  existing Character Project header and tabs so project and Release authority
  remain visible.
- The source uses one consistent generated identity set. The browser QA fixture
  deliberately reuses distinct local Character assets to stress-test mixed
  crops and state legibility; this is test data, not shipped UI content.
- A Character that is not image-ready still shows the existing readiness
  repair card before the contact sheet. This is truthful authority state and
  does not block review of an already projected batch.

final result: passed

---

# Final closeout — Adaptive Character Entry

The later adaptive-entry QA above supersedes the earlier concern about showing
the contact sheet while image production is blocked. The authoritative Alexa
state now pauses candidate history and exposes one setup action; the recurring
state uses the selected image-library and new-batch-composer direction. Final
browser, comparison-image, interaction, localization, test, build, HTTP, PM2,
and zero-console-error evidence all passed.

The Character list now carries the same adaptive intent into discovery: real
first-time authority shows `完成图片生产设置`, while an image-ready Studio card
shows `创建更多图片` and Performance retains monitoring. Desktop and 390px
browser evidence, exact deep-link activation, permission gating, localization,
and a final clean-console reload passed without changing persistent authority.

final result: passed

---

# Final closeout — Visual Identity Experiment Workbench

The source design and live implementation were compared in one image, and the
real Alexa journey passed: editable positive and negative prompts, random and
locked seeds, a durable text-to-image result, exact seed lineage, a one-click
image-to-image continuation with source and strength, and an explicit
candidate-review gate. The active identity remained `v1`, the page had no
horizontal overflow, and the Browser console had no warnings or errors.

final result: passed

---

# Final closeout — Character Detail Media Workspace (Option 2)

The Option 2 source and the final 1488 × 1058 Images implementation were
compared together at original resolution. The compact Character header, direct
Images/Video tabs, dominant real-media preview, horizontal filmstrip, and
right-side Inspect/New composer now match the selected interaction model. The
separate Video state, real media assets, primary interactions, fresh console,
57 focused tests, typecheck, lint, production build, and diff check passed.

final result: passed

---

# Final closeout — Character Detail Tabs Simplification

The selected Option 2 media-workspace reference and the final Visual Identity
screen were inspected together. The detail workspace now uses one consistent
hierarchy across all eight tabs: compact Character facts, one dominant task,
and secondary or technical controls in disclosures.

- Visual Identity puts the baseline/candidate comparison canvas first and
  keeps only the prompt and Generate action visible. Route, reference image,
  negative prompt, model, seed, and identity constraints remain available in
  collapsed settings.
- Voice removes the large prescribed next-step hero. The live authority is a
  compact fact strip, candidate creation is the primary task, and runtime,
  system defaults, performance direction, and advanced Fish controls are
  secondary disclosures.
- Launch Preview stops rendering unavailable iframes and a disabled seven-part
  QA form while the image pack is incomplete. It shows the exact blocker and a
  direct live-versus-draft asset comparison; QA opens when the draft is ready.
- Release cards use human version labels first. Snapshot IDs and lineage move
  into Technical Evidence; the action panel exposes the current next action,
  while schedule, rollback, pause, resume, and retire live under one operations
  disclosure.
- Live Performance replaces large metric cards with compact evidence rows and
  keeps a new portfolio decision collapsed until requested.
- Details, Images, and Video were rechecked and already fit the selected
  compact header, direct tabs, dominant media, and single-composer direction.

The final browser pass covered Visual Identity, Voice, Launch Preview, Release,
and Live Performance using the authoritative Alexa workspace and captured
fresh evidence in
`output/product-design/character-tabs-redesign-2026-08-01/15-final-visual.jpg`
through `19-final-monitor.jpg`. The fresh browser session reported zero console
errors. Focused lint, Admin typecheck, 72 related tests, and the Admin production
build passed.

final result: passed

---

# Superseding result — Full Character Workspace Audit

The complete comparison record is in the earlier `Full Character Workspace
Audit` section. It covers the selected 1487 × 1058 source, the final 1440 ×
1024 desktop implementation, all eight 410 × 734 mobile destinations, primary
interactions, localization, authority boundaries, 144 Character tests,
typecheck, focused lint, production build, and targeted diff checks. The final
Browser pass had no console errors; one earlier development-session LCP warning
remains a non-blocking P3 follow-up.

final result: passed
