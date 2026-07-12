# Admin Phase 5 completion audit

Date: 2026-07-12

Scope: `ADMIN_CONSOLE_FIRST_PRINCIPLES_REMEDIATION_PLAN.md` §16.3, §19 M7/M8, §20 Phase 5 and §24.3.

## First-principles verdict

The boundary is defined by authority, not by URL version or file size:

- `admin` may compose interactive workspaces and forward authenticated HTTP requests, but it must not own domain truth or import main implementation.
- `main` must own authorization, invariant enforcement, transactional mutation, Audit and Outbox regardless of whether a compatibility V1 route or canonical V2 route invokes it.
- A compatibility route can be removed only after an equivalent canonical path exists and production traffic proves it is unused. Deleting it earlier would remove behavior, not remove duplicate authority.

## Evidence matrix

| Requirement | Current evidence | Verdict |
| --- | --- | --- |
| Admin independently builds without main source aliases, Prisma or BullMQ | `packages/admin/src/server/source-boundary.test.ts`; no matching imports from `rg 'dispatchAdmin|dispatchV1|../main/src|@/server/lib/db|@prisma/client|bullmq' packages/admin/src packages/admin/tsconfig.json packages/admin/package.json packages/admin/next.config.ts` | Code-owned M7 boundary achieved |
| Domain features replace the catch-all client | Today, Character, Creative, Incident, Case, Customer, Jobs, Billing, Users/Access, Config, Dead-letter, Moderation, Support, Content/Merchandising, Promo, Approvals, Chat, overviews and saved views are independent workspaces; `AdminConsoleClient.tsx` is a 983-line shell/delegator | Code-owned Phase 5 client extraction achieved |
| Main domain implementation leaves the dispatcher | Domain services own validation/query/mutation; `admin/service.ts` is a 494-line route table and compatibility re-export with no Prisma/Zod/second handler authority | Code-owned Phase 5 server extraction achieved |
| V1 writes do not create a second authority | Character and other migrated adapters delegate canonical executors; Billing and User writes now live in dedicated main domain modules. User mutations consume scoped ControlPlaneCommand receipts and commit state, Audit, Outbox and replay result atomically | Achieved for the extracted domains; audit remaining V1 blocks domain-by-domain before sunset |
| Admin read/write proxy canary | Executable canary and independent read/write kill switches exist | Production evidence missing; external runtime action |
| V1 usage reaches zero for two business cycles | Bounded telemetry and release-gate schema exist | Production evidence missing; external observation |
| Constraints/invariants are zero and stable for seven days | Executable reconciliation and signed release gate exist; shared test DB correctly blocks with non-zero legacy violations | Production backfill/reconciliation/observation missing; external data/runtime action |
| Production-like migration rehearsal and rollback | Fresh/repeat/previous-app/forward-fix rehearsal is automated and locally green | Local proof achieved; production snapshot/canary remains external |

## Implemented boundary

### Billing client boundary

- Added `features/billing/BillingWorkspace.tsx` and a pure query module.
- Moved Billing fetch, reconciliation display, ledger adjustment state and UI out of `AdminConsoleClient.tsx`.
- Search/filter and the two independent cursors are authority-backed and URL-restorable.
- A latest-request gate prevents an older request from overwriting newer filter state.
- Ledger, Subscription and Reconciliation use independent request gates, data/error/fetch timestamps and retry controls. One failed read keeps the other successes and the last good snapshot visible; Shell Refresh invokes the same workspace refresh contract.
- Ledger adjustment is absent without `billing.ledger.adjust`; an allowed adjustment accepts only a non-zero safe integer, carries a reason and exact `userId:delta` confirmation, and reuses one `Idempotency-Key` across uncertain retries.
- Filtered-empty and true-empty states remain distinct.

### User/access server boundary

