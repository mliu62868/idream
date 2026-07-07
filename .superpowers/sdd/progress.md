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
