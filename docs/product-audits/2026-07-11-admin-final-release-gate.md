# Admin Console final release gate

Date: 2026-07-11

The repository-owned implementation and production cutover are intentionally separate. Unit, integration, Playwright, migration rehearsal, shadow, and load commands prove code behavior; they do not prove that production data has been backfilled, real traffic has survived canaries, the observation window has matured, or accountable DRIs approved the rollout.

## Machine-verifiable Go / No-Go

`bun run --cwd packages/main admin:readiness:release-gate -- <production-evidence.json>` evaluates the final §24.5 gate. The typed contract is `packages/shared/src/admin/release-gate.ts`; the authoritative manifest is schema version 3. Version 2 is superseded because a self-authored JSON document could claim `production`, arbitrary actors/evidence refs, and passing results without proving who issued the manifest.

Schema v3 uses a domain-separated Ed25519 signature over the canonical complete evidence document plus `algorithm/keyId/signedAt`. The manifest contains only the key ID, signature and signing timestamp—never a private or public key. The production gate independently loads its trusted public key and expected key ID; unsigned evidence, a wrong key, an untrusted key ID, malformed provenance, or any post-signature change fails closed before semantic Go/No-Go evaluation.

Operator flow:

```bash
# Generate/store these outside the repository, preferably through the deployment secret manager.
openssl genpkey -algorithm Ed25519 -out /secure/admin-release-private.pem
openssl pkey -in /secure/admin-release-private.pem -pubout -out /secure/admin-release-public.pem

ADMIN_RELEASE_EVIDENCE_PRIVATE_KEY_PATH=/secure/admin-release-private.pem \
ADMIN_RELEASE_EVIDENCE_KEY_ID=release-2026-q3 \
bun run --cwd packages/main admin:readiness:sign -- unsigned-v3-evidence.json > signed-v3-evidence.json

ADMIN_RELEASE_EVIDENCE_PUBLIC_KEY_PATH=/secure/admin-release-public.pem \
ADMIN_RELEASE_EVIDENCE_KEY_ID=release-2026-q3 \
bun run --cwd packages/main admin:readiness:release-gate -- signed-v3-evidence.json
```

The signer and verifier deliberately use different key files. The signer accepts only PKCS8 `PRIVATE KEY` PEM; the gate accepts only SPKI `PUBLIC KEY` PEM and explicitly rejects private-key input even though generic crypto APIs can derive a public key from it. The signed payload covers all sign-off actors, evidence references, observations, canary samples and truth counts, so editing any of them invalidates the signature. The Node-only release-gate module is exposed through the dedicated `@idream/shared/admin/release-gate` entrypoint rather than the browser-safe Admin barrel, and its public evaluator always performs cryptographic verification—there is no exported semantic-only bypass.

It fails closed unless all of the following are true:

- The manifest is production evidence generated within 24 hours.
- The observation window covers at least seven complete days.
- Every named result was observed inside that window; canary run timestamps and post-window sign-offs cannot postdate the manifest or evaluation time.
- State invariant violations, unavailable invariant checks, and unknown shadow mismatches are zero.
- Golden metrics and the NS-01/PRD decision are consistent.
- Character, Creative, Incident, Case, and Today E2E evidence includes automatic verification.
- Fresh/repeat/current-snapshot migration, old-app rollback + forward-fix, backfill dry-run, shadow comparison, and module rollback all pass.
- Permission matrix, atomic Audit/Outbox, high-risk confirmation, responsive flows, URL/server query state, and WCAG gates all pass.
- Every §22 latency, lag, freshness, invariant and unknown-failure observation is supplied as a number and re-evaluated against the shared SLO registry; a caller-provided `pass` label cannot hide a breach. Production-table load, dependency failure injection, dispatcher restart, projector lag recovery and kill-switch drill pass; direct canary-runner summaries contain real zero-failure samples inside the observation window; the 99% error budget is recomputed from positive request/failure counts; legacy v1 traffic is zero for two distinct, ordered business-cycle intervals inside the window.
- Product, Engineering, Data, Design, Operations, and Release DRIs sign `go` after the observation window ends.

