# Admin Image & Character Asset Workflow — First-Principles Remediation

Status: DONE_WITH_CONCERNS — image/asset implementation, automated test/static, isolated Main/Admin browser 9/9, production standalone, and local HTTP closure completed at checkpoint `f17a2034`; later shared Main/Shared/Chat edits require a unified current-worktree runtime rerun, and the disclosed development-database reset incident remains a closeout concern  
Date: 2026-07-17  
Scope: Generic image creation, Admin Creative Runs, Image Library, Character Asset Studio, immutable QA, Character Release, and distribution verification

## 1. User outcome

An operator is successful only when they can:

1. create a new Character with no pre-existing image;
2. establish one explicit canonical identity from reviewed bootstrap candidates;
3. generate portrait, hero, and chat assets that actually consume the sealed identity references;
4. understand why any action is blocked and what to do next;
5. compare candidates in the customer surface where each image will be used;
6. record a decision whose source generation, quality evidence, identity revision, and reference revision are durable;
7. publish an immutable Character Release without a failed verification becoming customer-visible;
8. return later and reconstruct exactly what was generated, reviewed, selected, validated, and served.

“A job succeeded” is not a user outcome. The product outcome is a verified, traceable asset in the intended customer surface.

For a generic image, success means the operator can describe the intended
business use without knowing internal target types, profile keys, or workflow
identifiers; review the result against the frozen brief; and, where a real
runtime verifier exists, complete a verified placement. For a Character image,
success means the operator works in the dedicated Character Asset Studio rather
than adapting a generic image form.

## 2. Canonical journey

### Stage 0 — Choose the correct production lane

1. The generic Creative workspace offers human-readable purposes and only
   active, enabled, rolled-out text-to-image profiles.
2. Readiness is server-projected. A missing recipe or compatible profile is
   shown as an actionable blocker instead of a disabled button with no reason.
3. The default form asks for purpose, brief, output count, and optional
   composition details. It does not require a raw target type, target id, or
   profile key.
4. Character work is routed directly to the Character Asset Studio, where
   identity and Reference Set authority are part of the workflow.
5. A newly created generic Run is targetless. Destination is chosen only after
   the operator has reviewed an actual artifact.

### Stage A — Bootstrap identity

This stage exists only while the Character has no active Visual Identity.

1. The Asset Studio visibly enters **Establish identity** mode.
2. The operator generates four portrait candidates through an explicitly text-to-image bootstrap profile.
3. The UI never claims that references were applied during bootstrap.
4. The operator reviews artifact quality, subject count, brief fit, and anchor suitability.
5. **Set as identity anchor** atomically:
   - pins the approved Creative Run item and Generation Job;
   - creates Visual Identity v1;
   - creates Reference Set revision 1 from the selected asset;
   - selects the asset as the draft Character cover;
   - records audit and outbox evidence.

The bootstrap image becomes the identity authority. It is not falsely described as having been generated from an identity that did not exist yet.

### Stage B — Produce the asset pack

This stage requires a sealed Visual Identity, an active Reference Set, and a qualified reference-capable generation route.

1. The operator chooses Portrait, Hero, or Chat.
2. The system chooses a purpose-aware default composition:
   - Portrait: `4:5`
   - Hero: `16:9`
   - Chat: `4:5`
3. The server, not the browser, verifies the route and pins:
   - generation profile key and version;
   - workflow key and version;
   - effective sampler, scheduler, steps, CFG, dimensions, and negative-prompt mode;
   - Visual Identity id, version, and immutable hash;
   - Reference Set id, revision, snapshot hash, and ordered manifest.
4. Dispatch fails closed if the selected profile/workflow cannot consume the required references. References are never silently discarded.
5. Candidates remain in review until an operator records explicit quality and identity evidence.
6. `More like this` is not inferred from a button or profile label. One
   server-owned `sourceVariationAuthority` proves the exact route supports the
   source image, the canonical identity/reference combination, and the complete
   reference count. The Admin projection, pre-write validation, and dispatcher
   consume the same result and blocker taxonomy.
7. ComfyUI binds references to descriptor-declared image slots by semantic
   role, not array position. Missing, extra, or ambiguous role assignments fail
   before upload or prompt submission; a workflow with zero image slots cannot
   receive identity or source references.

### Stage C — Decide and select

Approval and draft selection remain separate facts.

Approval requires:

- no visible text, watermark, contact sheet, split screen, or multi-panel artifact;
- one intended Character subject;
- composition matches the brief and intended surface;
- identity consistency passes for post-bootstrap production;
- a non-empty operator reason.

