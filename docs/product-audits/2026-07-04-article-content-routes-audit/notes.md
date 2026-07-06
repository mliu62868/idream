# Article Content Routes Audit

Date: 2026-07-04

## Finding

The article route renderer met the sitemap and shell requirements, but every guide section reused the same generic paragraph and the table of contents linked to `FAQ` without rendering a real FAQ section. That conflicted with the product requirement that guide/article pages contain readable body content, not only template filler.

## Changes

- Added structured article content for high-intent guide routes, starting with `/guides/character-cards`, `/guides/character-card-creator`, and `/guides/sillytavern-setup-guide`.
- Replaced the hard-coded repeated article section loop with data-driven sections, bullets, and FAQ items.
- Added a title-aware fallback for remaining article routes so their sections are no longer identical repeated copy.
- Removed the stale article FAQ anchor gap by rendering a real `#faq` section.

## Evidence

- Focused Playwright pass on `http://localhost:3225/guides/character-cards` confirmed `faqLink="#faq"`, specific character-card intro/body/FAQ copy, no old repeated template paragraph, no horizontal overflow, and warnings/errors `[]`.
- Screenshot: `01-character-cards-content.png`.
- Evidence JSON: `playwright-evidence.json`.

## Tests

- `bun run --cwd packages/main lint -- src/components/ourdream/OurdreamRoutePage.tsx src/e2e/public-routes.e2e.ts`
- `bun run --cwd packages/main typecheck`
- `PW_BASE_URL=http://127.0.0.1:3224 PW_WEBSERVER=1 bun run --cwd packages/main test:e2e src/e2e/public-routes.e2e.ts -g "guide article pages expose readable content sections"` -> 1/1
