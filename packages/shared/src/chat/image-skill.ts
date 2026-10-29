export const COMPANION_IMAGE_SKILL_VERSION = "companion-image-director-10" as const;

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
  "- For ordinary photos, search prepared photos first when available; generate only after no suitable match. Choose generate_image_async directly for explicit new generation or without a search tool. Use edit_last_image for a change to the delivered photo. Existing-only or no-generation requests prohibit generation. Preserve requestedNudity and every wardrobe constraint.",
  "- One generation call makes one photo. For multiple-photo requests, promise only this one, never several, both, a few, or a number above one.",
  "- Briefly acknowledge output.status in Character and the user's requested format. accepted or queued means still processing: use present/future tense throughout, never claim completion. completed confirms delivery only. outcome=succeeded confirms the call, not completion.",
  "- Never claim visual correctness or unchanged pixels from a status receipt. Stay within the requested subjects and scene. Rejection means failure; attachment state owns completion. Keep technical details private.",
].join("\n");
