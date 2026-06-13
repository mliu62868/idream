# CharacterCard Specification

## Overview
- **Target file:** `src/components/ourdream/CharacterCard.tsx`
- **Screenshot:** `docs/design-references/ourdream-desktop-1440.png`
- **Interaction model:** hover-driven

## DOM Structure
- Relative card container with image layer.
- Optional vivid badge in top-right.
- Bottom scrim overlay.
- Title line with age.
- Two-line description.
- Footer stats row with heart, chat count, and creator.

## Computed Styles
### Card
- width: `210.391px`
- height: `336.625px`
- borderRadius: `12px`
- overflow: `hidden`
- position: `relative`
- cursor: `pointer`
- transition: `transform 0.2s cubic-bezier(0, 0, 0.2, 1)`

### Image
- width: `210.391px`
- height: `336.625px`
- maxWidth: `100%`
- position: `absolute`
- objectFit: cover
- objectPosition: top

### Description
- fontSize: `12px`
- fontWeight: `500`
- fontFamily: `neue-haas-grotesk-text, sans-serif`
- lineHeight: `16px`
- color: `rgb(170, 170, 170)`
- width: `194.391px`
- height: `32px`
- overflow: `hidden`

## States & Behaviors
- Hover scale: `scale(1.012)` in clone to match original motion intent.
- Image scrim uses extracted gradient variable `--ds-gradient-card-scrim`.
- Vivid badge uses accent gradient `linear-gradient(0deg,#ff1cac,#fd5fc2 50%,#ff79d1)`.

## Assets
- Per-card image path from `CharacterCardData.image`.

## Text Content
Per-card extracted content is in `src/lib/ourdream-data.ts`.

## Responsive Behavior
- Card aspect ratio remains `240 / 400`.
- Width follows grid column width: about `210px` desktop, `183px` mobile.
