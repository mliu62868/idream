import {
  characterProjectDraftSchema,
  characterProjectProductionReadyDraftSchema,
  type CharacterProjectDraft,
} from "@idream/shared/admin";

const requiredCopy: Record<string, string> = {
  name: "Enter a character name.",
  age: "Age must be a whole number from 18 to 120.",
  gender: "Select a supported gender.",
  characterPromise: "Write a one-line description.",
  detailsMarkdown: "Enter valid character details.",
  firstMessage: "Write the first message users will receive.",
  identityAnchor: "Describe the visual identity to establish.",
  stableTraits: "Add at least one stable visual trait.",
  style: "Select a supported visual style.",
  referenceDirection: "Describe the portrait's visual direction.",
};

const limitCopy: Record<string, string> = {
  name: "Name must be 120 characters or fewer.",
  age: requiredCopy.age,
  characterPromise: "Short description must be 1000 characters or fewer.",
  detailsMarkdown: "Additional details must be 24000 characters or fewer.",
  firstMessage: "Opening message must be 4000 characters or fewer.",
  identityAnchor: "Identity anchor must be 2000 characters or fewer.",
  stableTraits: "Each stable visual trait must be 500 characters or fewer.",
  referenceDirection: "Reference direction must be 4000 characters or fewer.",
};

// INVARIANT: nested array errors belong to the editable field, never its item index.
// Both creation and editing use the same contract and the same recovery instructions.
export function characterCreateStepFieldErrors(draft: CharacterProjectDraft, step: number): Record<string, string> {
  const parsed = step === 0
    ? characterProjectDraftSchema.shape.persona.safeParse(draft.persona)
    : step === 1
      ? characterProjectDraftSchema.shape.visualDirection.safeParse(draft.visualDirection)
      : characterProjectProductionReadyDraftSchema.safeParse(draft);
  if (parsed.success) return {};
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path.find((part): part is string => typeof part === "string" && Object.hasOwn(requiredCopy, part));
    if (!field || errors[field]) continue;
    errors[field] = issue.code === "custom"
      ? "Replace the placeholder with real character information."
      : issue.code === "too_big"
        ? field === "stableTraits" && issue.origin === "array"
          ? "Add no more than 24 stable visual traits."
          : limitCopy[field] ?? requiredCopy[field]
        : requiredCopy[field];
  }
  return errors;
}
