# MobileBottomNav Specification

## Overview
- **Target file:** `src/components/ourdream/MobileBottomNav.tsx`
- **Screenshot:** `docs/design-references/ourdream-mobile-390.png`
- **Interaction model:** static navigation

## DOM Structure
- Fixed bottom bar.
- Four nav actions: Explore, Chat, Create, Generate.
- Icons above labels.

## Computed Styles
- Mobile-only, hidden at desktop.
- Background matches page: `rgb(13, 13, 13)`.
- Top border uses dark border token around `rgb(36, 36, 36)`.
- Labels are small, muted except active Explore.

## States & Behaviors
- Active item is Explore.
- Hover/tap states are not implemented beyond standard color transition.

## Assets
- Icons from `src/components/icons.tsx` and `lucide-react`.

## Text Content
Explore, Chat, Create, Generate

## Responsive Behavior
- Visible below `md`.
- Uses safe-area bottom padding.