Bootstrap approval uses `identityConsistency=unscored` because the candidate is being chosen to define the identity. Post-bootstrap approval requires `identityConsistency=passed`.

Selection pins the exact Run, item, asset, review decision, Generation Job, Visual Identity revision, and Reference Set revision into the draft asset pack.

An approved candidate that will not be selected is not left indefinitely
non-terminal. The operator may record a superseding rejection while preserving
the immutable score, identity result, and visible-quality evidence. A candidate
already selected by the draft pack must be replaced first; an active Character
Look also blocks the terminal rejection until that Look is archived.

### Stage D — QA and Release

An immutable QA Run is valid only for the exact authority snapshot it observed:

- Character Content Version;
- Character Project version;
- Visual Identity id/version/hash;
- Reference Set id/revision/hash;
- draft asset-pack hash.

Any change to those facts makes the old QA evidence ineligible for a new Release.

A Release proposal derives provenance from each selected asset’s actual Generation Job. It must not copy the current profile or reference set onto an unrelated historical asset.

The signed Preview is an exact three-slot proof, not a decorative approximation:
Feed resolves the selected portrait, Detail resolves the selected hero, and Chat
resolves the selected chat asset. The token pins three distinct assets and
projects each slot as available, missing, or unavailable. Missing, duplicated,
drifted, or unavailable assets fail closed and block QA; no slot falls back to
the portrait.

A signed Live Preview additionally pins the current `CharacterServing.version`.
It resolves only while Serving is live, points to the same Release, and retains
the same version. Pause/resume, rollback, or any pointer/version change
permanently revokes the old token even if the earlier Release later becomes
current again.

Requesting changes withdraws the immutable candidate and returns the Project to production. The operator can revise the draft and propose a new immutable candidate; no deadlocked draft Release remains.

### Stage E — Verify then expose

Distribution publication is staged:

1. a new placement is created as `published/verifying`, but customer runtime only resolves `verificationState=passed`;
2. the previous passed placement remains customer-visible during verification;
3. successful verification atomically archives the previous placement and exposes the new one;
4. failed verification archives the candidate, restores/retains the previous placement, and returns the item to an approved state;
5. a Creative Run closes only after every generated item has a terminal review decision and every approved item has a verified placement or an explicit terminal disposition.

Only slots with a real runtime verifier are offered in the UI.

Character Release publication applies the same principle to the complete
portrait, hero, and chat pack:

1. the publish command revalidates the immutable Release snapshot inside the
   same transaction that changes `CharacterServing`;
2. every selected asset must be physically available, reviewed, bound to the
   exact Generation Job and latest successful attempt, and customer-publishable;
3. mutable asset metadata, pinned Release provenance, current Generation Job,
   and latest Generation Attempt must all agree that the provider is non-mock;
4. only after every check passes are all three assets promoted to
   `public_pack`, the Character projection updated, and the Serving pointer
   advanced;
5. any drift rolls back the whole customer-visible effect while retaining exact
   validation evidence for the affected slot and asset.

Release Monitor evaluations are policy-versioned. When the monitor policy is
tightened, completed monitors for the current live Release are automatically
requeued once and evaluated under the new policy. A live slot backed by
synthetic or mock-provider lineage becomes `customerReadable=false` and routes
to rollback review instead of being silently grandfathered.

### Stage F — Manage the asset without bypassing authority

The Image Library is an inventory surface, not a second review system.

1. The Library may update searchable tags and descriptions.
2. Approval and rejection are only recorded as immutable Creative Run
   decisions.
3. The asset detail projects its source Creative Run and every active
   Character Release or Campaign dependency.
4. Archival is blocked while the asset is current-live, scheduled, or being
   verified; the UI links the operator to the owning authority for replacement,
   withdrawal, or rollback.
5. Bulk archival sends one POST preflight for the complete selection. The
   canonical dependency resolver executes a fixed nine-query batch for up to
   100 assets, maps both current object manifests and legacy raw-array Release
   manifests, and returns blockers under each exact asset id.
6. The mutation requires sorted, unique canonical asset ids and their exact
   confirmation, takes deterministic authority locks, re-reads every asset and
   dependency after locking, and remains atomic when an asset or dependency
   changes while the request waits. Archival changes lifecycle state without
   replaying stale tags or descriptions from the page.
7. Legacy Placement pages may prepare drafts, pause, or archive historical
   placements. They cannot publish customer-visible placements or mutate a
   Creative Run-owned placement.
