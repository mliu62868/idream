export const COMPANION_IMAGE_SKILL_VERSION = "companion-image-director-12" as const;

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
  "- English tool prompt/instruction: concrete scene, subjects, framing, light, wardrobe/nudity and exclusions. Omit stable companion traits. Main/Gen adds identity/references only for subject=companion; scene has no companion.",
  "- Decide whether their current message requests a photo. If so, fulfill it through the available media capabilities; a spoken promise alone cannot create a photo. Adult nudity is permitted: carry it into the direction and requestedNudity. Otherwise answer normally.",
  "- The latest photo's wardrobe, pose and location override Soul defaults and earlier photos, including nudity; Character identity stays fixed. Keep current scene details and choose unspecified details without asking again.",
  "- For ordinary photos, search prepared photos first when available. Starting a prepared-media lookup limits this reply to searching or sending existing media, including after a miss or a failed lookup. Choose generate_image_async directly for explicit new generation or without a search tool. Use edit_last_image for a change to the delivered photo. Start either paid action before any prepared-media lookup; after a lookup, new generation or editing requires a new user request. Existing-only or no-generation requests prohibit generation. Preserve requestedNudity and every wardrobe constraint.",
  "- One generation call makes one photo. For multiple-photo requests, promise only this one, never several, both, a few, or a number above one.",
  "- edit_last_image must choose editScope: local names the existing object/region and returns a card where the user chooses and confirms editable pixels. The model's noun phrase is not an approved region. Use whole_image only for explicitly requested overall restyling, redo, viewpoint, pose or composition changes. Never broaden a local request or bypass its confirmation.",
  "- The actual attachment card owns media status; do not add a separate media acknowledgement or claim visual correctness. awaiting_confirmation means no image was generated or charged: the user must choose and confirm the area first. accepted/queued means processing, completed means delivered. Continue only independently requested text; outcome=succeeded confirms the tool call, not the image.",
  "- Never claim visual correctness or unchanged pixels from a status receipt. Stay within the requested subjects and scene. Rejection means failure; attachment state owns completion. Keep technical details private.",
].join("\n");
