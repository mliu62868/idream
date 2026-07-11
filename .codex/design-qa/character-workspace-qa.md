# Character operations workspace — implementation QA

Date: 2026-07-10

## Verified flows

- Official character library renders as a dense table with server-backed search, filters, total count, readiness, visuals, performance, updated date, and contextual next action.
- New character flow clearly states `Private draft` and exposes Brief → Persona → Visual direction → Review steps.
- Character Starters are selectable from the new-character starting point.
- Persona, visual direction, review, and autosave states are present without creating business data during QA.
- Character detail renders artwork, release readiness, checklist, and Overview / Persona / Visual identity / Assets / Preview / Performance / History workspaces.
- Assets workspace exposes pregen packs and links to `/admin/content/production?characterId=<id>`.
- Image Production honors `characterId` over an existing session draft; Lola Moonstruck was selected in the verified run.
- Visual Identity hides raw trait JSON by default, uses labeled fields, replaces typed internal token confirmation with an explicit activation checkbox, and keeps the previous version in history.
- Existing seeded artwork is proxied from the main web origin for the isolated admin service.

## Visual evidence

![Character operations list](/Users/kk/code/idream/.codex/design-qa/character-workspace-list-release.png)

![New character project](/Users/kk/code/idream/.codex/design-qa/character-workspace-new-final.png)

![Character workspace detail](/Users/kk/code/idream/.codex/design-qa/character-workspace-detail-final.png)

## Automated checks

- Main TypeScript: passed.
- Admin TypeScript: passed.
- Focused Vitest: 95 passed across official characters, assist, templates, visual profiles, API payloads, and admin content operations.
- Main production build: passed.
- Admin production build: passed.
- Targeted ESLint: passed with no warnings.

No real character, template, visual version, production batch, publication, or review decision was created during browser QA.
