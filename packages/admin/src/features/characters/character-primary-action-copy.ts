import type { CharacterProductionJourney } from "@idream/shared/admin";

export const characterPrimaryActionCopy: Record<
  CharacterProductionJourney["primaryAction"]["code"],
  { description: string; eyebrow: string; label: string }
> = {

  recover_active_command: {
    description:
      "Finish or reconcile the command that currently owns this Character.",
    eyebrow: "Mutation in progress",
    label: "Open active command",
  },
  create_primary_portrait: {
    description:
      "Start here: lock the face once, then reuse it for every new image.",
    eyebrow: "First-time setup",
    label: "Create first identity portrait",
  },
  prepare_image_production: {
    description:
      "Use the existing live portrait once, then create future images without changing the live character.",
    eyebrow: "Enable image production",
    label: "Use existing portrait",
  },
  complete_image_route: {
    description:
      "The identity portrait is locked. Activate a compatible image route before creating an image.",
    eyebrow: "Image route setup",
    label: "Complete image route setup",
  },
  platform_route_unavailable: {
    description:
      "No qualified image route can serve this Character. This is a platform configuration issue you cannot fix on this page; platform operations manages it under Profiles & Rollout.",
    eyebrow: "Platform issue",
    label: "Open Profiles & Rollout",
  },
  retry_failed_image_run: {
    description:
      "The latest image failed without a result. Open Images and generate it again.",
    eyebrow: "Image generation failed",
    label: "Generate again",
  },
  resolve_unknown_image_run: {
    description:
      "The latest image has an unknown outcome and may already have cost money. Check that Run before generating again.",
    eyebrow: "Image outcome unknown",
    label: "Check image Run",
  },
  continue_image_run: {
    description: "Return to the latest unfinished image without starting over.",
    eyebrow: "Image in progress",
    label: "Continue current image",
  },
  continue_asset_pack: {
    description: "Complete the portrait, hero, and chat image set.",
    eyebrow: "Image pack in progress",
    label: "Continue filling image pack",
  },
  repair_character_soul: {
    description:
      "The images are ready, but the persona or opening message must be saved again before it can be published.",
    eyebrow: "Persona needs repair",
    label: "Repair persona",
  },
  preview_character: {
    description: "Preview the customer-facing draft before publishing.",
    eyebrow: "Ready to preview",
    label: "Preview Character",
  },
  publish_character: {
    description: "Publish the prepared immutable Character snapshot.",
    eyebrow: "Ready to publish",
    label: "Publish Character",
  },
  // SPEC: 走到这里说明线上没有任何待办。不要写成一个看起来要做的动作，运营不需要被提醒。
  monitor_live_character: {
    description: "Nothing needs you right now. Live monitoring is here if you want it.",
    eyebrow: "Live character",
    label: "No action needed",
  },
  restore_archived_draft: {
    description: "Restore this archived draft before continuing character production.",
    eyebrow: "Archived draft",
    label: "Restore draft",
  },
  review_retired_character: {
    description: "This character is retired. Review its release history.",
    eyebrow: "Retired character",
    label: "Review retired character",
  },
  review_paused_character: {
    description: "Customers cannot open this paused character. Resume it or keep it hidden under Release availability.",
    eyebrow: "Paused character",
    label: "Review paused character",
  },
  resolve_live_release_blocker: {
    description: "Resolve the current live Release blocker before continuing routine production.",
    eyebrow: "Live release blocked",
    label: "Resolve live release blocker",
  },
  republish_stale_release: {
    description: "The live Release lost its route qualification. Customers still see it; publish again to bring it back to a checked state.",
    eyebrow: "Live release stale",
    label: "Publish again",
  },
  inspect_performance_quality: {
    description: "The performance authority marked this Character's funnel facts invalid, so these numbers cannot support a decision.",
    eyebrow: "Performance data invalid",
    label: "Inspect performance quality",
  },
  review_release_monitor: {
    description: "The published monitor needs a decision. Review its evidence, then keep or roll back this Release.",
    eyebrow: "Monitor needs action",
    label: "Review monitor evidence",
  },
  inspect_no_traffic: {
    description: "No exposure, funnel, or chat traffic in 7 days live. Check placement targeting and event delivery.",
    eyebrow: "No traffic after 7 days",
    label: "Inspect live monitoring",
  },
  prepare_pending_release: {
    description: "A newer Character revision is saved but the live Release still serves the previous one.",
    eyebrow: "Unpublished revision",
    label: "Prepare release",
  },
  complete_live_asset_pack: {
    description: "Complete the portrait, hero, and chat image set.",
    eyebrow: "Live with an incomplete image pack",
    label: "Complete image pack",
  },
  republish_legacy_release: {
    description: "This Release predates current checks. It keeps serving; publish once to move it onto a checked Release.",
    eyebrow: "Legacy release",
    label: "Publish a checked Release",
  },
};
