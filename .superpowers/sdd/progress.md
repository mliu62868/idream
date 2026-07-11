# P1 backend abstraction — progress ledger
Branch: feat/image-gen-redesign
Base (before Task 1): 8558df8b0bb0a35e7a303cb610953da4ff162cba
Plan: docs/superpowers/plans/2026-07-07-image-gen-p1-backend-abstraction.md

Task 1: complete (commit 5823e4b, review clean ✅)
Task 2: complete (folded into 035b662 ✅)
Task 3: complete (commit 035b662, review clean ✅)
Task 4: complete (commits 3d52ed5 + fix c65bf84, review clean ✅)
Task 5: complete (registry.ts + backend-image-model.ts + wiring, review clean ✅)
Task 6: RedCraft descriptor complete (commit 5753df1, review clean ✅). Qwen-Edit descriptor deferred → Task 6b after P0 convert.
Task 7: complete (commit ec0591f, review clean ✅; implementer crashed post-commit, controller-verified)
Task 8: complete (commit 14082e6, review clean ✅; real e2e smoke ok, 832x1216, 1.1s warm)


Minor findings (for final review):
- Task 1: loadWorkflowDescriptors has no direct unit test (covered by Task 6 loader test).
- Task 3: pending-map entry leaks if poll() never called (bounded; hardening TODO).
- Task 3: asset w/h resolved PNG-IHDR-first then slots fallback (defensible; note for consumers).
- Task 4: no dedicated referenceImages-capability test; no spawn-ENOENT test (deferred).
- Task 5: backend-image-model numericControl allows non-integer w/h/steps (providers.ts version requires Number.isInteger) — reconcile in final review.
- Task 5: registryPromise has no invalidation hook (test-only concern).

Final review (opus): Needs fixes -> fix wave commit 60a8e37 (orientation wire-vocab, stableNumericSeed, submit/health AbortController, numericControl integer, docs) -> re-review dispatched.
P0 collection complete: Qwen-Rapid-AIO v19 bf16 (plain-fp8 cast) t2i 64s cold + identity edit 72s, both on MPS 8188. OOM lesson: don't co-load 24G+53G. urllib system-proxy 502 gotcha (python probes only).
Task 6b (qwen-image-edit descriptor + ComfyUIBackend reference-image upload wiring): NOT in P1 plan scope -> first task of next phase.
Re-review of 60a8e37: Approved (all 5 findings resolved; circular import safe, optional tidy: extract stableNumericSeed to leaf util). Converter committed to packages/gen/scripts/. BRANCH COMPLETE.

# P2 ops console — progress ledger
Branch: feat/image-gen-p2-ops-console
Base (before P2 Task 1): 0316953a415f66a549f70b79eda280ec72c740fa
Plan: docs/superpowers/plans/2026-07-07-image-gen-p2-ops-console.md

P2 Task 1: complete (commit 775de8d, review clean ✅; touch-set 8 files incl. gen tsconfig/vitest aliases per repo convention)
P2 Task 2: complete (9464eff + test fix 80414f6, review clean ✅)
P2 Task 3: complete (commit 018c481, review clean ✅)
P2 Task 4: complete (commit 0241f2b, review clean ✅; real edit smoke 70.3s through abstraction, identity preserved)
P2 Task 5: complete (commit eda1912, review clean ✅; API-error mid-task, resumed via SendMessage)
P2 Task 6: complete (commit 64fd09f, review clean ✅; live Chrome walkthrough deferred to Task 9)
P2 Task 7: complete (commit de219a4, review clean ✅; test DB auto-applied col; DEV SQL still pending user before Task 9)
P2 Task 8: complete (commit cf736c4, review clean ✅)
P2 Task 9: pending
- P2 Task 2 minor: unknown-key error text says 'unknown modelId' even for workflowKey miss (wording only, deferred to final review).
- P2 Task 3 minors: upload malformed-response error drops raw body text; multipart test asserts shape not field contents; image-slot pairing is index-based (role ignored) — dormant until >1 image slot descriptors.
- P2 Task 5 minors: comfyuiHealth catch branch lacks latencyMs; TTL-expiry path untested; onSkip not surfaced (deferred).
- P2 Task 7 minors: audit snapshot omits workflowKey (pre-existing pattern); SQL-before-real-DB hazard spans all ~24 GenerationModelProfile query sites, not just job-create.
- P2 Task 8 minors: no P2002 catch on concurrent mint (parity w/ existing helpers, low-freq admin action); i18n zh missing (pre-existing pattern).
P2 impl (Tasks 1-8) COMPLETE. Task 9 = check + live walkthrough (needs dev SQL) + docs.

