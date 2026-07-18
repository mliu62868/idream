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