Malformed, local, staging, stale, incomplete, failed, unsigned, wrongly signed, untrusted-key, or sample-free evidence returns `status=blocked` and exits with code 2. This prevents a locally fabricated manifest, the local test suite, or the production-like load harness from being presented as production Go authority.

## Cutover controls

The Admin HTTP BFF has two independent, server-runtime kill switches:

- `ADMIN_V2_READ_KILL_SWITCH=true` rejects Admin v2 GET/HEAD/OPTIONS with a typed 503.
- `ADMIN_V2_WRITE_KILL_SWITCH=true` rejects Admin v2 mutations with a typed 503 and never falls back to an old write path.

Both increment `admin_proxy_kill_switch_total{scope=read|write}`. A read kill switch is an availability rollback after source decoupling, not permission to resurrect direct DB/main-source access. A write kill switch is fail-closed and does not replay a request through v1.

## Executable read/write canary

`bun run --cwd packages/main admin:readiness:canary -- <canary-plan.json>` sends bounded requests to a non-local HTTPS production target and returns release-gate-compatible `status`, `observedAt`, `evidenceRefs`, `sampleSize`, availability, p95 and redacted per-scenario samples.

- A read plan accepts only GET/HEAD.
- Every scenario is same-origin and restricted to `/api/v2/admin`; only 2xx statuses can be declared successful, so an arbitrary endpoint or expected 5xx cannot manufacture a green canary.
- A write plan accepts only mutation methods, requires an idempotency-key prefix, produces a unique key per scenario and iteration, is capped at ten iterations per invocation, and requires `ADMIN_CANARY_WRITE_CONFIRMATION=I_UNDERSTAND_THIS_MUTATES_PRODUCTION`.
- Authentication comes only from `ADMIN_CANARY_COOKIE` or `ADMIN_CANARY_AUTHORIZATION`; neither is emitted in the report.
- Any timeout, transport failure, or unexpected status fails the run. The runner never changes authority endpoints or falls back to v1.

The plan contract is `packages/main/src/server/admin/admin-canary-runner.ts`. The runner output is accepted directly by the schema-v3 release manifest, covered by the manifest signature, and independently checked for mode, production environment, run interval, failures, availability, samples and measured p95. Production operators must choose a reviewed reversible rehearsal target for write canaries; the repository deliberately does not ship a fake production target ID or credentials.

## §21 verification matrix audit

| Required layer | Current repository evidence | Cutover interpretation |
| --- | --- | --- |
| Pure state/invariant | `characters/readiness.test.ts`, `generation-attempt-events.integration.test.ts`, `creative` contract/loop tests, Incident/Case workflow tests, `metrics/engine.test.ts` | Code behavior covered; production invariant count still must be zero |
| Property/table-driven | table-driven Release blockers, terminal transitions, Creative derived outcomes, command hash/replay/lease cases, metric day/cohort boundaries | Deterministic counterexample tables are present; no fuzz result is treated as production evidence |
| PostgreSQL integration | command reliability, Release executor, Generation terminal/manifest/settlement, Incident/Case concurrency, immutable-evidence migration, cursor stability | Runs against PostgreSQL and database constraints; dedicated cutover snapshot still required |
| Contract | Shared positive/negative Zod fixtures plus public Route Handler command seams, optimistic-version mismatch and error contracts | HTTP and contract seams covered |
| Cross-service | chat durable outbox ACK retry, main receipt/canonical transaction, payload conflict quarantine, out-of-order projector recovery, gen manifest replay without provider reinvocation | Real dependency failure/restart drill remains a production Gate |
| Metric golden dataset | QCE 4/5 boundary, exact UTC D1/D7/W1, cohort conversion, duplicate/late/untrusted/fixture exclusion, experiment maturity/guardrails | Calculation semantics covered; real coverage and two mature shadow windows remain external |
| API/AuthZ | endpoint permission/subtype tests, BFF HMAC replay/skew tests, bootstrap/nav/deep-link/DTO checks | Production revocation/session sampling remains part of canary evidence |
| Character E2E | create/resume → validate → publish → monitor → immutable rollback; concurrent two-tab publish fixture | Local browser/integration closed loop; production monitor window external |
| Creative/Incident/Case/Today E2E | Creative review/placement/verify; Incident mitigate/verify/postmortem; multi-source Case decide/verify/close; Today resolved/re-entry/deep links | Local automatic verification exists for all four domain loops |
| Component/A11y/responsive | explicit loading/true-empty/filtered-empty/partial/stale/no-permission; focus-trapped write error; Axe WCAG 2.2 AA; 375px core workspaces | Supported production-browser baseline and operator sign-off external |
| Migration rehearsal | fresh/repeat deploy, baseline-resolved current-shape upgrade, previous-app write, current forward-fix, constraint validation | Production backup/restore, reviewed backfill and module rollback record external |
| Load/Chaos | production tables and their real indexes cloned unchanged for 100k Cases + 100k Jobs + 1m Events, duplicate replay, atomic rollback; command lease recovery, durable ingest retry, dispatcher/projector recovery tests | Production dependency failure injection and sustained SLO window external |

