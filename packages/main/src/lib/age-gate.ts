export const AGE_GATE_COOKIE_NAME = "AdultContentAcceptedOD";

export function ageGateAcceptedFromCookieValue(value: string | undefined) {
  return value === "true";
}

export function canStartAgeGatedLoad(
  accepted: boolean,
  initialized = true,
) {
  return accepted && initialized;
}
