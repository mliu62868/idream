# CharacterGrid Specification

## Overview
- **Target file:** `src/components/ourdream/CharacterGrid.tsx`
- **Screenshot:** `docs/design-references/ourdream-desktop-1440.png`, `docs/design-references/ourdream-mobile-390.png`
- **Interaction model:** hover-driven cards

## DOM Structure
- Centered grid wrapper.
- Repeated `CharacterCard` items.
- Pride promo card inserted after the first row on desktop and after four cards on mobile.
- Loading-more row beneath the grid.

## Computed Styles
### Desktop Grid
- display: `grid`
- width: `1100px`
- height: `1426.56px`
- gap: `12px`
- gridTemplateColumns: `210.391px 210.406px 210.391px 210.406px 210.391px`
- rect: `x: 280`, `y: 192`

### Mobile Grid
- display: `grid`
- width: `374px`
- gap: `8px`
- gridTemplateColumns: `183px 183px`
- rect: `x: 8`, `y: 243`

## States & Behaviors
- Card hover: transform transition `0.2s cubic-bezier(0, 0, 0.2, 1)`.
- Lazy hover image layer exists in original with `opacity: 0`; clone keeps the motion as a subtle scale.

## Assets
- 16 local card images in `public/images/ourdream/card-*.webp`.
- Promo card: `public/images/ourdream/pride-card-female.webp`.

## Text Content
See `src/lib/ourdream-data.ts` for the extracted title, age, stats, creator, vivid badge, and short description values.

## Responsive Behavior
- Desktop: 5 columns, max content width `1100px`.
- Tablet: auto-fit card columns around `180px`.
- Mobile: exactly 2 columns, `8px` page padding and gap.