8. Customer Gallery private/unlisted/delete mutations consume the same canonical
   dependency resolver as Admin Content Ops. They cannot bypass a live Release,
   active Look, visual identity, Reference Set, Creative Run, Campaign,
   verification, or draft-project dependency.
9. Character Looks are projected in the Visual workbench. An operator can
   archive an active or needs-rebase Look with permission, idempotency, exact
   confirmation, and optimistic concurrency; the dependency disappears only
   after the canonical Look authority changes.
10. Featured curation uses one canonical parser for Admin and Feed, preserving
    configured order while diagnosing dirty historical entries. Saves run at
    `RepeatableRead`, require the loaded AppSetting version, and use a version
    compare-and-set; a 409 refreshes current authority without discarding the
    operator draft. Runtime eligibility is still evaluated separately with the
    public-audience predicate.
11. Character duplication creates an independently owned private MediaAsset and,
    when a blob exists, independent readable bytes. It does not copy platform
    approval or quality authority, resets safety to `unknown`, survives later
    source archival/deletion, and shares the same media locks with duplication,
    Character soft-delete, and Gallery delete operations.

## 3. Authority boundaries

| Fact | Authority |
| --- | --- |
| Bootstrap candidate | Creative Run item + Generation Job |
| Canonical identity | CharacterVisualProfile immutable snapshot |
| Identity references | ReferenceSetRevision ordered snapshot |
| Generated asset lineage | GenerationJob + GenerationAttempt + MediaAsset |
| Customer publishability | MediaAsset metadata + immutable Release provider provenance + current Job/Attempt provider |
| Human quality decision | CreativeReviewDecision with structured evidence |
| Draft release asset pack | CharacterProject draftAssetPack |
| Exact draft preview | Signed preview token + three-slot assetPack projection |
| Live preview validity | Signed token + CharacterServing state/currentReleaseId/version |
| Source-image variation readiness | Qualified route sourceVariationAuthority |
| ComfyUI reference binding | Workflow descriptor image slots + semantic reference roles |
| Character Look usage | CharacterLook active/needs_rebase state |
| Inventory dependency truth | Canonical nine-query batch resolver + post-lock re-read |
| Featured configured order | AppSetting value/version through canonical Featured parser |
| QA validity | CharacterQaRun authority snapshot |
| Release contents | CharacterRelease immutable snapshot |
| Character command in flight | ControlPlaneCommand coordinationKey + terminal status |
| Browser mutation recovery | Actor/environment/scope-bound durable intent + exact request snapshot + idempotency key |
| Active Reference Set | ReferenceSetRevision optimistic version + one-active-per-Visual-Identity database constraint |
| Customer-visible Character | CharacterServing currentReleaseId |
| Customer-visible campaign asset | passed MediaAssetPlacement runtime predicate |
| Effective featured Characters | configured ids intersected with publicCharacterAudienceWhere |
| Duplicated Character image | New private MediaAsset/blob with independent ownership and review state |

The UI is a projection of these authorities. It may not invent readiness, provenance, or success.

## 4. Fail-closed rules

- A bootstrap Run cannot claim identity references.
- A generic Run cannot use an identity/reference workflow; it must resolve an
  explicit text-to-image route.
- Replaying a successful Run create command must return the original Run before
  re-evaluating mutable profiles, routes, recipes, or pricing.
- A production Character Run cannot start without an exact qualified reference-capable route.
- A required reference set cannot be silently reduced to zero images.
- A source variation cannot be created when the exact route cannot consume the
  source image together with all canonical references, even if the UI request
  is forged or stale.
- A ComfyUI prompt cannot accept references when its descriptor has zero image
  slots, or when every reference cannot be mapped unambiguously to a
  role-compatible slot.
- A Character asset cannot be approved without structured quality evidence.
- A production Character asset cannot be selected with `identityConsistency` other than `passed`.
- A Character draft submit cannot re-parent an identity image already owned by
  another Character; ownership is re-read and claimed with a compare-and-set
  inside the creation transaction.
- A signed draft Preview cannot substitute the portrait for a missing Hero or
  Chat asset, accept duplicated slot assets, or authorize QA while any slot is
  missing, unavailable, or drifted.
- A Live Preview token cannot survive a Serving pause, rollback, Release swap,
  or version change; restoring the old pointer does not restore the old token.
- An approved Character candidate selected by the draft pack or used by an
  active Character Look cannot be terminally rejected.
