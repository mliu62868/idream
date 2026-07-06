# Comparison Route Content Audit

Date: 2026-07-04

Scope:
- `/comparison/character-ai-alternative`
- `packages/main/src/components/ourdream/OurdreamRoutePage.tsx`
- `packages/main/src/e2e/public-routes.e2e.ts`

Finding:
- Comparison pages existed and routed correctly, but the body was a repeated card list with generic feature bullets.
- PRD SE-03 expects comparison pages to explain platform differences, feature advantages, pricing/entitlement differences, and conversion CTAs.

Change:
- Replaced the generic comparison card block with a decision checklist covering roleplay, creator tools, image generation tools, and account/pricing.
- Added a price and entitlement snapshot for Free, Premium monthly, and Deluxe monthly.
- Added explicit CTAs to signup, Premium/Deluxe plan URLs, Upgrade, Create, Generate, and the comparison hub.
- Added focused E2E coverage for `/comparison/character-ai-alternative`.

Verification:
- `bun run --cwd packages/main lint -- src/components/ourdream/OurdreamRoutePage.tsx src/e2e/public-routes.e2e.ts`
- `bun run --cwd packages/main typecheck`
- `PW_BASE_URL=http://127.0.0.1:3226 PW_WEBSERVER=1 bun run --cwd packages/main test:e2e src/e2e/public-routes.e2e.ts -g "comparison pages explain feature and pricing differences"`
- Playwright screenshot/evidence on `http://localhost:3227/comparison/character-ai-alternative`.

Evidence:
- `01-character-ai-comparison-content.png`
- `playwright-evidence.json`
