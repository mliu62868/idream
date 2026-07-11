export type AdminShellSignals = {
  environment: "production" | "staging" | "local" | "test" | "unknown";
  dataClass: "customer" | "internal" | "fixture" | "audit" | "unknown";
  fixtureState: "included" | "excluded" | "unknown";
  productTimezone: string;
  freshness:
    | { state: "reported"; label: string }
    | { state: "unavailable"; label: "No source watermark (legacy v1)" };
};

type Environment = Readonly<Record<string, string | undefined>>;

export function deriveAdminShellSignals(env: Environment): AdminShellSignals {
  const explicitEnvironment = env.ADMIN_ENVIRONMENT?.trim().toLowerCase();
  const nodeEnvironment = env.NODE_ENV?.trim().toLowerCase();
  const environment = asEnvironment(explicitEnvironment ?? nodeEnvironment);
  const dataClass = asDataClass(env.ADMIN_DATA_CLASS?.trim().toLowerCase());
  const fixtureValue = env.ADMIN_FIXTURES_ENABLED?.trim().toLowerCase();
  const fixtureState = fixtureValue === "true"
    ? "included"
    : fixtureValue === "false"
      ? "excluded"
      : "unknown";
  const freshnessAt = env.ADMIN_DATA_FRESHNESS_AT?.trim();

  return {
    environment,
    dataClass,
    fixtureState,
    productTimezone: env.ADMIN_PRODUCT_TIMEZONE?.trim() || "UTC",
    freshness: freshnessAt
      ? { state: "reported", label: freshnessAt }
      : { state: "unavailable", label: "No source watermark (legacy v1)" },
  };
}

function asEnvironment(value: string | undefined): AdminShellSignals["environment"] {
  if (value === "production" || value === "staging" || value === "local" || value === "test") return value;
  if (value === "development") return "local";
  return "unknown";
}

function asDataClass(value: string | undefined): AdminShellSignals["dataClass"] {
  if (value === "customer" || value === "internal" || value === "fixture" || value === "audit") return value;
  return "unknown";
}
