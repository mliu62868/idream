# Admin Phase 2 Character Release / Visual Identity Evidence

Date: 2026-07-11

Scope: `ADMIN_CONSOLE_FIRST_PRINCIPLES_REMEDIATION_PLAN.md` §8–9, §17/17.1, §19.3 Character/Release + Visual Identity, Phase 2, §21 negative fixtures and the applicable §24 gates.

## First-principles authority

- Public visibility is derived from `CharacterServing.state=live` plus a current `CharacterRelease.status=published`; legacy `Character.status/visibility/imageAssetId` is only an atomic runtime projection.
- A release command never trusts an earlier UI check. Schedule and publish each persist a fresh `ReleaseValidationRun` under the current policy and exact snapshot hash.
- Rollback never reactivates a historical row. It clones the complete immutable snapshot into a new Release, validates it, then swaps the pointer.
- Historical uncertainty is retained as evidence. Backfill does not take a live character offline, infer a qualified generation route, or guess paused versus retired.

## Pre-implementation evidence gap

| Requirement | Evidence at `560f7900` | Gap |
| --- | --- | --- |
| Resumable historical transformation | No Character/Release backfill or persistent cursor/report | Missing |
| Legacy incomplete live truth | Release required non-null Visual/Reference ids | Could not represent historical uncertainty truthfully |
| Rollback exact snapshot | `(projectId,snapshotHash)` unique | Incorrectly forbade a new rollback Release with the same content snapshot |
| Publish/schedule/rollback execution | Publish HTTP acceptance only | No domain executor, pointer swap or verification |
| V1 cutover | `setOfficialState` directly updated Character | Two independent write authorities |
| Visual evidence | Active profile and active ref row were treated as enough | No immutable/profile hash, reference snapshot hash or route matrix gate |
| Runtime | No Admin command worker | Accepted commands remained accepted indefinitely |

## Implemented evidence

- Migration `20260711040000_character_release_backfill` adds persisted backfill runs/items, Release events, command payloads, legacy readiness, exact Visual/Reference hashes and schedule/visual pair checks. It removes the invalid snapshot uniqueness rule required for correct rollback.
- `runCharacterReleaseBackfillBatch` supports dry-run, keyset cursor, bounded batch size, explicit pause/resume by run id, idempotent apply/reapply and a SHA-256 before/after/mismatch report.
- All characters receive an immutable `CharacterContentVersion`; official characters receive Project/Revision/Serving authority. Historical approved/public records remain live, receive legacy snapshots, and are explicitly `readiness=blocked` when exact Visual/Reference/Route/QA proof is unavailable.
- Existing Visual Profile references become candidates. An active `ReferenceSetRevision` is created only from media rows that exist and are not deleted. Legacy scores never create `GenerationRouteQualification`.
- `executeCharacterReleaseCommand` owns schedule, publish, rollback, pause and resume. Publish atomically swaps Serving, supersedes the old Release, updates the legacy projection, creates 24h/72h monitors, Release Event, Audit, Outbox and terminal command/attempt state.
- Schedule and publish persist fresh validation checks for content, revision, exact Visual version, active immutable ReferenceSet, current qualified route (40+ samples, Identity Match ≥90%), character QA, critical asset manifest and canonical snapshot hash.
- Schedule and rollback have public v2 Route Handlers. A dedicated worker drains accepted commands and reconciles expired leases.
- V1 `setOfficialState` no longer mutates publish state independently. It requires the effective release permission, accepts the same ControlPlaneCommand and invokes the same executor; pause/resume restore the pinned Release projection.

## Negative evidence

- Dry-run writes report evidence but creates no domain authority rows.
- Apply can stop after one row, resume from the persisted keyset cursor, and rerun without duplicate ContentVersion/Project/Revision/Release/Serving rows.
- Approved/public with missing Visual/Reference stays live and is reported `live_release_visual_incomplete`.
- No historical eval matrix is reported `live_release_route_unqualified`; it is never upgraded from legacy quality scores.
- A tampered Release snapshot fails validation and does not move the Serving pointer.
- A current policy with no matching route qualification fails closed.
- Rollback creates a new Release id with `rollbackOfReleaseId`, preserves the exact snapshot hash, and leaves the historical source superseded.

## Verification

- Focused Postgres integration: backfill + executor + V1 adapter suites.
- Shared contract positive/negative fixtures for schedule and rollback.
- Fresh migration deploy and repeat deploy.
- Existing-schema bootstrap marking baseline through authoritative commands applied, followed by Phase 2 forward deploy and repeat deploy.
- Main and shared typecheck/lint plus relevant/full tests are recorded in the implementation commit handoff.

## Remaining Phase 2 work outside this vertical slice

- Character Project autosave/conflict UI, real preview diff and Portfolio decision surface.
- Route qualification evaluation production workflow and stale invalidation dispatcher when workflow/profile/evaluator capabilities change.
- Chat Session contentVersion/release pin cutover and explicit session migration command.
- 24h/72h monitor fact collection and automatic keep/rollback recommendation belong to the Phase 3 Character operating loop.
