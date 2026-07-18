// Public policy copy must describe this deployment's implemented product
// surfaces. The reference-site research JSON remains in the repository as
// research input, but is deliberately not a runtime authority.
export const localSafetyDocuments = [
  {
    path: "/contact",
    title: "Contact and support",
    description:
      "Use the local Help Desk and in-product reporting paths for support, policy questions, and product issues.",
    markdown: `
## Start with the Help Desk

Use the [Help Desk](/helpdesk) for account, billing, chat, generation, policy, or product support. A submitted request receives a local reference number for follow-up.

## Report specific content

When a character, media item, message, or profile has a Report action, use it so the report keeps the target identifier and category attached.

## Appeals

Use the appeal form in the Help Desk when you want a decision reviewed. Include the target type, target identifier, decision identifier when available, and the reason for the appeal.

## External contact details

Operator names, postal addresses, email addresses, and external community channels appear only when this deployment has explicitly configured them. Until then, the local Help Desk is the public contact authority.
`,
  },
  {
    path: "/introduction",
    title: "Safety Center",
    description:
      "A product-level index of current rules, reporting paths, account controls, and review workflows.",
    markdown: `
## What this center covers

These pages describe the product rules and the controls currently available in this deployment. They are maintained with the application rather than copied from another operator.

## Product boundaries

Ourdream is an adult AI character platform. Characters and generated responses are software outputs, not real people. Public characters and media must pass the product's publication and review states before they can appear in public discovery.

## Where to begin

Read [Acceptable use](/policies/acceptable-use), [Prohibited content](/policies/prohibited-content), and [How to report](/reporting/how-to-report). Use the [Help Desk](/helpdesk) for account-specific support or an appeal.
`,
  },
  {
    path: "/moderation/appeals",
    title: "Appeals",
    description:
      "How to ask for a new review of a character, media, account, or moderation decision.",
    markdown: `
## When to appeal

Appeal when a character or media decision appears incorrect, when an account action needs another review, or when the recorded reason does not match the submitted material.

## What to include

Open the [Help Desk](/helpdesk), choose the appeal section, and provide the target type, target identifier, original decision identifier when available, and a focused explanation.

## What happens next

The appeal is stored as its own product record with a status. Do not resubmit an unchanged item merely to bypass the original decision; use the appeal record so the review history stays connected.
`,
  },
  {
    path: "/moderation/how-it-works",
    title: "How review works",
    description:
      "How product checks, publication states, operator review, reports, and appeals fit together.",
    markdown: `
## Before publication

Character and media workflows record safety and publication state. A generated or submitted item is not public merely because a file exists; the serving path also requires the appropriate approved or published authority.

## Operator review

Items that require a decision enter the administration review workflows. Decisions, reasons, and state transitions are stored separately from public serving state so a draft cannot silently become live.

## Reports and appeals

Users can create reports against supported target types. Appeals are separate records linked to the disputed target or decision. Use [How to report](/reporting/how-to-report) for the reporting path.

## Provider configuration

This deployment may use local or configured providers for generation and verification. A provider name is not presented as a public operating fact unless it is explicitly configured.
`,
  },
  {
    path: "/moderation/why-rejected",
    title: "Why a submission may be rejected",
    description:
      "Common product-level reasons a public character or media submission cannot be published.",
    markdown: `
## Identity and age

Characters must identify as adults. Conflicting age fields, underage terms, or media that does not match the declared adult identity can block publication.

## Public readiness

A public character also needs a valid serving release, required media placements, and passing publication state. Missing or stale assets can keep an otherwise valid draft out of discovery.

## Originality and target safety

Submissions can be rejected when they claim a real-person identity, use material the submitter cannot publish, or target a prohibited scenario.

## Fix or appeal

Correct the specific field or asset named in the decision and resubmit. If the decision itself appears wrong, use [Appeals](/moderation/appeals).
`,
  },
  {
    path: "/policies/acceptable-use",
    title: "Acceptable use",
    description:
      "The current product rules for adult character creation, chat, generation, publishing, and community activity.",
    markdown: `
## Adult creative use

You may create fictional adult characters, private roleplay, and character-aware media within the controls offered by the product.

## Respect account and publication boundaries

Do not access another user's private sessions, drafts, presets, media, or billing data. Do not represent a draft, failed generation, or unreviewed asset as published content.

## Use material you can publish

Only upload or publish material you are entitled to use. Keep fictional characters distinct from real people and preserve source attribution when a workflow requires it.

## Reports and support

Use the target's Report action for content issues and the [Help Desk](/helpdesk) for account or workflow problems.
`,
  },
  {
    path: "/policies/age-verification",
    title: "Age access and verification",
    description:
      "How the adult access gate, account state, character age, and configured verification workflow interact.",
    markdown: `
## Adult access gate

The public experience requires an adult-content acceptance state. That state is tied to the current browser and, when signed in, to the current account authority.

## Character age

Character creation requires an adult age. A character with a missing, conflicting, or under-18 age cannot qualify for public serving.

## Additional verification

Some mature actions may require a separate verified account state. When a verification provider is configured, the product creates a provider session and records only the resulting workflow state needed by the application.

## Problems with verification

Use the [Help Desk](/helpdesk) and include the local verification or request identifier shown by the product.
`,
  },
  {
    path: "/policies/intellectual-property",
    title: "Intellectual property and likeness",
    description:
      "Rules for uploads, fictional character identity, attribution, and reports about ownership or likeness.",
    markdown: `
## Upload authority

Only upload or publish media and text you have permission to use. Generated output does not erase obligations attached to source images or reference material.

## Fictional identity

Public characters should be original fictional identities. Do not use the product to present a real person as a fictional companion or to imply that a real person endorsed the result.

## Attribution and provenance

When the product records an original source or creator attribution, keep that provenance separate from account ownership and relationship fields.

## Report a concern

Use [How to report](/reporting/how-to-report) or the [Help Desk](/helpdesk), and include the exact character, media, or page identifier.
`,
  },
  {
    path: "/policies/prohibited-content",
    title: "Prohibited content",
    description:
      "Content and behavior that cannot be created, published, or distributed through this product.",
    markdown: `
## Underage content

Content involving minors or underage sexual themes is prohibited. Characters must be adults and conflicting age signals block publication.

## Real-person abuse

Do not create deceptive sexual likenesses of real people, impersonate a person, or publish private material without authority.

## Exploitation and coercion

Do not use the product for sexual exploitation, trafficking, credible threats, or instructions that facilitate real-world abuse.

## Platform abuse

Do not attempt to access another user's private data, bypass billing or review state, manipulate reports, or distribute malware.

## Reporting

Use the in-product Report action when available so the exact target remains attached to the report.
`,
  },
  {
    path: "/policies/what-we-wont-do",
    title: "Product commitments",
    description:
      "Narrow, verifiable commitments about data truth, publication state, and user-visible product behavior.",
    markdown: `
## We do not replace missing user data with invented activity

An empty library, chat list, gallery, or billing state must come from a validated empty response. Dependency and contract failures are shown as errors with a retry path.

## We do not treat drafts as live content

Public serving requires its own publication authority. A generated file, CMS template, or approved candidate is not automatically a live placement.

## We keep account data scoped

Browser drafts, pending actions, private media, and server reads are scoped to the current viewer. A user switch clears or revalidates private state.

## We preserve history during repair

Invalid legacy content is retained as a draft or provenance record where possible; it is not silently presented as current truth.
`,
  },
  {
    path: "/principles",
    title: "Product principles",
    description:
      "The first-principles rules used to keep public content, private data, and operator actions truthful.",
    markdown: `
## One authority for each fact

Identity, publication, billing, generation, and search distribution each have a named source of truth. Similar-looking states are not treated as interchangeable.

## Fail closed without inventing

When an authority is unavailable, the product shows a retryable unavailable state or a last known validated public result. It does not convert the failure into a convincing empty page.

## Preserve provenance

Cold-start assets, operator edits, generated candidates, and public placements keep their source and lifecycle history.

## Make recovery explicit

Retries use stable identifiers, mutations use concurrency checks, and operator decisions leave audit evidence.
`,
  },
  {
    path: "/reporting/how-to-report",
    title: "How to report",
    description:
      "How to submit a product report with the target and context needed for review.",
    markdown: `
## Use the target action

Choose Report on the character, media item, message, feed item, or profile when that action is available. Select the closest category and add only the context needed to explain the issue.

## Keep the identifier

The report should remain linked to the exact target identifier. For a workflow problem rather than a content target, use the [Help Desk](/helpdesk).

## Follow the report state

Submission creates a stored report record. Avoid filing repeated copies for the same issue; use an appeal when disputing a completed decision.
`,
  },
  {
    path: "/your-account/privacy-summary",
    title: "Privacy and account data summary",
    description:
      "A product-level summary of account-scoped data, public content, provider requests, and account controls.",
    markdown: `
## Account-scoped data

Sessions, private chats, drafts, presets, private media, entitlements, and billing records are read through the authenticated account boundary. Public APIs use separate qualification rules.

## Public content

Only content with public visibility and the required approved or published serving state is eligible for public discovery. Source and creator provenance are kept separate from private account fields.

## Configured providers

Generation, payment, storage, or verification requests may be sent to the provider configured for this deployment. The interface does not claim a particular provider is active unless runtime configuration confirms it.

## Controls

Profile and support surfaces provide current account-management, preference, export, deletion, and diagnostic-consent workflows where implemented.
`,
  },
  {
    path: "/your-account/safety-tools",
    title: "Account and safety tools",
    description:
      "The current product controls for preferences, reporting, message actions, support, and account management.",
    markdown: `
## Discovery preferences

Use profile preferences and tag controls to shape public discovery. The server applies account-scoped preference state rather than sharing browser state across users.

## Conversation actions

Supported chat actions include editing or deleting eligible user messages, regeneration, memory review, and session deletion. Each action is checked against the current session owner.

## Reports and appeals

Use Report on supported targets and the appeal form in the [Help Desk](/helpdesk) for a disputed decision.

## Account management

Use Profile for the account controls currently exposed by this deployment.
`,
  },
  {
    path: "/your-account/wellbeing-resources",
    title: "Wellbeing resources",
    description:
      "General guidance for stepping away from an AI interaction and finding verified local support.",
    markdown: `
## AI is not professional support

Characters are generated software. They do not have judgement, professional training, or an independent relationship with you.

## Take a break

If an interaction feels distressing or compulsive, close the session, mute the relevant discovery tags, and use account controls to reduce exposure.

## Find local help

For an immediate emergency, contact your local emergency service. For mental-health, abuse, or crisis support, use an official government or recognized local directory for your country so contact details are current.

## Product-specific issues

For a problem caused by this product, submit a [Help Desk](/helpdesk) request with the relevant session or content identifier.
`,
  },
] as const;
