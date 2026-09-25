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

We list other contact channels here only once they are staffed. Until then, the Help Desk is the way to reach us, and your requests there get a reference you can follow up on.
`,
  },
  {
    path: "/introduction",
    title: "Safety Center",
    description:
      "A product-level index of current rules, reporting paths, account controls, and review workflows.",
    markdown: `
## What this center covers

These pages describe iDream's rules and the controls you can use today. They are kept in step with the product, so they only describe what actually works.

## Product boundaries

iDream is an adult AI character platform. Characters and generated responses are software outputs, not real people. Public characters and media must pass the product's publication and review states before they can appear in public discovery.

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

Every character and image keeps track of whether it has been checked and published. Creating or generating something does not make it public; it appears in discovery only after it has been approved and published.

## Operator review

Anything that needs a decision goes to review. Decisions and reasons are recorded, and nothing goes live until it has passed review and been published.

## Reports and appeals

You can report characters, messages, media, collections, Comics, and profiles. An appeal is kept with the decision it disputes, so the reviewer sees the full history. Use [How to report](/reporting/how-to-report) for the reporting path.

## Services we use

Images, voice, and verification may be produced by services we run or by partners we work with. We name a partner only when that partnership is in place.
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

A public character also needs its required images and a published version. If an image is missing or out of date, the character stays out of discovery until it is fixed.

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
      "How the adult confirmation, character ages, and any extra age check work together.",
    markdown: `
## Adult access gate

You confirm you are an adult before browsing. That confirmation is remembered in this browser and, once you sign in, on your account.

## Character age

Character creation requires an adult age. A character with a missing, conflicting, or under-18 age cannot be made public.

## Additional verification

In some places, certain features need an extra age check. When that applies, we keep only the result of the check, not your documents.

## Problems with verification

Use the [Help Desk](/helpdesk) and include any reference shown on the verification screen.
`,
  },
  {
    path: "/policies/intellectual-property",
    title: "Intellectual property and likeness",
    description:
      "Rules for uploads, fictional character identity, attribution, and reports about ownership or likeness.",
    markdown: `
## Only share what you may use

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

Content goes live only when it is published. A generated image, a template, or an approved candidate is not public on its own.

## We keep account data scoped

Drafts, pending actions, and private media belong to the account that made them. If you switch accounts, the page clears or reloads anything private.

## We preserve history during repair

When older content has to be fixed, we keep it as a draft with its history rather than quietly showing it as current.
`,
  },
  {
    path: "/principles",
    title: "Product principles",
    description:
      "The first-principles rules used to keep public content, private data, and operator actions truthful.",
    markdown: `
## One answer for each question

Your identity, what is published, your balance, and your generations each have a single record that the whole product reads, so different pages show the same answer.

## Fail closed without inventing

When something cannot be loaded, we say so and offer a retry, or show the last confirmed result. We never show an empty page that looks real.

## Preserve provenance

Images and edits keep a record of where they came from and how they changed.

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

Your chats, drafts, presets, private media, plan, and billing records are only available when you are signed in to your account. Public pages follow separate rules.

## Public content

Only content that is public, approved, and published can appear in discovery. Creator credits are shown without exposing private account details.

## Services we use

To generate media, take payments, store files, or verify age, we may send the needed data to a service we use for that job. We name a service only when it is actually in use.

## Controls

Profile and the Help Desk let you manage your account and preferences, and delete your account.
`,
  },
  {
    path: "/your-account/safety-tools",
    title: "Account and safety tools",
    description:
      "The current product controls for preferences, reporting, message actions, support, and account management.",
    markdown: `
## Discovery preferences

Use your profile preferences and muted tags to shape what you see. They are saved to your account, so they follow you across devices.

## Conversation actions

In a chat you can edit or delete your messages, regenerate a reply, review what the character remembers, and delete the conversation. Only you can do this to your chats.

## Reports and appeals

Use Report on supported targets and the appeal form in the [Help Desk](/helpdesk) for a disputed decision.

## Account management

Use Profile to change your account settings, sign out other devices, or delete your account.
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