- Added `admin/users/service.ts` for list/detail, status, role and permission override operations.
- The V1 dispatcher is now routing-only for the domain. It does not own the schemas or mutation implementations.
- Status, role and permission mutations require an `Idempotency-Key`, bind it to environment+actor scope and a canonical request hash, and retain a single database transaction for ControlPlaneCommand receipt, domain state, Audit, Outbox and replay result. Exact replay returns the stored result; changed payload conflicts.
- Team Access remains readable with `user.read`, while permission overrides and status actions are independently absent unless `user.role.write` / `user.status.write` are effective.
- Shared redacted DTO presenters moved to `admin/shared/presenters.ts`, so the user domain does not import the dispatcher monolith.
- Architecture tests prevent either the v2 tree or extracted legacy domain modules from importing `admin/service.ts`.

## Code-owned Phase 5 status

Phase 5's code-owned extraction is complete. The remaining V1 paths are explicit compatibility adapters, tests and the BFF boundary; they are not a second catch-all authority and may not be deleted from static-search evidence alone. At this audited commit, `packages/admin/src` contains 169 textual `/api/v1/admin` references across 67 TypeScript/TSX files. This is an inventory signal, not a production traffic metric.

The canonical v2 surface contains 84 operations, 130/130 executable contract refs and 55/55 declared mutation transports, all with pending=0. The Admin BFF validates successful responses in the real serving path; browser execution found and closed concrete Creative, Incident and Case mutation-response drift.

## Items that are external-only before deletion

These items cannot be manufactured by further repository edits:

1. Run production read canary and then write canary with the independent kill switches proven.
2. Complete production backfill/shadow reconciliation until unknown mismatch and every §19.4 invariant are zero.
3. Observe the signed production evidence window for at least seven days within error budget.
4. Record two distinct, ordered business-cycle intervals with zero V1 traffic.
5. Obtain the required DRI sign-offs over the independently signed evidence manifest.

Only after those observations pass may the BFF V1 route, main compatibility dispatcher and read-only adapters be deleted. The repository must not infer “unused” from tests, static search or local traffic.

## Verification

- Shared contract suite: 27 files / 120 tests passed; 130/130 refs and 55/55 mutation transports are executable with pending=0. Server-authored Character Project `draft_saved` and QA `evidence_attached` activity kinds are part of the read contract, and the real workspace-list integration parses the emitted activity through that shared schema.
- Admin v2 mutable finite transition authorities are closed by typed catalogs used by real services/executors and complete from-state × to-state tables for 19 state axes. State sets come directly from shared Zod contracts; unknown persisted strings fail closed. ControlPlaneCommand/Attempt and Generation Request status writers are centralized behind versioned CAS seams with source inventory proving no bypass; fact-derived Creative axes are not duplicated as mutable state. Sensitive integrations cover illegal Project retire, closed Creative review/placement, concurrent review/placement/Request terminal races, terminal verification, Attempt/Transport rewrites and evidence side effects.
- Production-like rollback-only load passed with Today p95 `532.874ms`, Support `408.721ms`, Jobs `94.012ms`, Events `238.292ms` across the documented 100k/1m datasets.
- Focused Postgres Incident/Case/contract tests and the real Creative→Incident→Case browser authority loop passed after response-gate fixes.
- Shared 27 files / 120 tests、Admin 63 files / 206 tests、Main 131 files / 831 tests passed，另 2 files / 3 tests 明确 skipped；root lint/typecheck/build passed。
- `admin-v2-workspaces.e2e.ts` passed 9/9 across desktop, 375px and 834px with keyboard, focus, axe WCAG 2.2 AA and no-overflow gates.
- Isolated transport chaos passed PostgreSQL/Redis reconnect plus consumer/dispatcher/projector restart checks. Real-process tests now SIGKILL the canonical Prisma projector inside its fact+receipt transaction and the Admin command worker after durable claim/before its domain transaction. Fresh processes prove projector apply/replay leaves one fact/receipt and targeted lease recovery completes attempt 2 with exactly-once domain, Audit and Outbox effects while unrelated work remains untouched. Production-gated hooks and bounded cleanup fail closed. Real BullMQ and network-partition release evidence remain external.

The local Next.js 16 guides used for this slice were `use-client.md`, `server-and-client-components.md`, `route-handlers.md` and the `route.ts` file-convention guide. The extracted Billing workspace is intentionally a narrow Client Component boundary; no legacy GET caching assumptions were introduced.