- A Release cannot use stale QA evidence.
- A Release cannot claim generation provenance that differs from the selected asset’s Generation Job.
- A Release cannot expose an asset whose metadata is synthetic, whose pinned,
  Job, or Attempt provider is mock-prefixed, or whose pinned provider differs
  from the current Generation Job.
- A failed publish-time revalidation cannot partially update Serving, Character
  projection, asset visibility, release events, Outbox, or Release Monitors.
- A current live Release cannot remain exempt from a newer monitor policy merely
  because its older monitor already completed.
- A failed placement verification cannot remain customer-visible.
- A v2-owned placement without a valid immutable provider pin cannot verify or
  enter customer serving.
- A legacy Placement mutation cannot remove or rewrite a Creative Run provider
  pin, status, or metadata.
- Two tabs cannot accept two active publish, schedule, rollback, pause, resume,
  or retire commands for the same Character. The database coordination lock,
  not local browser state, is authoritative.
- A command response that is lost after server acceptance cannot unlock the
  workspace. The client persists intent before POST, replays only with the same
  idempotency key, and reloads the server-projected active command after a
  refresh or storage failure.
- A lost create, review, or draft-selection response cannot be recovered by
  constructing a new request. The exact canonical request snapshot and
  idempotency key are restored; once a committed receipt exists, Verify performs
  projection reads only and never sends a second mutation.
- A second browser tab cannot overwrite the first tab's recoverable intent for
  the same actor and scope. A Web Locks claim serializes the browser decision,
  while server idempotency and authority concurrency remain the final truth.
- A recovered intent cannot cross actor, environment, Character, Run, or
  requested-draft boundaries. Actor changes remount the affected workspace,
  and an explicit `?draft=` URL is resolved before any unrelated new-Character
  intent is considered.
- A saved command whose acceptance is still unknown cannot auto-replay forever.
  The recovery journal is schema-, actor-, and environment-bound. Automatic
  polling/replay remains bounded. After 24 hours, or when the canonical request
  snapshot can no longer be replayed safely, the receipt and idempotency key are
  retained in `reconciliation_required`; conflicting controls remain locked
  until the operator explicitly reconciles the server receipt.
- Reconciliation uses the original mutation permission and the exact same
  actor/scope/idempotency advisory lock as the writer. If the original write
  committed, the server returns typed projection evidence and the client clears
  only after the exact Run, Character, Review Decision, Reference Set, or draft
  selection is visible. If no write committed, the server creates a durable
  cancelled tombstone that prevents a late writer from mutating domain state.
  Pending or failed receipts stay locked and are never converted into a new
  request.
- A 401 or 403 while reading command evidence cannot be interpreted as a
  terminal command result.
- Image Library approve/reject requests cannot create review authority.
- An asset referenced by a draft project, visual identity, Reference Set,
  Generation Job, active Look, Creative Run, current/scheduled Release, Campaign,
  or verification cannot be archived, made private/unlisted, or deleted through
  an alternate inventory surface.
- Bulk preflight and mutation cannot accept unsorted/duplicate target ids,
  trust pre-lock rows, interpret only the latest manifest shape, retain deleted
  Character or inactive/retired Project dependencies, or overwrite newer
  metadata with stale page fields.
- Character duplication cannot reuse another Character's MediaAsset row/blob,
  inherit public or approved asset authority, or proceed after source archival
  or deletion wins the canonical media-lock race.
- Configured featured order cannot be presented as effective runtime placement;
  public eligibility is evaluated separately with the canonical audience
  predicate.
- Concurrent Featured writers cannot both update one AppSetting version; dirty
  stored ids are canonicalized with explicit diagnostics and never create
  duplicate Feed cards.
- Unsupported placement slots are not actionable.
- Publishing a new Reference Set cannot replace an active revision unless the
  request names the exact active id and revision it observed. Application
  advisory locks and the partial unique database index independently prevent
  two active revisions for one Visual Identity.
- An exact idempotency replay cannot fail because profile, price, release,
  serving, or reference preflight facts changed after the original command
  committed. The original receipt is resolved before mutable preflight; a
  changed request under the same key remains a conflict.
- Character recovery must name the expected Character and pass
  `character.project.write` for that resource before receipt lookup or
  tombstone creation. A committed receipt must also expose trusted target and
  result Character ids that match the expected Character and remain inside the
  actor's resource scope; unbound succeeded, pending, or failed receipts fail
  closed.
