import { z } from "zod";
import * as adminContracts from "./contracts/index";

type ContractEvidence = {
  readonly owner: `packages/${string}`;
  readonly reason: string;
};

export type ExecutableAdminV2Contract = {
  readonly kind: "zod" | "transport";
  readonly fixtureKey: string;
  readonly schema: z.ZodType;
  readonly source: `packages/${string}`;
  readonly requirements: readonly ("idempotency-key" | "if-match")[];
  readonly fixtures: { readonly valid: unknown; readonly invalid: unknown };
};

export type PendingAdminV2Contract = ContractEvidence & {
  readonly kind: "pending";
  readonly fixtureKey: string;
};

export type AdminV2ContractBinding = ExecutableAdminV2Contract | PendingAdminV2Contract;

const transportContracts = {
  none: z.undefined(),
  "path:id": z.object({ id: z.string().trim().min(1) }).strict(),
  "path:commandId": z.object({ commandId: z.string().trim().min(1) }).strict(),
  "if-match": z.object({ ifMatch: z.coerce.number().int().positive() }).strict(),
  "limit-query": z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).strict(),
} as const satisfies Record<string, z.ZodType>;

export const ADMIN_V2_PENDING_CONTRACTS = {
} as const satisfies Record<string, ContractEvidence>;

const bindingCache = new Map<string, ExecutableAdminV2Contract>();
const fixtureOverrides: Readonly<Record<string, unknown>> = {
  characterQaRunCreateRequestSchema: {
    entityVersion: 1,
    checks: [
      "explore_feed_card_desktop",
      "explore_feed_card_mobile",
      "character_detail_desktop",
      "character_detail_mobile",
      "opening_message",
      "five_turn_conversation",
      "chat_image",
    ].map((key) => ({
      key,
      result: "passed",
      evidenceRef: `evidence:${key}`,
      comment: `${key} passed`,
      fixDeepLink: "/admin/characters/fixture",
    })),
    reason: "Complete release QA fixture",
  },
  creativeRunCreateRequestSchema: {
    purpose: "model_eval",
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
};

export function resolveAdminV2Contract(ref: string): AdminV2ContractBinding | null {
  const { baseRef, requirements } = splitRequirements(ref);
  const pending = (ADMIN_V2_PENDING_CONTRACTS as Readonly<Record<string, ContractEvidence>>)[baseRef];
  if (pending) return { kind: "pending", fixtureKey: baseRef, ...pending };

  const transport = transportContracts[baseRef as keyof typeof transportContracts];
  if (transport) return executableBinding(baseRef, transport, "transport", requirements, "packages/shared/src/admin/contract-registry.ts");

  const candidate = adminContracts[baseRef as keyof typeof adminContracts] as unknown;
  if (!isZodSchema(candidate)) return null;
  return executableBinding(
    baseRef,
    candidate,
    "zod",
    requirements,
    `packages/shared/src/admin/contracts/index.ts#${baseRef}`,
  );
}

export function requireExecutableAdminV2Contract(ref: string): ExecutableAdminV2Contract {
  const binding = resolveAdminV2Contract(ref);
  if (!binding || binding.kind === "pending") {
    throw new Error(`Admin v2 contract ${ref} is not executable`);
  }
  return binding;
}

function executableBinding(
  fixtureKey: string,
  schema: z.ZodType,
  kind: "zod" | "transport",
  requirements: readonly ("idempotency-key" | "if-match")[],
  source: `packages/${string}`,
): ExecutableAdminV2Contract {
  const cached = bindingCache.get(fixtureKey);
  if (cached) return { ...cached, requirements };
  let valid: unknown;
  try {
    valid = fixtureOverrides[fixtureKey] ?? validFixture(schema);
  } catch (error) {
    throw new Error(`${fixtureKey}: ${error instanceof Error ? error.message : "fixture generation failed"}`);
  }
  const binding: ExecutableAdminV2Contract = {
    kind,
    fixtureKey,
    schema,
    source,
    requirements,
    fixtures: {
      valid,
      invalid: Symbol.for(`invalid-admin-v2-contract:${fixtureKey}`),
    },
  };
  bindingCache.set(fixtureKey, binding);
  return binding;
}

function splitRequirements(ref: string) {
  const parts = ref.split("+");
  const baseRef = parts.shift() ?? ref;
  const requirements = parts.filter(
    (part): part is "idempotency-key" | "if-match" => part === "idempotency-key" || part === "if-match",
  );
  return { baseRef, requirements };
}

function isZodSchema(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "safeParse" in value &&
    typeof (value as { safeParse?: unknown }).safeParse === "function";
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
  if (depth > 30) throw new Error("Admin v2 fixture schema nesting exceeded 30 levels");
  const def = definition(schema);
  if (["optional", "default", "prefault", "catch"].includes(def.type) && schema.safeParse(undefined).success) {
    return undefined;
  }
  if (def.type === "nullable" && schema.safeParse(null).success) return null;
  if (["optional", "nullable", "default", "prefault", "catch", "readonly", "nonoptional"].includes(def.type) && def.innerType) {
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
    throw new Error(`No structural positive fixture for object schema: ${JSON.stringify(candidate)}`);
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
    const candidate = (def.items ?? []).map((item) => validFixture(item, depth + 1));
    if (schema.safeParse(candidate).success) return candidate;
  }
  if (def.type === "record" || def.type === "map") return {};
  if (def.type === "set") return new Set();
  if (def.type === "intersection" && def.left && def.right) {
    const left = validFixture(def.left, depth + 1);
    const right = validFixture(def.right, depth + 1);
    const candidate = isRecord(left) && isRecord(right) ? { ...left, ...right } : left;
    if (schema.safeParse(candidate).success) return candidate;
  }
  if (def.type === "pipe" && def.in) return validFixture(def.in, depth + 1);
  if (def.type === "lazy" && def.getter) return validFixture(def.getter(), depth + 1);
  if (def.type === "unknown" || def.type === "any") return null;
  if (def.type === "undefined" || def.type === "void") return undefined;
  if (def.type === "null") return null;
  throw new Error(`Unsupported Admin v2 fixture schema type: ${def.type}`);
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
    "/admin/cases/fixture",
    "/admin/ops/incidents/fixture",
    "a".repeat(64),
    "fixture-value".padEnd(minLength, "x"),
    "x".repeat(minLength),
  ];
  for (const candidate of candidates) {
    if ((stringSchema.maxLength === null || stringSchema.maxLength === undefined || candidate.length <= stringSchema.maxLength) &&
      schema.safeParse(candidate).success) return candidate;
  }
  throw new Error(`No positive string fixture for format ${stringSchema.format ?? "plain"}`);
}

function numberFixture(schema: z.ZodType): number {
  const numberSchema = schema as unknown as {
    readonly minValue?: number | null;
    readonly maxValue?: number | null;
    readonly isInt?: boolean;
  };
  const min = Number.isFinite(numberSchema.minValue) ? numberSchema.minValue as number : -10;
  const max = Number.isFinite(numberSchema.maxValue) ? numberSchema.maxValue as number : 10;
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
