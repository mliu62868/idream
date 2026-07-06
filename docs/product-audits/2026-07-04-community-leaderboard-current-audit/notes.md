# Community Leaderboard Current Audit

Date: 2026-07-04

## Scope

Adversarial PM/UX check of the current Community leaderboard and adjacent public collection copy in Chrome on `http://127.0.0.1:3221`.

## Findings

- Initial Chrome pass showed Community rendering healthy data volumes: 13 Dreamers, 16 Characters, and 3 Collections.
- The pass exposed a visible copy bug: dreamer stats rendered `1 characters` for single-character creators.
- Fix applied in `CommunityWorkspace`: count labels now use singular/plural copy for `character`, `follower`, and `item`.
- Follow-up source scan found the same hard-coded plural pattern in Feed collection cards. Fix applied in `FeedWorkspace`, and E2E expectations now assert `1 item`.
- Chrome recheck confirmed Community has no `1 characters`, `1 followers`, or `1 items` labels; single-character creators now show `1 character`.
- Chrome recheck confirmed Feed public collection cards have no bad singular labels in the current public data.
- Collections lazy image behavior was checked by scrolling to the section; all 12 visible collection preview images loaded with non-zero natural dimensions.

## Evidence

- `01-community-initial.jpg` - initial Community page capture.
- `02-community-singular-copy-fixed.png` and `.state.json` - post-fix Community full-page state.
- `03-collections-viewport-after-scroll.png` and `.state.json` - collection image loading probe.
- `04-collections-visible-media.png` and `.state.json` - visible collection media proof.
- `05-feed-collection-copy-fixed.png` and `.state.json` - Feed collection copy recheck.

## Verification

- `bun run --cwd packages/main test src/server/modules/ourdream/modules.test.ts` passed `32/32`.
- `bun run typecheck` passed `6/6` workspace tasks.
- `git diff --check` passed.
- `PW_BASE_URL=http://127.0.0.1:3221 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --cwd packages/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "feed UI supports share, report, and remix actions|profile UI handles redeem"` passed `2/2`.