- Recovery completion is projection-specific: bootstrap verifies the exact
  Character, active Reference Set revision, anchor, draft image, cover, and
  active identity; draft selection verifies the exact purpose slot and asset.
  A legacy cancelled tombstone with the wrong guessed Character command type
  returns its trusted `existingCommandType` for one safe retry and never
  creates a new command, audit, or domain write.
- Legacy v1 batch-create and Character pregen-create endpoints cannot mutate
  image authority. Authenticated callers receive `410 Gone` with the canonical
  v2 replacement; legacy item approve/reject/regenerate mutations remain
  disabled with `409` and a canonical repair path, while legacy reads remain
  only where needed for historical projection.
- Optimistic concurrency and idempotency headers are part of the product contract, not optional implementation details.

## 5. Implementation slices and test gates

### Slice 1 — Browser transport and navigation

- Add missing `Idempotency-Key`, `If-Match`, and exact confirmations.
- Make Character tab URL state bidirectional, including Back and Forward.
- Poll active Runs without replacing loaded data with a full-screen loader.
- Use retry eligibility returned by the server.
- Start review forms empty and validate decision-specific evidence.

Tests:

- request contract tests for every mutation;
- same-page deep link, Back, and Forward tests;
- active Run polling test;
- approve/reject evidence validation test.

### Slice 2 — Bootstrap identity and reference-capable production

- Add bootstrap profile projection and bootstrap identity command.
- Pin Reference Set revision/manifest on production Generation Jobs.
- Enforce profile/workflow reference capability in route qualification and Run creation.
- Add purpose-aware orientation and effective runtime controls.

Tests:

- blank Character bootstrap integration test;
- bootstrap idempotency and optimistic-concurrency tests;
- production payload contains real reference images;
- unsupported reference route fails before queue dispatch;
- purpose-to-orientation table tests;
- effective workflow binding tests.

### Slice 3 — Decision and provenance integrity

- Persist structured Creative review evidence.
- Require Character quality evidence at review and selection.
- Derive Release placement provenance from actual Generation Jobs.
- Pin QA authority snapshot and reject drift.

Tests:

- bad/missing Character review evidence rejected;
- bootstrap `unscored` versus production `passed` identity rules;
- stale QA rejected after identity/reference/asset-pack mutation;
- unrelated Generation Job provenance rejected.

### Slice 4 — Release and placement compensation

- Withdraw a Release when changes are requested.
- Permit a revised proposal after draft changes and new QA.
- Stage placements behind the passed runtime predicate.
- Compensate failed verification and keep the previous placement live.
- Revalidate all three Release assets and immutable provider lineage inside the
  publication transaction.
- Promote the complete Release pack atomically and reject synthetic or
  mock-provider assets.
- Version Release Monitor policy and requeue current-live historical monitors
  after a policy upgrade.
- Coordinate all Character serving commands through one server-owned active
  command key and project that command back into the workspace.
- Do not close Runs with unresolved items.

Tests:

- request changes → revise → new QA → new proposal → approve;
- verification failure retains previous live asset;
- verification success atomically swaps assets;
- metadata drift after validation fails publication without any
  customer-visible side effect;
- provider drift after validation fails publication and records the exact
  slot/asset/reasons;
- avatar, hero, and chat mock/synthetic monitor facts are customer-unreadable;
- a completed current-live monitor is re-evaluated once under a newer policy;
- concurrent Character commands with different idempotency keys accept exactly
  one command and return the active command authority to the loser;
- accepted-but-response-lost Character publish replays with one idempotency key
  and creates one ControlPlaneCommand;
- reload with a missing browser journal rediscovers the active command from the
  Character workspace authority;
- unresolved candidates keep the Run active.

### Slice 5 — Operator workspace

- Show a clear stage rail and next action.
- Add Portfolio **Create Character** entry.
- Use a two-column layout at normal desktop widths and reserve three columns for wide screens.
- Label every status axis.
- Replace generic empty states with stage-specific guidance.
- Make preview controls non-interactive and preserve original image aspect in decisions.

Tests:

- responsive layout assertions;
- accessible names and focus behavior;
- core workflow localization coverage;
- browser journey from blank Character through verified Release.

### Slice 6 — Generic creation and inventory authority

- Add a server-owned create-options projection for friendly purposes,
  compatible profiles, readiness, and the Character Studio deep link.
- Replace raw target/profile controls with a brief-first creation form.
- Freeze and display brief, intended use, orientation, profile version,
  recipe, direction, and reference count during review.
- Permit direct `generation → placement` progression for an approved
  single-image Campaign Run.
