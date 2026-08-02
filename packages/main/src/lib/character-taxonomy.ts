import {
  CHARACTER_STYLES,
  GENDERS,
  type CharacterStyle,
  type Gender,
} from "@idream/shared/catalog";

// SPEC: the public site's gender/style pickers and URL filters, derived from the
// cross-service catalog rather than retyped per workspace.
// INTENT: label maps are typed as exhaustive Records, so adding a member to the
// catalog is a compile error here instead of a value that silently disappears
// from the UI (which is how `other` went missing from every filter and from the
// create form).

export const ANY_FILTER_VALUE = "any" as const;

export type GenderFilterValue = Gender | typeof ANY_FILTER_VALUE;
export type CharacterStyleFilterValue = CharacterStyle | typeof ANY_FILTER_VALUE;

export type TaxonomyOption<T extends string> = Readonly<{ label: string; value: T }>;

const genderLabels: Record<Gender, string> = {
  female: "Female",
  male: "Male",
  trans: "Trans",
};

const characterStyleLabels: Record<CharacterStyle, string> = {
  realistic: "Realistic",
  anime: "Anime",
  hybrid: "Hybrid",
  other: "Other",
};

function optionsFor<T extends string>(
  values: readonly T[],
  labels: Record<T, string>,
): readonly TaxonomyOption<T>[] {
  return values.map((value) => ({ label: labels[value], value }));
}

/** Character-create form: a concrete gender must be chosen, so no "any" entry. */
export const genderFormOptions = optionsFor(GENDERS, genderLabels);

/** Character-create form: a concrete style must be chosen, so no "any" entry. */
export const characterStyleFormOptions = optionsFor(
  CHARACTER_STYLES,
  characterStyleLabels,
);

export const GENDER_FILTER_VALUES: readonly GenderFilterValue[] = [
  ANY_FILTER_VALUE,
  ...GENDERS,
];

export const CHARACTER_STYLE_FILTER_VALUES: readonly CharacterStyleFilterValue[] = [
  ANY_FILTER_VALUE,
  ...CHARACTER_STYLES,
];

export const genderFilterOptions: readonly TaxonomyOption<GenderFilterValue>[] = [
  { label: "Any Gender", value: ANY_FILTER_VALUE },
  ...genderFormOptions,
];

export const characterStyleFilterOptions: readonly TaxonomyOption<CharacterStyleFilterValue>[] =
  [{ label: "Any Style", value: ANY_FILTER_VALUE }, ...characterStyleFormOptions];
