# Public Catalog Post-E2E Cleanliness Audit

Date: 2026-07-04

Scope: `/explore`, `/feed`, `/community`, and `@idream/main probe:catalog` after the current full 137/137 E2E run.

## Steps

| Step | Description | Health | Evidence |
| --- | --- | --- | --- |
| 1 | Ran the catalog probe against the post-E2E local dataset. | Initially passed too narrowly: 16 public characters, 13 creators, 16 distinct images, 0 issues, but it did not inspect public collections. | `.tmp/public-catalog-probe-2026-07-04-current-post-full-e2e.json` |
| 2 | Opened `/explore`, `/feed`, and `/community` in Chrome and captured DOM/image/console metrics plus screenshots. | Failed. Feed and Community showed the manual Chrome audit public collection `Chrome handoff 1783177343553` by `Chrome Collection Auditor`. No broken visible images, no horizontal overflow, and console warnings/errors were still `[]`. | `chrome-evidence-before-cleanup.json`, `01-explore-before-cleanup.png`, `02-feed-before-cleanup.png`, `03-community-before-cleanup.png` |
| 3 | Hardened `probe-public-catalog` to inspect public media collections and owner display names, and to fail on manual browser audit markers such as `Chrome handoff`, `Chrome Collection Auditor`, and `playwright`. | Passed as a guardrail change. The new probe failed on the polluted local DB with 2 launch-blocking issues. | `catalog-probe-before-cleanup.json` |
| 4 | Removed the exact local audit fixture: user `cmr6hoskn0000oml7w6g4423h`, collection `cmr6hr0880005oml7vrdwa4d4`, and blob `chrome/profile/chrome-profile-collection-media-1783177284620.png`. | Passed. Follow-up DB counts for that user, collection, and media returned 0. | command output in this audit run |
| 5 | Re-ran `probe:catalog` after cleanup. | Passed: 16 public characters, 3 public collections, 13 public creators, 16 distinct images, 0 fail/warn issues. | `catalog-probe-after-cleanup.json` |
| 6 | Re-ran Chrome on `/explore`, `/feed`, and `/community` after cleanup. | Passed. Fixture matches `[]`, broken visible images `0`, incomplete visible images `0`, horizontal overflow `false`, console warn/error logs `0`. | `chrome-evidence-after-cleanup.json`, `04-explore-after-cleanup.png`, `05-feed-after-cleanup.png`, `06-community-after-cleanup.png` |
| 7 | Scrolled `/explore` and `/community` to trigger lazy-loaded lower content and recaptured visible image metrics. | Passed. No fixture matches, no broken/incomplete visible images, no horizontal overflow, and console warn/error logs `0`. | `chrome-scroll-evidence-after-cleanup.json`, `07-explore-scrolled-after-cleanup.png`, `08-community-scrolled-after-cleanup.png` |
| 8 | Ran final code and evidence validation. | Passed. `bun run typecheck` completed 6/6 turbo tasks, and JSON assertions passed for probe and Chrome evidence. | terminal output in this audit run |

## Changes

- `packages/main/src/server/probe-public-catalog.ts` now treats public media collections as part of catalog hygiene.
- The probe report now includes `counts.publicCollections`.
- The fixture detector now catches public manual-browser audit markers that can leak into Feed/Community.

## Product Conclusion

The current local public discovery surfaces are clean after fixture removal. The stronger catalog probe should run before every demo or launch-candidate snapshot so manual Chrome audit data cannot remain visible in Feed or Community.
