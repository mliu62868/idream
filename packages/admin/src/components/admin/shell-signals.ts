export type AdminShellSignals = {
  environment: "production" | "staging" | "local" | "test" | "unknown";
  dataClass: "customer" | "internal" | "fixture" | "audit" | "unknown";
  fixtureState: "included" | "excluded" | "unknown";
  productTimezone: string;
  freshness:
    | { state: "reported"; label: string }
    | { state: "unavailable"; label: "No source watermark (legacy v1)" };
};

export type AdminShellSignalChip = { key: string; label: string; value: string };

// SPEC: 只有真正携带信息的来源标记才占位。
// INTENT: 五个 chip 常驻时通常有三个写着 unknown / legacy v1，占掉每一页最贵的那条横幅
//         却什么都没说。环境和时区决定运营怎么读页面上的每个数字，永远保留；其余没配置
//         就不渲染，配好了自然出现。
export function adminShellSignalChips(signals: AdminShellSignals): AdminShellSignalChip[] {
  return [
    { key: "environment", label: "Environment", value: signals.environment },
    { key: "data-class", label: "Data class", value: signals.dataClass === "unknown" ? null : signals.dataClass },
    { key: "fixtures", label: "Fixtures", value: signals.fixtureState === "unknown" ? null : signals.fixtureState },
    { key: "timezone", label: "Product timezone", value: signals.productTimezone },
    { key: "freshness", label: "Freshness", value: signals.freshness.state === "reported" ? signals.freshness.label : null },
  ].filter((chip): chip is AdminShellSignalChip => chip.value !== null);
}

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
