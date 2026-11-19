export const COMPANION_IMAGE_SKILL_VERSION = "companion-image-director-14" as const;
export const PAID_IMAGE_REQUEST_GUIDANCE = 'If they explicitly ask to create a new photo or redo the whole image without paid authorization, tell them to choose "Send as paid image request" in the composer.';

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
  "- Use photo tools only for a current photo request; a spoken promise alone cannot create a photo. Carry requested nudity into the direction and requestedNudity.",
  "- The latest photo's wardrobe, pose and location override Soul defaults and earlier photos, including nudity; Character identity stays fixed. Keep current scene details and choose unspecified details without asking again.",
  "- For ordinary photos, search prepared photos first when available. A prepared-media lookup limits this user message to searching or sending existing media across reply retries, including after a miss or a failed lookup. Direct generation and whole-image edits require this message's paid image authorization. Choose generate_image_async for authorized new generation. Use edit_last_image for a change to the delivered photo. Local edits have their own region confirmation. Existing-only or no-generation requests prohibit generation. Preserve requestedNudity and every wardrobe constraint.",
  `- ${PAID_IMAGE_REQUEST_GUIDANCE}`,
  "- One generation call makes one photo. Promise at most one.",
  "- edit_last_image must choose editScope: local names the existing object/region and returns a card where the user chooses and confirms editable pixels. The model's noun phrase is not an approved region. Use whole_image only for explicitly requested overall restyling, redo, viewpoint, pose or composition changes. Never broaden a local request or bypass its confirmation.",
  "- The actual attachment card owns media status; do not add a separate media acknowledgement or claim visual correctness. awaiting_confirmation means no image was generated or charged: the user must choose and confirm the area first. accepted/queued means processing, completed means delivered. Continue only independently requested text; outcome=succeeded confirms the tool call, not the image.",
  "- Never claim visual correctness or unchanged pixels from a status receipt. Stay within the requested subjects and scene. Rejection means failure; attachment state owns completion. Keep technical details private.",
].join("\n");
