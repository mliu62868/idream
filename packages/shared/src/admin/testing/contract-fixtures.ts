import { z } from "zod";
import { requireExecutableAdminV2Contract } from "../contract-registry";

// Test-only examples: production contract resolution never depends on fixture generation.
const fixtureOverrides: Readonly<Record<string, unknown>> = {
  adminCoinOfferListSchema: { items: [] },
  adminCoinOfferCreateRequestSchema: {
    offerKey: "fixture-coins", name: "Fixture coins", dreamcoins: 100,
    priceCents: 100, currency: "usd", eligibility: "all",
    terms: "Fixture terms for a controlled checkout test.", reason: "Verify coin offer contract",
  },
  adminCoinOfferMutationSchema: {
    offer: {
      id: "fixture-coin-offer", offerKey: "fixture-coins", name: "Fixture coins", dreamcoins: 100,
      priceCents: 100, currency: "usd", eligibility: "all",
      terms: "Fixture terms for a controlled checkout test.", version: 1, status: "draft",
      publishedAt: null, createdAt: "2026-09-10T00:00:00.000Z", fingerprint: "a".repeat(64),
    },
  },
  characterVoiceClipReclaimRequestSchema: {
    requestId: "voice-request-fixture",
    confirmation: "RECLAIM VOICE voice-request-fixture",
    reason: "Recover an expired Voice worker lease",
  },
  creativeRunCreateRequestSchema: {
    purpose: "feed",
    targetType: "none",
    profileId: "profile-fixture",
    brief: "Executable Creative Run contract fixture",
    reason: "Verify Creative Run request contract",
  },
  experimentDefinitionCreateSchema: {
    key: "fixture.experiment",
    hypothesis: "The treatment improves qualified engagement.",
    eligibility: {},
    variants: [
      { key: "control", allocationBps: 5_000 },
      { key: "treatment", allocationBps: 5_000 },
    ],
    salt: "fixture-experiment-salt",
    metrics: {
      primary: "relationship.qce_activation.v1",
      controlVariant: "control",
      guardrails: [{ metricKey: "retention.d7", maxAbsoluteRegression: 0.05 }],
    },
  },
  operationalWorkPreferenceUpdateSchema: {
    sourceType: "admin_case",
    sourceId: "case-fixture",
    watching: true,
  },
  // Every mutable field is optional and a cross-field rule demands at least one of them,
  // so the structural fixture (required fields only) is a no-op patch the contract rejects.
  contentTagPatchRequestSchema: {
    label: "Fixture tag label",
    reason: "Verify the tag patch contract",
    confirmation: "tag-fixture",
  },
  contentPlacementPatchRequestSchema: {
    status: "paused",
    reason: "Verify placement patch contract",
    confirmation: "placement-fixture",
  },
};

export function adminV2ContractFixtures(ref: string) {
  const binding = requireExecutableAdminV2Contract(ref);
  return {
    valid: fixtureOverrides[binding.ref] ?? validFixture(binding.schema),
    invalid: Symbol.for(`invalid-admin-v2-contract:${binding.ref}`),
  };
}

type ZodDef = {
  readonly type: string;
  readonly shape?: Record<string, z.ZodType>;
  readonly innerType?: z.ZodType;
  readonly element?: z.ZodType;
  readonly options?: readonly z.ZodType[];
  readonly entries?: Readonly<Record<string, unknown>>;
  readonly values?: readonly unknown[];
  readonly items?: readonly z.ZodType[];
  readonly left?: z.ZodType;
  readonly right?: z.ZodType;
  readonly in?: z.ZodType;
  readonly getter?: () => z.ZodType;
};

function definition(schema: z.ZodType): ZodDef {
  return (schema as unknown as { _zod: { def: ZodDef } })._zod.def;
}

