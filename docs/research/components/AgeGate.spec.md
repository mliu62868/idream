# AgeGate Specification

## Overview
- **Target file:** `src/components/ourdream/AgeGate.tsx`
- **Screenshot:** normal browser first-visit state
- **Interaction model:** click-driven in original; documented overlay

## DOM Structure
- Fixed full-screen black overlay.
- Centered card with logo, uppercase heading, terms copy, accept button, leave link.

## Computed Styles
### Card
- fontFamily: `neue-haas-grotesk-text, sans-serif`
- backgroundColor: `rgb(36, 36, 36)`
- padding: `24px`
- maxWidth: `384px`
- display: `flex`
- flexDirection: `column`
- alignItems: `center`
- borderRadius: `28px`
- border: `1px solid rgba(255, 255, 255, 0.1)`
- boxShadow: `rgba(0, 0, 0, 0.25) 2px 2px 8px 3px`

## States & Behaviors
- Original accept button writes adult-content acceptance to browser storage.
- Clone component preserves visual structure but is not mounted over the main clone by default.

## Assets
- `public/images/ourdream/age-gate-logo.png`

## Text Content
Adults Only, By entering, you agree to our Terms, I'm over 18, Leave site

## Responsive Behavior
- Full-viewport overlay on all sizes.