- Remove Library approve/reject actions and expose active authority
  dependencies.
- Make Creative Run placements read-only to legacy Placement APIs and restrict
  new legacy placements to draft preparation.

Tests:

- create-options permission, qualification, rollout, and readiness tests;
- targetless generic Run creation and idempotent replay after profile drift;
- review-context contract and UI assertions;
- immutable latest-decision and provider-pin verification tests;
- Character Release / Campaign archive dependency tests;
- atomic bulk archive and archive-versus-verification concurrency tests;
- browser journey through real generic generation, scored review, Campaign
  staging, verification, and exact database authority assertions.

### Slice 7 — Cross-surface authority closure

- Use one source-variation capability result from route qualification through
  Run creation and dispatch.
- Render the exact three selected slot assets in signed Preview and block QA on
  any anomaly.
- Permit an unused approved candidate to receive an evidence-preserving
  superseding rejection, while draft selection and active Looks remain blockers.
- Project and archive active/needs-rebase Character Looks from the canonical
  Visual workbench.
- Apply the complete media dependency resolver to Admin archival and
  customer-owned visibility/delete mutations.
- Separate configured featured order from effective public runtime eligibility.
- Prevent Character draft submission from taking ownership of an image already
  assigned to another Character.

Tests:

- source-image route capability matrix, stale projection, forged-request, and
  dispatcher-defense tests;
- exact portrait/hero/chat preview contract, renderer, drift, and QA-gate tests;
- terminal superseding rejection success and active-Look conflict tests;
- Look archive idempotency, optimistic-concurrency, and dependency-removal tests;
- live Release private/delete denial with Serving unchanged;
- atomic Library bulk-archive preflight and race-conflict tests;
- configured-versus-effective featured parity with the public Feed;
- draft identity-image ownership race and rollback tests.

### Slice 8 — Final concurrency, inventory, and runtime truth closure

- Replace per-asset Library preflight with one POST and a fixed nine-query
  dependency resolver.
- Canonically parse both Release manifest shapes and filter deleted Character,
  inactive/retired Project, paused/current Serving, and retired Serving facts by
  their actual authority semantics.
- Canonicalize target ids, re-read under shared locks, and keep lifecycle
  archive writes from replaying stale metadata.
- Give a duplicated Character independent media/blob ownership, reset review
  authority, and serialize duplicate/archive/delete/soft-delete races.
- Give Featured one canonical parser, RepeatableRead snapshot, AppSetting
  version CAS, and draft-preserving 409 UI.
- Pin Serving version in Live Preview tokens and revoke old tokens permanently.
- Bind ComfyUI references by semantic role and fail before prompt submission on
  zero, missing, extra, or ambiguous slots.

Tests:

- constant nine-query resolver at 100 targets and one dispatcher preflight;
- legacy raw-array manifest, deleted/retired filters, canonical ids, lock
  re-read, stale metadata, and all-or-zero archive tests;
- duplicate independent row/blob, unknown safety, no authority laundering,
  source archive/delete races, and Character/media soft-delete tests;
- Featured dirty-history diagnostics, no duplicate Feed card, paused/resumed
  effectiveness, concurrent version conflict, and mounted draft-preservation
  tests;
- Live token pause/resume and rollback/version permanent-revocation tests;
- ComfyUI zero-slot rejection and order-independent role-binding tests.

### Slice 9 — Durable user intent and database-enforced authority

- Persist the exact canonical request body, actor, environment, scope,
  signature, idempotency key, and commit state before create/review/selection
  mutations.
- Claim one recoverable browser intent per actor and scope with Web Locks;
  adopt the existing intent in another tab instead of replacing it.
- Restore lost-response submissions with the same body and key; after a
  committed receipt, make Verify projection-read-only.
- Require Character-scoped recovery intents to persist `expectedCharacterId`,
  authorize that Character before any ledger lookup, and bind trusted receipt
  target/result Character ids back to the same resource.
- Persist typed bootstrap and draft-selection verification evidence, and
  release the browser write lock only when the current projection matches that
  evidence exactly. An asset appearing in a different purpose slot is not a
  successful recovery.
- Isolate Character Create recovery from an explicitly requested server draft,
  clear the receipt before non-authoritative URL replacement, and remount
  workspaces when the actor changes.
- Add Reference Set compare-and-set fields, application locks, stable
  serialization/uniqueness conflict mapping, deterministic historical repair,
  and a partial unique index for one active revision per Visual Identity.
