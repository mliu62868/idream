# Promo Copy Truthfulness Audit

Date: 2026-07-04

## Finding

The public Explore promo surfaces still used Pride-sale art/copy while `/upgrade` only exposed the current Free/Premium/Deluxe plan prices and demo checkout flow. That created a product trust gap: users could click from a sale claim into a pricing page with no matching discount.

## Fix

- Replaced active public promo surfaces with the neutral `promo-card-female.webp` asset.
- Changed visible and accessible copy to `Pride offer`, `View plans`, and upgrade-benefit copy that matches the current plan surface.
- Removed active references to `pride-card-female.webp`, `pride-banner-female.webp`, `75% Pride Sale`, and `Upgrade Now` from the Ourdream app components.
- Updated `public-routes.e2e.ts` so the public app copy guard fails if these unsupported sale promises or retired sale assets return.

## Chrome Evidence

Chrome evidence is in `chrome-evidence.json`.

- Desktop `/`: one visible `Pride offer - view plans` link, no `75%`, `Pride Sale`, `Upgrade Now`, `pride-card-female`, or `pride-banner-female` matches.
- Chrome DOM click on the promo link navigated to `/upgrade`.
- `/upgrade`: plan cards stayed aligned with current pricing/benefits, with no unsupported sale matches.
- Chrome console warnings/errors: `[]`.

Screenshots:

- `01-home-promo.png`
- `02-upgrade-after-promo-click.png`

Mobile note: the Chrome control wrapper in this session did not expose viewport resize. The regression test still covers the mobile banner DOM/attributes because the mobile and desktop promo surfaces are checked through the public route guard.