## §21.2 counterexample audit

The required adversarial cases are represented by executable fixtures, not prose-only claims:

- Incomplete public Character and active-but-unqualified Visual Identity: Character backfill/readiness and adversarial reconciliation tests.
- Creative 0/N, partial and N/N truth: shared Creative contract plus Creative loop/reconciliation fixtures.
- Failed Attempt with legacy completion fields; exactly-one terminal under concurrent success/failure: attempt backfill and terminal-event integration tests.
- HTTP replay, approval/payload/version reuse, lease expiry/max-attempt recovery: `shared/command-reliability.test.ts` and authoritative command tests.
- Schedule policy/Identity/Reference drift and concurrent two-tab publish: route qualification, Release executor and Release lifecycle integration tests.
- Partial/full/duplicate refund without execution-state mutation: Generation cancellation/settlement and Incident action executor tests.
- Producer/provider completion ambiguity and manifest-only replay: gen pipeline and main manifest ingest tests.
- TransportExecution lineage/cost plus duplicate/out-of-order/delayed product events: Generation transport, event consumer and metric projector tests.
- Chat regenerate/edit/delete and Release attribution boundaries: typed exchange/projector/session Release migration tests; unrecoverable history remains explicit `exact_unattributed`.
- D0/D1/D2/D7/W1 maturity, old-user subscription exclusion, fixture/internal contamination: metric engine/backfill/certification and experiment analysis tests.
- Concurrent sources aggregating to one Case and concurrent failures aggregating to one Incident: Incident/Case integration tests.
- Cross-Character Serving pointer, immutable snapshot tampering, BFF signature/session boundary and clock skew: adversarial reconciliation, Release executor and Admin BFF tests.

These fixtures prove rejection/derivation logic. They do not prove the production database contains no historical violations; `admin:readiness:shadow` and the final production evidence manifest own that claim.

## Evidence ownership matrix

| Gate | Repository evidence | Production evidence still required |
| --- | --- | --- |
| Truth | invariant ledger, shadow command, golden fixtures | dedicated snapshot backfill; zero unknown mismatch; real metric coverage |
| Closure | Character/Creative/Incident/Case/Today Playwright and integration tests | production verification facts and operator acceptance |
| Migration | fresh/repeat/baseline/current-shape/forward-fix rehearsal | reviewed production snapshot, backup/restore and module rollback record |
| Permissions/Audit | permission matrix and transactional tests | production session revocation/HMAC and audit sampling |
| Experience | desktop/375px, Axe, keyboard/focus tests | supported production browser/API baseline and operator sign-off |
| Runtime | production-table-shaped 100k/100k/1m harness, SLO endpoints, executable canary runner and kill switches | actual read canary, write canary, dependency drills, ≥7-day error-budget window, two zero-legacy cycles |

The current shared test database shadow report is expected to remain blocked until its legacy/seed data is reconciled. It is evidence that the gate fails closed, not production cutover evidence.