- Resolve exact idempotency receipts before mutable preflight for Character and
  Creative commands, and retire legacy v1 production writes with canonical
  replacement links.

Tests:

- lost POST response → remount → exact same body/key → one server effect;
- committed receipt → Verify GET only;
- concurrent same-scope browser claims preserve the first request snapshot;
- different actor, Character, environment, and explicit draft URL isolation;
- Character Create URL replacement failure cannot resurrect a committed intent;
- resource-scoped Character recovery allows the expected Character, denies a
  different Character, rejects target/result mismatch, and fails closed for
  unbound non-cancelled receipts;
- legacy unbound cancelled Character tombstones remain recoverable after scoped
  authorization; a wrong initial command-type guess returns the trusted type,
  then resolves the same tombstone without a new mutation;
- bootstrap verification checks exact identity/reference/anchor/draft/cover
  authority, while draft selection checks the exact purpose slot and selected
  asset before unlocking;
- concurrent Reference Set writers yield one success and one stable 409;
- winner replay is marked as replay while same-key changed-body is rejected;
- fresh and upgrade migration rehearsals prove the named partial index exists
  and a second active row fails with PostgreSQL `23505`;
- publish/schedule/rollback/serving replay remains successful after mutable
  authority drift;
- retired v1 batch-create and Character pregen-create endpoints authenticate,
  return `410`, and make no write; legacy item mutations return `409` with the
  canonical repair path.

## 6. Closure criteria and classification

The remediation is complete only when all of the following pass:

- shared contract and state-machine tests;
- Admin component/request tests;
- Main integration tests against PostgreSQL;
- Gen workflow binding and reference-image tests;
- Prisma migration rehearsal and drift check;
- package typechecks, lint, and production builds;
- real local process and HTTP probes;
- Playwright journey using the actual Admin UI and production command-executor path;
- final database assertions for Generation Job provenance, QA authority, Release snapshot, Serving pointer, and verified placement compensation.
- policy-upgrade rescan proof for current-live Release Monitors;
- public Character detail proof that the exact live Release hero is rendered at
  desktop and mobile widths without horizontal overflow.
- generic image proof from friendly creation form through real pipeline output,
  immutable review evidence, verified Campaign placement, and cleanup of all
  dynamic authority receipts.

All image/asset implementation, automated test/static, scoped production build,
HTTP runtime, and browser gates were closed at checkpoint `f17a2034`. Later
shared-worktree Main/Shared/Chat edits do not invalidate the focused image/asset
evidence, but do require the unified current-worktree build, PM2, HTTP/database,
and Playwright rerun before these results may be called the repository's final
runtime state. The test-database incident remains disclosed, so the honest
classification is `DONE_WITH_CONCERNS`, not an unconditional pass.
Public-production providers, canary, backfill, capacity, and launch readiness
remain outside this local gate and are `NOT_EVALUATED`.

## 7. Verification evidence

Image/asset checkpoint package results (the later shared-worktree changes require
a unified rerun before these become current-repository totals):

- Shared: 35 files, 170 tests passed.
- Admin: 87 files, 381 tests passed.
- Gen: 14 files, 117 tests passed.
- Chat: 25 files, 190 tests passed.
- Main: 206 files and 1,418 tests passed; 2 files and 3 tests explicitly
  skipped; 208 files and 1,421 tests total.
- Repository total: 2,276 tests passed and 3 tests explicitly skipped across
  the five package suites.
- Root lint: 0 errors and 0 warnings in the applicable workspace tasks.
- Root typecheck: 6/6 workspace tasks passed.
- `git diff --check`: passed after documentation closeout.

The full Main result includes the final inventory, duplicate-media, Featured,
Live Preview, ComfyUI-adjacent, Reference Set concurrency, exact command replay,
and legacy-write retirement changes. Focused regressions also prove the fixed
nine-query batch resolver, independent duplicate bytes and review state,
RepeatableRead/version-CAS Featured writes, permanent Live-token revocation,
role-bound ComfyUI dispatch, and lost-response durable mutation recovery.
The final recovery-specific gates passed 12/12 Main integration tests, 33/33
targeted Character Asset Studio tests (including 12/12 mounted regressions),
and 2/2 shared contract tests. An independent final review reported no
remaining P0, P1, P2, or P3 finding.

An earlier isolated Next development-server probe returned 200 for Main `/` and
`/characters`; Admin
`/admin/characters`, `/admin/characters/new`, and `/admin/creative/runs`
returned 200; the Admin bootstrap proxy reached Main with 200. The new mutation
receipt reconciliation route compiled and returned the expected unauthenticated
401 both directly and through the Admin proxy, with the proxy authority header
intact. Both isolated servers were then stopped.