function validFixture(schema: z.ZodType, depth = 0): unknown {
  if (depth > 30)
    throw new Error("Admin v2 fixture schema nesting exceeded 30 levels");
  const def = definition(schema);
  if (
    ["optional", "default", "prefault", "catch"].includes(def.type) &&
    schema.safeParse(undefined).success
  ) {
    return undefined;
  }
  if (def.type === "nullable" && schema.safeParse(null).success) return null;
  if (
    [
      "optional",
      "nullable",
      "default",
      "prefault",
      "catch",
      "readonly",
      "nonoptional",
    ].includes(def.type) &&
    def.innerType
  ) {
    return validFixture(def.innerType, depth + 1);
  }
  if (def.type === "string") return stringFixture(schema);
  if (def.type === "number") return numberFixture(schema);
  if (def.type === "bigint") return BigInt(1);
  if (def.type === "boolean") return false;
  if (def.type === "date") return new Date("2026-01-01T00:00:00.000Z");
  if (def.type === "literal") return def.values?.[0];
  if (def.type === "enum") return Object.values(def.entries ?? {})[0];
  if (def.type === "object") {
    const candidate: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(def.shape ?? {})) {
      const value = validFixture(child, depth + 1);
      if (value !== undefined) candidate[key] = value;
    }
    if (schema.safeParse(candidate).success) return candidate;
    // Cross-field refinements commonly partition an enum across two arrays.
    // Try every distinct enum prefix for one array at a time before declaring
    // that the structural fixture cannot satisfy the object invariant.
    for (const [key, child] of Object.entries(def.shape ?? {})) {
      for (const value of enumArrayFixtures(child)) {
        const refined = { ...candidate, [key]: value };
        if (schema.safeParse(refined).success) return refined;
      }
    }
    throw new Error(
      `No structural positive fixture for object schema: ${JSON.stringify(candidate)}`,
    );
  }
  if (def.type === "array" && def.element) {
    const child = validFixture(def.element, depth + 1);
    for (let length = 0; length <= 32; length += 1) {
      const candidate = Array.from({ length }, () => child);
      if (schema.safeParse(candidate).success) return candidate;
    }
  }
  if (def.type === "union") {
    for (const option of def.options ?? []) {
      const candidate = validFixture(option, depth + 1);
      if (schema.safeParse(candidate).success) return candidate;
    }
  }
  if (def.type === "tuple") {
    const candidate = (def.items ?? []).map((item) =>
      validFixture(item, depth + 1),
    );
    if (schema.safeParse(candidate).success) return candidate;
  }
  if (def.type === "record" || def.type === "map") return {};
  if (def.type === "set") return new Set();
  if (def.type === "intersection" && def.left && def.right) {
    const left = validFixture(def.left, depth + 1);
    const right = validFixture(def.right, depth + 1);
    const candidate =
      isRecord(left) && isRecord(right) ? { ...left, ...right } : left;
    if (schema.safeParse(candidate).success) return candidate;
  }
  if (def.type === "pipe" && def.in) return validFixture(def.in, depth + 1);
  if (def.type === "lazy" && def.getter)
    return validFixture(def.getter(), depth + 1);
  if (def.type === "unknown" || def.type === "any") return null;
  if (def.type === "undefined" || def.type === "void") return undefined;
  if (def.type === "null") return null;
  throw new Error(`Unsupported Admin v2 fixture schema type: ${def.type}`);
}

function enumArrayFixtures(schema: z.ZodType): readonly unknown[][] {
  let def = definition(schema);
  while (
    [
      "optional",
      "nullable",
      "default",
      "prefault",
      "catch",
      "readonly",
      "nonoptional",
    ].includes(def.type)
  ) {
    if (!def.innerType) return [];
    def = definition(def.innerType);
  }
  if (def.type !== "array" || !def.element) return [];
  let element = definition(def.element);
  while (
    [
      "optional",
      "nullable",
      "default",
      "prefault",
      "catch",
      "readonly",
      "nonoptional",
    ].includes(element.type)
  ) {
    if (!element.innerType) return [];
    element = definition(element.innerType);
  }
  if (element.type !== "enum") return [];
  const values = Object.values(element.entries ?? {});
  return Array.from({ length: values.length + 1 }, (_, length) =>
    values.slice(0, length),
  );
}

function stringFixture(schema: z.ZodType): string {
  const stringSchema = schema as unknown as {
    readonly format?: string | null;
    readonly minLength?: number | null;
    readonly maxLength?: number | null;
  };
  const minLength = Math.max(1, stringSchema.minLength ?? 1);
  const candidates = [
    "2026-01-01T00:00:00.000Z",
    "fixture@example.test",
    "https://example.test/evidence",
    "00000000-0000-4000-8000-000000000001",
    "/admin/characters/fixture",
    "/admin/characters/fixture?tab=assets",
    "/admin/cases/fixture",
    "/admin/ops/incidents/fixture",
    "a".repeat(64),
    "fixture-value".padEnd(minLength, "x"),
    "x".repeat(minLength),
  ];
  for (const candidate of candidates) {
    if (
      (stringSchema.maxLength === null ||
        stringSchema.maxLength === undefined ||
        candidate.length <= stringSchema.maxLength) &&
      schema.safeParse(candidate).success
    )
      return candidate;
  }
  throw new Error(
    `No positive string fixture for format ${stringSchema.format ?? "plain"}`,
  );
}

function numberFixture(schema: z.ZodType): number {
  const numberSchema = schema as unknown as {
    readonly minValue?: number | null;
    readonly maxValue?: number | null;
    readonly isInt?: boolean;
  };
  const min = Number.isFinite(numberSchema.minValue)
    ? (numberSchema.minValue as number)
    : -10;
  const max = Number.isFinite(numberSchema.maxValue)
    ? (numberSchema.maxValue as number)
    : 10;
  const values = [0, 1, -1, min, max, Math.ceil(min), Math.floor(max)];
  for (const value of values) {
    const candidate = numberSchema.isInt ? Math.trunc(value) : value;
    if (schema.safeParse(candidate).success) return candidate;
  }
  throw new Error("No positive numeric fixture for Admin v2 contract");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
