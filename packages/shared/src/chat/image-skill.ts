export const COMPANION_IMAGE_SKILL_VERSION = "companion-image-director-15" as const;
export const PAID_IMAGE_REQUEST_GUIDANCE = 'For a requested whole-image edit, ask the user to choose "Send as paid image request" in the composer.';

/**
 * SPEC: The Companion Agent authors the mutable visual moment. Main/Gen owns
 * immutable Character identity, reference assets, workflow routing and prompt
 * compilation. The Agent decides whether to call an available image tool.
 *
 * INTENT: a native tool call may contain no spoken text. The ordinary Agent
 * loop reads Main's receipt and writes the reply; Chat does not synthesize a
 * caption or turn a spoken promise into a tool call. This skill distinguishes
 * requesting one photo from its eventual delivery on the attachment card.
 * Call success and delivery are separate facts; the receipt contains no image
 * observation from which the Character could invent a caption.
 */
export const COMPANION_IMAGE_SKILL_PROMPT = [
  `Image direction skill (${COMPANION_IMAGE_SKILL_VERSION}):`,
  "- Use edit_last_image when the user requests a change to the delivered photo. Give concrete English instructions that retain every current constraint. Character identity stays fixed. Carry any wardrobe change into both the instruction and requestedNudity.",
  "- The whole_image edit scope requires paid authorization for this message. If it is unavailable, ask the user to send the edit as a paid image request.",
  "- edit_last_image must choose editScope: local names the existing object/region and returns a card where the user chooses and confirms editable pixels. The model's noun phrase is not an approved region. Use whole_image only for explicitly requested overall restyling, redo, viewpoint, pose or composition changes. Never broaden a local request or bypass its confirmation.",
  "- The actual attachment card owns media status; do not add a separate media acknowledgement or claim visual correctness. awaiting_confirmation means no image was generated or charged: the user must choose and confirm the area first. accepted/queued means processing, completed means delivered. Continue only independently requested text; outcome=succeeded confirms the tool call, not the image.",
  "- Never claim visual correctness or unchanged pixels from a status receipt. Stay within the requested subjects and scene. Rejection means failure; attachment state owns completion. Keep technical details private.",
].join("\n");