The scoped Main/Admin production standalone outputs were built at the image/asset
checkpoint (`BUILD_ID` 19:50:56 / 19:50:48 PDT). After the intentional rollout
restart, all eight Web, consumer, and worker entries were online; Main `/` and
`/characters`, the three Admin routes above, and the recovery-route 401 contract
passed on ports 3000/3001. Main/Shared/Chat source changed later in the shared
worktree, so this production snapshot is retained only as scoped checkpoint
evidence and is not the final current-worktree runtime claim.

The development database reports 57/57 Prisma migrations applied with no
Prisma schema drift. The exact
partial unique index
`reference_set_revisions_one_active_per_visual_profile_key` exists, there are
zero Visual Identities with multiple active Reference Sets, and fresh plus
upgrade migration rehearsals both prove that inserting a second active revision
fails on that index with PostgreSQL `23505`.

The post-checkpoint Release authority audit also closed the migration-only
qualification gap. `20260717022000_public_catalog_qualification_deferred_authority`
makes qualification validation transaction-final rather than statement-order
dependent, rejects DELETE, and adds an independent deferred live/public DELETE
recheck. `20260717023000_public_catalog_qualification_policy_route_authority`
also rejects generated qualifications unless the pinned Release carries the
exact v2 policy and a complete nested required-route authority. Fresh and
baseline-upgrade rehearsals prove valid qualification-before-projection
transactions commit, while mismatched INSERT, missing policy, top-level route
fallback, primary DELETE, independently exercised secondary DELETE, immutable
evidence mutation, and un-revocation execute their statements but fail at
COMMIT with the original row/evidence/revocation preserved. The development
database has 16 Qualifications, zero malformed generated qualifications, and
zero broken live/public qualification chains.
The same review made non-legacy Release execution and DTO projection fail
closed unless they carry the exact strict-v2 provenance plus three distinct
Portrait/Hero/Chat assets. The post-audit focused result is 7 Main files / 65
tests plus the Shared strict-manifest 7/7.

Four forward, validation-only migrations then closed the remaining database/runtime
parity gaps without backfilling or deleting existing rows. They require three exact,
distinct, publishable and hydratable Portrait/Hero/Chat assets; validate the complete
strict-v2 manifest, lineage and canonical asset ids; reject non-safe-integer
`slotVersion`; and apply the same 25-code-point ECMAScript trim semantics as the
runtime parser. Fresh and snapshot-upgrade rehearsals are 57/57 and prove malformed
asset, blob, manifest, unsafe-integer and whitespace-only lineage mutations execute
their statements but fail at COMMIT with the live authority preserved.

The isolated Main/Admin Playwright run against image/asset checkpoint
`f17a2034` passed 9/9 in 1.6 minutes. It covered blank-Character bootstrap;
three exact generated, reviewed, and selected Portrait/Hero/Chat assets; the
real draft-preview renderer; immutable QA; strict-v2 Release and public
Serving; monitoring and rollback; targetless generic image creation; durable
actor-scoped recovery; responsive 375px/834px layouts; keyboard and axe WCAG
2.2 AA gates; horizontal overflow; and console/LCP failure assertions. The
legacy avatar-only fixture was proven to fail closed and never entered a
publish write path. Lifecycle and mobile/tablet publish flows used cloned
strict-v2 three-asset Releases, not the legacy fixture. Because Main/Shared/Chat
changed afterward, the unified current-worktree Playwright rerun remains the
repository-level final gate.

Playwright and Vitest database setup now fail closed unless the resolved
database name is explicitly test-scoped. Playwright is configured to start
fresh Main and Admin servers instead of reusing an ambient process.

## 8. Remaining environment concerns

### Public-production boundary

The completed 9/9 browser pass is isolated local Main/Admin proof for the
image/asset checkpoint. A unified rerun is required for the later shared
worktree, and external production providers, production data backfill, capacity,
canary/error-budget observation, and public-launch readiness remain
`NOT_EVALUATED`.

### Test database incident

During test-harness hardening, an early version of the Vitest global setup
incorrectly allowed the local development `DATABASE_URL` and reset the `idream`
development database. The current schema and seed data were restored, and the
harness now refuses any database whose name is not explicitly test-scoped.
Unbacked local development records that existed before the reset may be
unrecoverable. This remains an explicit closeout concern and is not hidden by
the green automated results.