P2 COMPLETE: all 8 tasks + I-1/I-2 fixes reviewed; whole-branch review 'Ready to merge'; gates green (gen 81, shared 34, typecheck 6/6, lint 2/2, admin ops-loop integration 66/66 on real test DB). Merging to master. Remaining USER steps: apply db/sql/2026-07-07-...workflowKey.sql to dev/prod before deploy; optional browser walkthrough.

=== P3 SDD START ===
Base (before P3 Task 1): 9fe6273619ee7ef87eb487e218f85def6d04c5fa
Plan: docs/superpowers/plans/2026-07-07-image-gen-p3-pregen-metrics.md
P3 Task 1: complete (commit c815bc1, review clean ✅; 53/53 tests, typecheck 6/6)
- P3 Task 1 minors: per-call DB lookup at both ops call sites (fine at admin volume); no isolated unit test for generation-pricing.ts helper (covered via integration).
P3 Task 2: complete (commit ff27ef0, review clean ✅; 54/54 tests; core sig deviation (request,actor,body) pre-authorized for audit needs)
- P3 Task 2 minor: resolveDefaultProfileKey vs resolveProductionProfile conceptual parallel (not true dup; consolidate only if defaulting logic multiplies).
P3 Task 3: complete (commits a18fa3b + fix 9813e92, review clean after fix ✅; Critical negative-avgDurationMs fixture/clock bug caught by reviewer 5/5-rerun-verified fixed)
- P3 Task 3 note: test helper api() splits segments from raw path — never inline "?x=" in path, use query option.
P3 Task 4: complete (commit a440555, review clean ✅; typecheck+lint pass; confirmation===item.id & draft→publish two-step both verified-correct deviations)
P3 Task 5: complete (commits de0977c + i18n fix 248df3b, review clean after fix ✅; 5 AdminConsoleClient touch points verified; field audit clean)
P3 Task 6: complete (commit c634c74, review clean ✅; 56/56 tests x3, bun run check green, live API smoke on real server; BONUS real bugfix: batch jobs now route model=workflowKey??pipelineModel matching user path, reviewer-verified)
P3 final review: Ready to merge (opus; Critical refund-mint bug found+fixed 58c0b82 w/ type-enforced sourceType param + partial-refund site; 85 tests green independent rerun). Minors all deferred. Merging to master.

=== P4 SDD START ===
Base (before P4 Task 1): 2b1547756a6c3cde4bc26b64938d866e4a540af9
Plan: docs/superpowers/plans/2026-07-08-image-gen-p4-chat-agent.md
FC probes: PASS (tools/negative/round-trip/streaming, enable_thinking=false required) — scratchpad p4-fc-probe-results.md
P4 Task 1: complete (commit 3ab2b52e, review clean ✅; 106/106 chat + typecheck 6/6; supportsTools optional-on-interface + pipeline via ctor arg adjudicated OK)
- P4 Task 1 minors: id/name merge last-non-empty (defensive tweak possible); createProviders near-dup literals.
P4 Task 2: complete (commit 206ed957, review clean ✅; 112/112 chat; EN AND-pair folded to dual-lookahead regex verified equivalent; ZH-on-toLowerCase noted, CJK case-invariant)
P4 Task 3: complete (commit eefb4429, review clean ✅; 114/114 chat; XOR removed on FC path, planner fallback intact, double-trigger mutually exclusive)
- P4 Task 3 minor: validateToolCall casts to GenerateImageAsyncArgs + hardcoded tool name — flag when adding tool #2.
P4 Task 4: complete (commit 7074a3bf, review clean ✅; chat 117/117 + main 24/24; SQL idempotent, grants survive REPLACE, defaults TRUE everywhere; chat prisma view-mapping is established mechanism)
- P4 Task 4 note: pullers must bun run db:generate in packages/chat (generated/ gitignored).
P4 Task 5: complete (commit a3a039d9, review clean ✅; chat 117/117 + main 24/24; promptHint-first order verified justified; no double-injection/mutation risks)
- P4 Task 5 minors: inbox read-then-write benign race note; consolidate mock introspection seams if more accumulate.
P4 Task 6: complete (commit 52f1e11c, review clean ✅; 58/58 admin-console; merge preserves keys; race noted-only)
P4 Task 7: complete (acceptance e2e added to web.test.ts; chat 118/118, main admin-console+event-consumer+image-generation-service 82/82, bun run check all green; real-model smoke via launch:probe:chat passed against oMLX Qwen3.6-35B-A3B; real-service live walkthrough blocked — local dev DB missing db/sql/2026-07-08-chat-visual-passport-and-tool-flags.sql (USER step, not run by agent per schema-change policy); spec §7/§8.3 + CURRENT_FUNCTIONAL_COVERAGE.md updated)
- P4 Task 7 note: apply the P4 boundary SQL to dev/prod + packages/chat db:generate before the live walkthrough can be re-run for real.
P4 Task 7: complete (commit 983633f3, review clean ✅; chat 118/118 + main 82/82 + check green; live real-service walkthrough blocked on user-side dev SQL — documented honestly)
P4 final review: Ready to merge (opus; zero Critical/Important; all Minors defer). Merging to master.
P4 COMPLETE.

