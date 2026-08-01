import {
  adminReadinessSchema,
  characterProjectPhaseSchema,
  characterServingStateSchema,
} from "@idream/shared/admin";

export interface CharacterPortfolioUrlState {
  readonly search: string;
  readonly phase?: string;
  readonly servingState?: string;
  readonly readiness?: string;
  readonly attention?: boolean;
  readonly cursor?: string;
}

export const CHARACTER_PORTFOLIO_PHASES = characterProjectPhaseSchema.options;
export const CHARACTER_PORTFOLIO_SERVING_STATES = characterServingStateSchema.options;
export const CHARACTER_PORTFOLIO_READINESS_STATES = adminReadinessSchema.options;

function optionalValue(value: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function parseCharacterPortfolioUrl(search: string): CharacterPortfolioUrlState {
  const params = new URLSearchParams(search);
  const phase = characterProjectPhaseSchema.safeParse(params.get("phase"));
  const servingState = characterServingStateSchema.safeParse(params.get("servingState"));
  const readiness = adminReadinessSchema.safeParse(params.get("readiness"));
  return {
    search: params.get("search")?.trim() ?? "",
    phase: phase.success ? phase.data : undefined,
    servingState: servingState.success ? servingState.data : undefined,
    readiness: readiness.success ? readiness.data : undefined,
    attention: params.get("attention") === "true" ? true : undefined,
    cursor: optionalValue(params.get("cursor")),
  };
}

export function characterPortfolioQuery(
  state: CharacterPortfolioUrlState,
  includeAuthorityDefaults = false,
) {
  const params = new URLSearchParams();
  if (includeAuthorityDefaults) {
    params.set("limit", "25");
    params.set("sort", "project_id_asc");
  }
  if (state.search.trim()) params.set("search", state.search.trim());
  if (state.phase) params.set("phase", state.phase);
  if (state.servingState) params.set("servingState", state.servingState);
  if (state.readiness) params.set("readiness", state.readiness);
  if (state.attention) params.set("attention", "true");
  if (state.cursor) params.set("cursor", state.cursor);
  return params.toString();
}
