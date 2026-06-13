# HomeSeoSections Specification

## Overview
- **Target file:** `src/components/ourdream/HomeSeoSections.tsx`
- **Screenshot:** `docs/design-references/ourdream-desktop-1440.png`
- **Interaction model:** static FAQ and CTA links

## DOM Structure
- H1 beneath the character grid.
- Three metric cards.
- FAQ section with repeated bordered cards.
- Centered Join Now CTA.

## Computed Styles
- section padding desktop: `64px 60px 80px`
- heading fontSize: `36px`
- heading lineHeight: `40px`
- card background: `rgb(18, 18, 18)`
- border: `1px solid rgba(255,255,255,0.1)`
- body copy color: `rgb(170, 170, 170)`

## States & Behaviors
- FAQ cards are static.
- Join CTA links to `/upgrade` and has white pill styling.

## Assets
- N/A

## Text Content
Homepage SEO H1 and FAQ content extracted from the target page's FAQ/schema section and condensed into the clone data file.

## Responsive Behavior
- Desktop: metric cards in three columns.
- Mobile: stacked metric cards and full-width FAQ cards.