=== P5 SDD START ===
Base (before P5 Task 1): faf0b38d8d3cdd667571a6b132d3dcf76b10938d
Plan: docs/superpowers/plans/2026-07-08-image-gen-p5-deepening.md
P5 Task 1: complete (commit 11e22cfa, review clean ✅; 121/121 chat; finalize re-derivation compile-guarded no drift risk)
- P5 Task 1 minors: console.warn lost zod flatten; consider assertNever helper if 3rd exhaustive switch appears.
P5 Task 2: complete (commits d77d80ee + fix eab593a3, review clean after fix ✅; 132/132 chat; retry-carry now tested via real confirm route; degraded edit metadata honest; bonus: exhaustiveness idiom bug fixed)
P5 Task 3: complete (commits a4a33351 + fix 875e8853, review clean after fix ✅; 26/26; deterministic degrade guard — fallback profile would otherwise mis-forward source image to sd_cpp)
P5 Task 4: complete (commit ac5411df, review clean ✅; 59/59; campaign-only instrumentation, raw SQL parameterized)
- P5 Task 4 minors: NULL-placementId grouping untested; RemixSection skips SectionShell (cosmetic).
P5 Task 5: complete (commit 817ffb85, review clean ✅; 36/36 + regression 40/40; hash sorted-key stable; per-group 8-line cap is forward-only prompt change for dense characters — noted for rollup doc)
P5 Task 6+7: complete (commits ca9e0d8e + 3f7f6aa0 + test fix 510d1b87, review clean after fix ✅; 130/130 + 63/63 x3 stable)
P5 Task 8: complete (acceptance e2e added to web.test.ts as single continuous it; chat 133/133, main admin-console+event-consumer+image-generation-service+generation-pricing+launch-readiness 156/156, bun run check all green; real-model FC probe passed against oMLX Qwen3.6-35B-A3B for both tools + neutral no-call — probe initially 502'd due to local HTTP_PROXY/misconfigured NO_PROXY intercepting requests containing tool names, bypassed proxy explicitly and reran clean; ComfyUI img2img bonus skipped — avoided co-loading with FC probe model per OOM history; spec §7 + CURRENT_FUNCTIONAL_COVERAGE.md updated)
P5 final review: pending.
P5 Task 8: complete (commit 6aa68efe, review clean ✅; chat 133/133 + main 156/156 + check green; real-model 3-scenario FC probe all correct — edit/generate/neutral)
P5 final review: Ready to merge (opus; edit-loop seam verified end-to-end incl. storageKey hydration unreachable-throw; all Minors defer). Merging to master.
P5 COMPLETE.

=== ADMIN CONSOLE IA REDESIGN SDD START ===
Base (before Task 1): ff0fd484a1773475ad150cdd72d7241a142575f7
Branch: admin-console-ia-redesign
Plan: docs/superpowers/plans/2026-07-08-admin-console-ia-redesign.md
Scope: presentation-layer only (zero DB / zero API). 5 tasks. Confirmed: 模型配置 (not 档案); Visual Passport→视觉身份 in Task 4.
Task 1: complete (commit 94f329e7, review clean ✅; nav-config.ts SSoT, normalizeSection behavior-equivalence verified id-by-id, 8 icons pruned, 6/6 tests).
Task 2: complete (commit 0009de56, review clean ✅ opus; four-place sync verified for generation/recipes+presets, ConfigTab trim consistent, migration loses nothing, 11/11 + live Playwright smoke).
- Task 2 Minor (FOLD INTO TASK 4 copy pass): ConfigTabNav settings entry meta "Presets and flags" → should be "Feature flags" (presets moved out).
- Task 2 Minor (FOLD INTO TASK 4 copy pass): ContentOpsViews.tsx eyebrow="Content Ops" on ProductionStudio/AssetLibrary/Placements now under Media/角色 groups — relabel to match new IA (i18n).
Task 3: complete (commit 229dcd1e, review clean ✅ sonnet; ImageProductionView 2 tabs, reused components untouched, official embed intact, typecheck+lint+live Playwright smoke).
- Task 3 Minor (defer to final): ImageProductionView shows t("Loading…") on zero-results too (empty vs loading state); spec-inherited from brief verbatim code.
Task 4: complete (commit 7c601563, review clean ✅ sonnet; zh for all 3 pipeline groups incl 5 pre-existing gaps, Visual Passport→视觉身份 label-only, fixes A(meta) + B(eyebrows) applied, hasAdminZh, 14/14).
- Task 4 Minor (report only, no code defect): report self-review mis-cited eyebrow render site (real: ContentOpsViews ViewHeader; functional claim correct).
- Task 4 Minor (cleanup, optional): orphaned zh entry "Presets and flags":"预设和开关" kept per no-removal constraint (meta now "Feature flags").
Task 5: complete (commit 7a359f14, spec→已实现; grep clean, lint+typecheck clean, vitest 14/14, drift guard OK no schema/api/server, live click-through 18 nav items 0 console errors, 视觉身份 confirmed). Task-2 minors both RESOLVED in Task 4.
ALL 5 TASKS COMPLETE. Open minors for final-review triage: (1) ImageProductionView "Loading…" shows on zero-results too (empty vs loading); (2) orphaned zh entry "Presets and flags":"预设和开关".
Final whole-branch review (opus): Needs fixes — copy-only §8 leaks on renamed pages. Structure/sync/types all PASS.
  IMPORTANT (fixing): AdminConsoleClient ConfigOverviewHeader eyebrow t("Profiles & Rollout") → "Model Profiles" (renders on Model Profiles page, no zh so English both locales); +lower-vis refs ~:3491 sentence, ~:3998 "Open Profiles & Rollout" button. TemplatesView h2 t("Templates") → "Character Starters" (§8's forbidden 角色「Templates」).
  MINOR (fixing): ConfigTabNav grid md:grid-cols-4 → 3 (only 3 tabs post-carve). Delete orphan i18n "Presets and flags":"预设和开关".
  DEFER (fast-follow): ImageProductionView empty-vs-loading + swallowed fetch error; ConfigOverviewHeader "Prompt Recipes" metric fed by data.templates (cross-domain, harmless); pre-existing orphan zh "Prompt Templates".
Fix wave: commit b41039be (§8 copy: eyebrow→Model Profiles, h2→Character Starters, +2 lower-vis refs, grid-cols-4→3, delete orphan "Presets and flags"; gates green, grep clean). Fixer discovered admin-web.e2e.ts asserted OLD headings → commit f72ee82c (synced 14 heading assertions to 6 renamed labels; typecheck clean, stale-heading grep empty).
Consolidated §8 verification (controller): no t("Profiles & Rollout"/"Production Studio"/"Asset Library") render calls; "Profiles & Rollout" gone from admin+e2e; role h2=Character Starters, config eyebrow=Model Profiles; typecheck green. §8 MET. Full opus re-review NOT re-dispatched — fixes were grep-verifiable copy/test-string edits directly resolving named findings.
BRANCH READY (7 commits since master: 2 docs + 5 impl + 2 fix... = 3164fbb1,ff0fd484 docs / 94f329e7,0009de56,229dcd1e,7c601563,7a359f14 impl / b41039be,f72ee82c fix). → finishing-a-development-branch.
ADMIN IA REDESIGN: MERGED to master (2aaf4d54, FF), branch deleted, green. Zero user action (presentation-layer).

=== RECIPE RENAME (§9-②) SDD START ===
Base (before Task 1): 96d6b292f91eccf943554be02464e9ca946a264e
Branch: recipe-rename-unification
Plan: docs/superpowers/plans/2026-07-08-recipe-rename-unification.md
Scope: GenerationPromptTemplate → recipe end-to-end (schema+code+UI+API route). Decisions: (a) rename API route too; (b) keep key VALUES; (c) USER OVERRIDE — agent runs dev migration SQL + pm2 cutover (prod SQL = file for user).
Task 1 = code rename (validated vs fresh test DB, no dev-DB touch). Task 2 = orchestrator dev cutover (build→SQL→pm2 restart). Dev DB idream@5433 has 4 recipes + 43 job refs; index names verified. pm2 full stack live (14h uptime).
Task 1: complete (commit dceeb7e0 + minor fix fdd44047, opus review ✅ Approved; typecheck+lint clean, vitest 106/106 required + 408/408 full, residual greps empty; API adaptation = dispatcher-key rename (no filesystem routes) verified end-to-end; public promptTemplates→recipes response key proven inert; dialog titles fixed). SQL file db/sql/2026-07-08-recipe-rename.sql created, NOT executed.
Task 2 (dev cutover): COMPLETE. Force-built main+admin (fresh recipe client) → ran SQL on dev public → pm2 restart main-web/admin-web/gen-finalizer/main-event-consumer (gen-image/chat untouched: zero refs / separate DB). BUG CAUGHT BY RUNNING IT: SQL index names were unquoted → Postgres lowercased → "does not exist" → whole txn ROLLED BACK (0 data loss). Fixed = double-quote camelCase index names (commit e7b3fc65), reran clean. Verified: generation_recipes+recipeKey+aligned indexes, 4 recipes/43 job refs preserved; all 7 pm2 online stable (no crash-loop); main-web/admin-web HTTP 200; probe:product-config read recipe data ok; zero post-cutover column errors (finalizer's 1 was pre-restart race; admin-web's 3 "does not exist" = Next _not-found manifest quirk, benign). PROD SQL = db/sql/2026-07-08-recipe-rename.sql (quoted) for user to run at deploy.
RECIPE RENAME COMPLETE (branch recipe-rename-unification): commits 9c6606a1,b117af80 spec / 96d6b292 plan / dceeb7e0 code / fdd44047 dialog-titles / e7b3fc65 sql-fix. → finishing-a-development-branch.

=== ADMIN GUIDED-NAV SDD START ===
Branch: admin-console-guided-nav
Plan: docs/superpowers/plans/2026-07-09-admin-guided-nav.md
Scope: presentation-only (0 DB/API). Cut cognitive load: 34-item flat nav → 7 daily pinned + 7 collapsible folded groups (localStorage) + guided Dashboard (attention + task cards). 审核=2 pins not merged (ModerationView openAction coupling). 4 tasks.
Base (before Task 1): ace99d83
Task 1: complete (commit b3b0390e, review clean ✅ sonnet; tier added, all 34 ids preserved once verified, routing untouched, 15/15). Minor: icon-distinctness test narrowed to 3 groups (no collision). NOTE Task 2: fix i18n-nav.test.ts (filters retired group names Characters/Generation).
Task 2: complete (commit d4a00b38 + fix 5d98413a, review found 1 Important ✅ fixed; progressive-disclosure sidebar 7 daily + 7 collapsible groups + localStorage, NavLink extracted, i18n groups + Support Requests zh, i18n-nav.test SSoT-driven; live Playwright smoke). Bug: force-open group header was silent no-op mutating persisted state → made inert when active. Minor deferred: orphan "Characters" zh key; group-header aria-controls.
Task 3: complete (commit 1c216b67 + i18n fix 58ef218e, review found 1 Important ✅ fixed; guided Dashboard = attention 4 tiles (2 live-fetched) + 3 task cards + health metrics; client-fetch safety verified; zero DB/API; live smoke). Fix: 11 Chinese-keyed i18n → English keys + zh values ("Pending submissions" collision reused).
Task 4: verification green (lint+typecheck+vitest 20/20, zero DB/API drift, spec closed).
Final whole-branch review (opus): Needs fixes → 1 Important SSR hydration bug (openGroups read localStorage in useState initializer → server-empty vs client-nonempty mismatch on returning user). Fixed commit 0d23fded (defer to useEffect) + 600cd4bd (wrap in rAF to satisfy lint no-sync-setState-in-effect, mirroring existing `locale` pattern). Reviewer corrections: "Characters" zh key NOT orphan (used by DataTable title=Characters, KEEP); aria-controls + icon-dup(Insights BarChart3 pre-existing) deferred.
GUIDED-NAV COMPLETE (branch admin-console-guided-nav): commits d8843025,ace99d83 docs / b3b0390e,d4a00b38,1c216b67 tasks / 5d98413a,58ef218e,0d23fded,600cd4bd fixes / b8894221 spec-close. → finishing-a-development-branch.

=== ADMIN 生成-GROUP REDESIGN SDD START ===
Branch: admin-generation-group-redesign
Plan: docs/superpowers/plans/2026-07-09-admin-generation-group-redesign.md
Scope: presentation-only (0 DB/API). 「生成」组三层重构（Operations/GenerationOps/Engineering）+ 4 原语(FailureReason/EngineeringDetails/OperatorFlow/ReadonlyOpsView) + failureReasons.ts 前端字典. 13 tasks/5 phases.
Constraints: 纯前端 only packages/main/src/components/admin/**; vitest globalSetup needs PG(5433, OPEN); NO DOM test harness (approved) → presentational tasks verified by manual zh smoke (admin dev 3001, UP) + tsc; Task 7–11 same file AdminConsoleClient.tsx (serial).
Base (before Task 1): 16009c90866d99a7a74a1910335ea8fc582efa9d
Task 1: complete (commits d1d9a7ae..20eac90a, review 1 Important fixed [prototype-chain lookup → Object.hasOwn guard + regression test], Minor byte-identical entries deferred within DRY tolerance). 5/5 tests pristine.
Task 2: complete (commit bbaa67a0, review Approved, 0 Critical/Important). Minor(defer to final): inert 'group' class + no chevron affordance — both brief-inherited cosmetics. tsc clean.
Task 3: complete (commit f7a8b3df, review Approved, 0 Critical/Important). Minor(defer): SEVERITY_CLASS Record<string,string> could tighten to Record<FailureSeverity,string> (brief-inherited, zero risk). tsc clean.
Task 4: complete (commit e9fd3012, review Approved, 0 Critical/Important). Minor(defer): selected button lacks aria-selected/aria-current; badge no truncate. tsc clean; layout-fix invariants (min-w-0 + responsive grid) verified present.
Task 5: complete (commit 3cf41137 + fix 12d2bf70, review 1 Important fixed [overflow-x reliably scrolls: th nowrap + data-td nowrap, rich render cells still wrap], Minor row-key=index/colSpan deferred). tsc clean.
=== P1 COMPLETE (5 primitives: failureReasons.ts/EngineeringDetails/FailureReason/OperatorFlow/ReadonlyOpsView), commits d1d9a7ae..12d2bf70 ===
Task 6: complete (commit c605db32, review Approved, 0 Critical/Important). nav 3-tier: Operations/GenerationOps/Engineering, 20/20 green RED-first, id/href/icon/tier invariant held, +fixed latent icon-distinctness test vacuousness. Minor(defer): stale it() title '7 folded groups'→8.
=== P2 COMPLETE (nav 3-tier) ===
Task 7: complete (commits bb0d3cff refactor + b52311ce test-image re-add, opus review Approved, 0 Critical/Important). ConfigView→OperatorFlow+FailureReason+EngineeringDetails; all 5 preserved behaviors intact (dry-run/publish/rollback/disable via openAction, publish gated on blockedReason, selection, action-set, test-image reuses original /test-job apiWrite); operator-surface rule structurally enforced; net simplification. Product decision: test-image RE-ADDED (user chose 保功能). Deviation: code={profileBlockCode(verification)} not blockedReason (necessary — blockedReason is a sentence, misses dict). tsc clean. LIVE zh smoke DEFERRED (dev-login reset + Next-dev idle timeout blocked browser this session; verified structurally via code review + JS DOM probe). Minor(defer to final): (1) profileDisplayName fallback →profile.id could surface id if no label/profileKey (pre-existing, seeded profiles have labels; fix=fallback to t('Untitled profile')); (2) ProfileDetail large multi-concern; (3) test toast shows job shortId (pre-existing, not prohibited set).
Task 8: complete (commit b5f74616, sonnet review Approved, 0 Critical/Important). PromptRecipesView→OperatorFlow (local lazy useState selection, avoids set-state-in-effect lint), RecipeDraftForm/recipeTableActions/publish/rollback untouched via openAction, raw id/recipeKey/mode folded into EngineeringDetails, primary falls back to t('Untitled recipe'). tsc+eslint clean. Minor(defer): subtitle expr duplicated list vs detail; selection seeded once; 'v-' for version 0 (all inherited/non-regression).
Task 9: complete (commit 98f05b8d, sonnet review Approved, 0 Critical/Important). GenerationPresetsView→OperatorFlow read-only (no actions added), raw id/type folded, primary→t('Untitled preset'), local lazy-init selection, extracted shared presetSecondaryLine helper (improves on recipe precedent). tsc+eslint clean + implementer live zh smoke via pm2 admin-web rebuild. Minor(defer): badge tone computed pre-fallback (inherited, unreachable in seed). Note: pm2 admin-web now on branch build (verification side effect). Note: category empty for seeded presets → rows show visibility·state only.
=== P3 COMPLETE (config/recipes/presets → OperatorFlow) ===
Task 10: complete (commit 4dc28d6d, sonnet review Approved, 0 Critical/Important). JobsView→ReadonlyOpsView (User/Created/Status/Failure/Actions); Requeue (openAction /jobs/:id/requeue verbatim) + Details (local GenerationJobInspector) both preserved; FailureReason code={errorCode} for failed rows; raw jobId/errorCode not bare; ReadonlyOpsView SPEC relaxed comment-only to 'read-mostly'. Product decision: ops zone keeps light triage actions (user chose 能). tsc+eslint clean. Minor(defer): columns not useMemo'd (inconsistent w/ *Items, no correctness impact).
Task 11: complete (commit fd0d4a04, sonnet review Approved, 0 Critical/Important). DeadLetterView→ReadonlyOpsView+FailureReason; Requeue/Discard/BULK all preserved endpoint-for-endpoint (per-row /jobs/:id/requeue|discard + bulk /dead-letter/requeue|discard), selection state stays in wrapper, select-all relocated to bulk bar (no thead render slot). FailureReason code={errorCode}, raw id/errorCode folded. Kept ledgerState/cost/mode bare (triage signal, not raw id/payload/error). tsc+eslint clean. Minor(defer): aria-label fallback weakened; lost colored status badge (compensated by failure column, mirrors T10). OPEN for final review: column-parity between jobs(T10) and dead-letter(T11).
Task 12: complete (commit a1d966de, sonnet review Approved, 0 Critical/Important). BackendsView.tsx→ReadonlyOpsView+FailureReason; unhealthy→code='backend_unreachable' detail=health.detail (corrected brief's literal); endpoint/cliPath folded in EngineeringDetails(gated hasConfig); Refresh+apiGet+states preserved read-only; dead code BackendCard/KindBadge removed; +4th Failure-reason column (matches T10/T11). ProviderOpsView untouched (different aggregate shape; future follow-up). tsc+eslint clean. Minor: 4-col vs 3 (consistency, non-defect).
=== P4 COMPLETE (jobs/dead-letter/backends → ReadonlyOpsView; ops zone keeps requeue/discard/bulk per user Option A) ===
Task 13: complete (commit 0531d6ef backfill + d95cc6e6 fix; sonnet review found 2 Important, #1 fixed). i18n 67 zh + 11 zhValues, bun run check GREEN 12/12. Fix #1: enum cells (jobs status; dead-letter mode/status/ledgerState) render via value(); verified all 11 enum values have zhValues. #3 校验→验证, #5 aria-labels wrapped. DEFERRED #2: verificationMeta 4th branch folded-English (needs cross-caller sig change; only in collapsed EngineeringDetails).
=== ALL 13 TASKS COMPLETE. Branch admin-generation-group-redesign, 17 commits since 16009c90. bun run check GREEN. Pending: final whole-branch review + live zh smoke + finishing-a-development-branch. ===
FINAL whole-branch review (opus): READY TO MERGE. All 6 cross-cutting checks PASS (pure-front-end confirmed via name-only grep = 0 server/prisma/api; operator-surface holds globally; all mutations preserved verbatim; nav+i18n coherent 10 nav tests pass; primitives sound; tsc+3 admin test files 25 green). All deferred Minor triaged DEFER, 0 must-fix. Fast-follows (non-blocking): (1) failureReasons.ts add 'missing'/verification-pending entries so draft-needs-dryrun reads better than 'Unknown error' [top]; (2) presetSecondaryLine category raw (empty in seed); (3) BackendsView.kind comfyui/sdcpp proper nouns raw. LIVE zh smoke NOT completed via automation (dev-login session reset + Next-dev document_idle timeout blocked Chrome; T9 impl did partial via pm2 rebuild) — recommend user eyeball 6 pages. Branch 17 commits 16009c90..d95cc6e6, bun run check GREEN.

=== ADMIN OPERATOR UX REDESIGN SDD START ===
Branch: admin-operator-ux-redesign
Plan: docs/superpowers/plans/2026-07-10-admin-operator-ux-redesign.md
Scope: presentation-only (0 DB/API). Light editorial reskin (tokens+9 primitives) + list/detail/new trios for 7 content pages. 19 tasks / 4 phases.
Base (before Task 1): 1f9506616eb696b578796c4d029fa6cd6fd087d2
Task 1: complete (commit 206f99b6, review clean ✅ sonnet; byte-exact tokens)
Task 2: complete (commits bfd64859 + fix b3608749, review 1 Important fixed [StatusPill t()→value() enum channel], controller grep-verified ✅)
Task 3: complete (commits c206646e + fix 0d1621ba, review clean after tokenize fix ✅, controller grep-verified)
Task 4: complete (commits 3180bfe9 + fix e2c32832 [whole-row click], review clean ✅, controller grep-verified)
Task 5: complete (commits 40d34049 + fix b6a5eb76 [zh "Request failed"], review clean after fix ✅, controller grep-verified)
- Task 5 minor (defer to final review/T19 visual QA): ConfirmDialog scrim bg-black/20 may read under-dimmed vs old bg-black/70 modal convention.
Task 6: complete (commit 88b30f1a, review clean ✅ sonnet; parseAdminPath TDD 20/20, zero behavior change verified)
Task 7: complete (commits d0488b1b + fix d57d1c9a [access-denied branch], review clean after fix ✅; NavLink active soft-state judgment call approved by reviewer)
Task 8: complete (commits ddd42e78 + fix 41d31772 [divider radius], review Approved ✅; className-only verified 766/766 symmetric, hard-gate grep 0, self-caught ink-on-ink fix real, bun run check 12/12 green)
=== P1 COMPLETE (tokens/9 primitives/parseAdminPath/shell+full sweep), commits 206f99b6..41d31772 ===
Task 9: complete (commit 5fa621fd, review clean ✅; payload parity with legacy view field-verified)
Task 10: complete (commits 0ba93818 + fix 8055cbf5 [deferral effect + enum value() channel], review clean after fix ✅, controller grep-verified)
Task 11: complete (commits 563b179e + fix b616850a [unwrap VisualPassportPanel + summary label], review clean after fix ✅)
- Task 11 minors (defer to final review): detail page full reload flicker under ConfirmDialog; EngineeringDetails summary==hint label duplication.
Task 12: complete (commits 6c191798 + fix 25d37bce [zh Age/Description + comment tidy], review clean after fix ✅; vitest 39/39, bun run check 12/12 green)
=== P2 COMPLETE (official trio exemplar). Controller Chrome smoke PASS: list card-grid zh, detail deep-link /official/<slug> with sections+actions, /new grouped form, unknown-path->dashboard. Known leaks for T18: "Visibility" label no zh (new find); "Age"/"Description" fixed in code but running build predates fix; VisualPassportPanel ported English body copy (pre-existing debt, scope decision for T18); minor: pill text wraps on long-name cards. ===
Task 13: complete (commits da1a8fbc + fix 40c7c588 [Critical: 3 files left unstaged by aborted git add — folded in; pill label Published/未上线], review clean after fix ✅; vitest 43/43)
- Task 13 note: git add pathspec aborts on already-rm-ed files — stage explicitly. Pill pair 已发布/未上线 register acceptable (defer polish to final review).
Task 14: complete (commits 8a7e0f85 + d72b4e15 [TDD tests] + fix 3c84a518 [save direct PATCH, dead recipes fetch removed], review Approved ✅; vitest 48/48; RULE ESTABLISHED: no-reason backends never collect operator reason — nondestructive writes go direct, destructive keep name-confirm via ConfirmDialog requireReason:false)
Task 15: complete (commit 46d79bfa, review Approved ✅; ConfirmDialog requireReason additive verified vs 3 callers, presetPayload schema-verified; vitest 52/52)
- Task 15 minors (defer to final): no unit test for requireReason:false branch; "Edit profile"(编辑资料) label reused on preset entity.
Task 16: complete (commit c3f62149, review Approved ✅; 3 adjudications verified — curation reshape OK, brief upload/import claim was wrong, all-writes ConfirmDialog correct per assetPatchSchema; vitest 60/60)
- Task 16 minor (defer to final): AssetsListPage lost eager={index<4} thumbnail hint (LCP nit, one-liner).
Task 17: complete (commit 0faa3e3e, review Approved clean ✅; payload parity + dead-helper audit + both adjudications verified; vitest 66/66, repo check 12/12)
=== P3 COMPLETE (starters/recipes/presets/assets/placements trios + tags polish; AdminConsoleClient slimmed of recipes/presets/official/templates/assets/placements views) ===
Task 18: complete (commits c8ec66e8 + 321faebf [UI_KEYS lock], review Approved ✅; 26 zh keys fixed, 0 zhValues gaps, 185/185 in-scope t() keys covered, ~33 legacy-page keys deferred w/ inventory in report; vitest 68/68)
T19 controller smoke PASS (final build via pm2): official trio zh incl. VisualPassportPanel backfill live; starters/recipes/presets/assets/placements/tags/users all light+zh, deep links OK, unknown->dashboard OK. Gotcha: get_page_text races locale hydration (use screenshots); one Chrome tab wedged on document_idle (stale tab, fresh tab fine).
Task 19: complete. FINAL whole-branch review (fable): READY TO MERGE — all 8 cross-cutting checks PASS (presentation-only invariant holds [1 comment-only server file]; zero dangling refs; write-contract parity spot-verified; primitive coherence; routing/i18n discipline; all deferred Minors triaged DEFER). Fast-follows (8): assist body {gender,style} restore; detail deep-link ?limit= cap; requireReason:false unit test; assets eager hint; copy polish batch (presets Edit profile label, starters pill register, EngineeringDetails summary dedupe); scrim/flicker visual QA; TagChip on 3rd use + useDeferredLoad if touched again; ~33 legacy-page i18n keys with future page redesigns.
