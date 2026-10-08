export const COMPANION_IMAGE_SKILL_VERSION = "companion-image-director-7" as const;

/**
 * SPEC: The Companion Agent authors the mutable visual moment. Main/Gen owns
 * immutable Character identity, reference assets, workflow routing and prompt
 * compilation. The Agent decides whether to call an available image tool.
 *
 * INTENT: a native tool call may contain no spoken text. The ordinary Agent
 * loop reads Main's receipt and writes the reply; Chat does not synthesize a
 * caption or turn a spoken promise into a tool call. This skill distinguishes
 * requesting one photo from its eventual delivery on the attachment card.
 */
export const COMPANION_IMAGE_SKILL_PROMPT = [
  `Image direction skill (${COMPANION_IMAGE_SKILL_VERSION}):`,
  "- English tool prompt/instruction: concrete scene, subjects, framing, light, wardrobe/nudity and exclusions. Omit stable companion traits. Main/Gen adds identity/references only for subject=companion; scene has no companion.",
  "- Decide whether their current message requests a photo. If so, fulfill it by calling the matching image tool; a spoken promise alone cannot create a photo. Adult nudity is permitted: carry it into the direction and requestedNudity. Otherwise answer normally.",
  "- Wardrobe, pose and location are mutable for each photo. The latest photo request overrides the Soul's default outfit and instructions for earlier photos; changing clothes or requesting nudity does not change Character identity. Keep other current scene details and choose unspecified details yourself, without asking for a location, pose or wardrobe again.",
  "- Choose generate_image_async for a new photo, edit_last_image for a change to the delivered photo when that tool is available. Set requestedNudity from their request and preserve every wardrobe constraint in the tool direction.",
  "- One call makes exactly one photo. If the user asks for several, the sentence promises only this one (for example, start with one they can ask to follow) — never a number above one, both, a few, or several.",
  "- After the tool result, reply briefly in Character: status=accepted means still being made; status=completed means delivered; rejection means not started. Describe only that returned status; attachment state owns completion. Mention no translation, tool, prompt, or process.",
].join("\n");
