# PromoToast Specification

## Overview
- **Target file:** `src/components/ourdream/PromoToast.tsx`
- **Screenshot:** `docs/design-references/ourdream-desktop-1440.png`
- **Interaction model:** static clone of original dismissible toast

## DOM Structure
- Fixed bottom-right card.
- Image at top with small close button.
- Promo title, copy, and Join Now button.

## Computed Styles
- Original toast appears around bottom-right at desktop.
- Card surface uses raised dark background around `rgb(46, 46, 46)`.
- Button is white pill with dark text.
- Promo image uses `PromoCardFemale.webp`.

## States & Behaviors
- Original close button dismisses the toast.
- Clone renders it static for visual fidelity.

## Assets
- `public/images/ourdream/promo-card-female.webp`

## Text Content
75% PRIDE SALE, Celebrate Pride. Limited window - don't miss out!, Join Now

## Responsive Behavior
- Desktop: fixed at bottom-right, visible.
- Mobile: hidden; mobile shows the top banner instead.
