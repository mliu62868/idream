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
