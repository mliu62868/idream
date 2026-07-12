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
| Domain features replace the catch-all client | Today, Character, Creative, Incident, Case, Customer, Jobs, Audit, Pricing and now Billing are independent workspaces; `AdminConsoleClient.tsx` is reduced from 7,227 to 7,059 lines | In progress; more compatibility workspaces remain extractable now |
| Main domain implementation leaves the dispatcher | Existing domain modules plus the new `admin/users/service.ts`; `service.ts` is reduced from 5,068 to 4,727 lines and imports domain handlers | In progress; generation/config/support/moderation/content/promo/approval/chat blocks remain extractable now |
| V1 writes do not create a second authority | Character and other migrated adapters delegate canonical executors; Billing and User writes now live in dedicated main domain modules and remain server-authorized/transactional | Achieved for the extracted domains; audit remaining V1 blocks domain-by-domain before sunset |
| Admin read/write proxy canary | Executable canary and independent read/write kill switches exist | Production evidence missing; external runtime action |
| V1 usage reaches zero for two business cycles | Bounded telemetry and release-gate schema exist | Production evidence missing; external observation |
| Constraints/invariants are zero and stable for seven days | Executable reconciliation and signed release gate exist; shared test DB correctly blocks with non-zero legacy violations | Production backfill/reconciliation/observation missing; external data/runtime action |
| Production-like migration rehearsal and rollback | Fresh/repeat/previous-app/forward-fix rehearsal is automated and locally green | Local proof achieved; production snapshot/canary remains external |

## Implemented in this slice

### Billing client boundary

- Added `features/billing/BillingWorkspace.tsx` and a pure query module.
- Moved Billing fetch, reconciliation display, ledger adjustment state and UI out of `AdminConsoleClient.tsx`.
- Search/filter and the two independent cursors are authority-backed and URL-restorable.
- A latest-request gate prevents an older request from overwriting newer filter state.
- Ledger adjustment is absent without `billing.ledger.adjust`; an allowed adjustment carries a reason, typed target confirmation and a fresh `Idempotency-Key` to the existing main authority.
- Filtered-empty and true-empty states remain distinct.

### User/access server boundary

- Added `admin/users/service.ts` for list/detail, status, role and permission override operations.
- The V1 dispatcher is now routing-only for the domain. It does not own the schemas or mutation implementations.
- Status, role and permission mutations retain a single database transaction for domain state, Audit and Outbox.
- Shared redacted DTO presenters moved to `admin/shared/presenters.ts`, so the user domain does not import the dispatcher monolith.
- Architecture tests prevent either the v2 tree or extracted legacy domain modules from importing `admin/service.ts`.

## Code-owned work still available now

The following work does **not** need production telemetry and should continue as ordinary strangler extraction:

1. Extract Config/model management and Dead Letter from `AdminConsoleClient.tsx`; move their request/query state into feature roots.
2. Extract Access, Moderation, Support, Promo, Approvals and Chat compatibility workspaces, preserving server search/cursor and permission behavior.
3. Split the main catch-all implementation into generation/config, moderation, support, content, promo/approval and chat modules; keep `dispatchAdmin` as a temporary route table only.
4. Add canonical V2 contracts/routes for compatibility operations that lack an equivalent endpoint, then point the independent Admin features at those endpoints.
5. Repeat source-boundary tests for every extracted domain and prohibit new V1 client calls outside an explicit compatibility allowlist.
6. Move User status/role/permission writes from compatibility request schemas onto the canonical idempotent command receipt/version contract; this extraction preserves their existing atomic Audit/Outbox semantics but does not claim the full §16.4 V2 command contract.
7. Replace the bounded Team Access `limit=100` read with authority-backed search and stable cursor before claiming §24.3's “all Admin lists” requirement.

At this audited commit, `packages/admin/src` still contains 151 textual `/api/v1/admin` references across 39 TypeScript files. That count includes tests, API helpers and the BFF route, so it is an inventory signal rather than a traffic metric.

## Items that are external-only before deletion

These items cannot be manufactured by further repository edits:

1. Run production read canary and then write canary with the independent kill switches proven.
2. Complete production backfill/shadow reconciliation until unknown mismatch and every §19.4 invariant are zero.
3. Observe the signed production evidence window for at least seven days within error budget.
4. Record two distinct, ordered business-cycle intervals with zero V1 traffic.
5. Obtain the required DRI sign-offs over the independently signed evidence manifest.

Only after those observations pass may the BFF V1 route, main compatibility dispatcher and read-only adapters be deleted. The repository must not infer “unused” from tests, static search or local traffic.

## Verification

- Admin full suite: 39 files, 137 tests passed.
- Main Admin compatibility plus architecture: 2 files, 64 tests passed.
- Main server-list/architecture focused suite: 3 files, 26 tests passed.
- Admin and Main typecheck passed.
- Admin and Main lint passed with no errors after cleanup.
- Focused double-service compatibility E2E for Team Access + Billing passed 1/1, including exact `userId:delta` confirmation, persisted ledger/Audit evidence, success status and form reset.

The local Next.js 16 guides used for this slice were `use-client.md`, `server-and-client-components.md`, `route-handlers.md` and the `route.ts` file-convention guide. The extracted Billing workspace is intentionally a narrow Client Component boundary; no legacy GET caching assumptions were introduced.
