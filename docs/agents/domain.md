# Domain Docs

This repository uses a multi-context domain-documentation layout.

## Before exploring, read these

- `CONTEXT-MAP.md` at the repository root, when present
- The relevant context file under `packages/<context>/CONTEXT.md`
- System-wide ADRs under `docs/adr/`
- Context-specific ADRs under `packages/<context>/docs/adr/`

The expected contexts are:

- `packages/main`
- `packages/chat`
- `packages/gen`
- `packages/admin`
- `packages/shared`

If these files or directories do not exist, proceed silently. Do not flag their absence or create empty placeholders. Domain-modeling skills create them lazily when terminology or architectural decisions are resolved.

Existing product and architecture sources of truth defined by `AGENTS.md` remain authoritative.

## Expected structure

```text
/
├── CONTEXT-MAP.md
├── docs/adr/
└── packages/
    ├── main/
    │   ├── CONTEXT.md
    │   └── docs/adr/
    ├── chat/
    │   ├── CONTEXT.md
    │   └── docs/adr/
    ├── gen/
    │   ├── CONTEXT.md
    │   └── docs/adr/
    ├── admin/
    │   ├── CONTEXT.md
    │   └── docs/adr/
    └── shared/
        ├── CONTEXT.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When output names a domain concept—in an issue title, refactor proposal, hypothesis, or test—use the term defined in the relevant `CONTEXT.md`.

If the concept is missing, reconsider whether the project already uses another term or record the gap for domain modeling.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface the conflict explicitly instead of silently overriding the decision.
