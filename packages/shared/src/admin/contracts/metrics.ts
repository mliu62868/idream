import { z } from "zod";
import {
  adminCursorQuerySchema,
  adminIsoDateTimeSchema,
  adminListResponseSchema,
} from "./common";

export const metricQualityStateSchema = z.enum(["certified", "directional", "invalid", "stale"]);
export const metricDecisionUseSchema = z.enum(["allowed", "directional_only", "blocked"]);

export const metricDefinitionSchema = z
  .object({
    key: z.string().trim().min(1),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    businessQuestion: z.string().trim().min(1),
    numerator: z.string().trim().min(1),
    denominator: z.string().trim().min(1),
    grain: z.string().trim().min(1),
    sourceFacts: z.array(z.string().trim().min(1)).min(1).readonly(),
    sourceEvents: z.array(z.string().trim().min(1)).min(1).readonly(),
    requiredTrustClasses: z.array(z.string().trim().min(1)).min(1).readonly(),
    exclusions: z.array(z.string().trim().min(1)).readonly(),
    cohort: z.string().trim().min(1),
    window: z.string().trim().min(1),
    timezone: z.string().trim().min(1),
    maturity: z.string().trim().min(1),
    dedupe: z.string().trim().min(1),
    attributionRule: z.string().trim().min(1),
    owner: z.string().trim().min(1),
    version: z.number().int().positive(),
    effectiveAt: adminIsoDateTimeSchema,
    queryHash: z.string().trim().min(1),
    freshnessSlo: z
      .object({
        maxAgeSeconds: z.number().int().positive(),
      })
      .strict(),
    qualityState: metricQualityStateSchema,
    decisionUse: metricDecisionUseSchema,
    lastValidatedAt: adminIsoDateTimeSchema.nullable(),
    validationEvidence: z.array(z.string().trim().min(1)).readonly(),
  })
  .strict()
  .superRefine((definition, ctx) => {
    const expectedDecisionUse =
      definition.qualityState === "certified"
        ? "allowed"
        : definition.qualityState === "directional"
          ? "directional_only"
          : "blocked";
    if (definition.decisionUse !== expectedDecisionUse) {
      ctx.addIssue({
        code: "custom",
        path: ["decisionUse"],
        message: `Quality state ${definition.qualityState} requires ${expectedDecisionUse}`,
      });
    }
  });

export const metricCardSchema = z
  .object({
    key: z.string().trim().min(1),
    definitionVersion: z.number().int().positive(),
    name: z.string().trim().min(1),
    value: z.union([z.number(), z.string(), z.null()]),
    unit: z.string().trim().min(1),
    numeratorLabel: z.string().trim().min(1),
    denominatorLabel: z.string().trim().min(1),
    numeratorValue: z.number().nullable(),
    denominatorValue: z.number().nullable(),
    sampleSize: z.number().int().nonnegative(),
    window: z.string().trim().min(1),
    maturity: z.enum(["mature", "immature", "insufficient_data"]),
    latestDataAt: adminIsoDateTimeSchema.nullable(),
    qualityState: metricQualityStateSchema,
  })
  .strict();

export const metricQuerySchema = adminCursorQuerySchema.extend({
  qualityState: metricQualityStateSchema.optional(),
  owner: z.string().trim().min(1).optional(),
});

export const metricListResponseSchema = adminListResponseSchema(metricCardSchema);

export type MetricDefinition = z.infer<typeof metricDefinitionSchema>;
export type MetricCard = z.infer<typeof metricCardSchema>;
export type MetricQuery = z.infer<typeof metricQuerySchema>;

export function defineMetricRegistry(definitions: readonly MetricDefinition[]): readonly MetricDefinition[] {
  const parsed = definitions.map((definition) => metricDefinitionSchema.parse(definition));
  const seen = new Set<string>();
  for (const definition of parsed) {
    const identity = `${definition.key}@${definition.version}`;
    if (seen.has(identity)) throw new Error(`Duplicate metric definition: ${identity}`);
    seen.add(identity);
  }
  return Object.freeze(parsed);
}

const invalidLegacyDefaults = {
  grain: "eligible_customer",
  sourceFacts: ["legacy_admin_analytics"] as const,
  sourceEvents: ["legacy.unversioned.event"] as const,
  requiredTrustClasses: ["canonical"] as const,
  exclusions: ["internal actors", "fixture data", "non-production data"] as const,
  cohort: "legacy cohort pending canonical v2 backfill",
  timezone: "UTC",
  maturity: "not certified",
  dedupe: "legacy dedupe is not decision-grade",
  attributionRule: "none",
  owner: "Growth Analytics",
  version: 1,
  effectiveAt: "2026-07-11T00:00:00.000Z",
  freshnessSlo: { maxAgeSeconds: 86400 },
  qualityState: "invalid" as const,
  decisionUse: "blocked" as const,
  lastValidatedAt: null,
  validationEvidence: [] as const,
};

export const ADMIN_METRIC_REGISTRY = defineMetricRegistry([
  {
    ...invalidLegacyDefaults,
    key: "legacy.activated_users",
    name: "Activated users (legacy)",
    description: "Legacy activated-user count retained for comparison only.",
    businessQuestion: "How does the legacy activation proxy compare with canonical activation?",
    numerator: "users matching the legacy activation proxy",
    denominator: "eligible signup cohort",
    window: "legacy implementation window",
    queryHash: "pending:legacy-activated-v1",
  },
  {
    ...invalidLegacyDefaults,
    key: "legacy.signup_to_paid_conversion",
    name: "Signup-to-paid conversion (legacy)",
    description: "Legacy conversion ratio without a certified cohort contract.",
    businessQuestion: "What did the legacy console label as conversion?",
    numerator: "legacy paying users",
    denominator: "legacy signups",
    window: "legacy implementation window",
    queryHash: "pending:legacy-conversion-v1",
  },
  {
    ...invalidLegacyDefaults,
    key: "legacy.same_character_d1",
    name: "Same-character D1 (legacy)",
    description: "Legacy D1 value pending QCE v1 and exact-day certification.",
    businessQuestion: "Do qualified pairs return to the same character on exact D0+1?",
    numerator: "legacy returning pairs",
    denominator: "legacy first-activity pair cohort",
    window: "exact D0+1 target; legacy implementation unverified",
    queryHash: "pending:legacy-d1-v1",
  },
  {
    ...invalidLegacyDefaults,
    key: "legacy.same_character_d7",
    name: "Same-character D7 (legacy)",
    description: "Legacy D7 value pending QCE v1 and exact-day certification.",
    businessQuestion: "Do qualified pairs return to the same character on exact D0+7?",
    numerator: "legacy returning pairs",
    denominator: "legacy first-activity pair cohort",
    window: "exact D0+7 target; legacy implementation unverified",
    queryHash: "pending:legacy-d7-v1",
  },
  {
    key: "flag_monitoring.exposure",
    name: "Flag Monitoring",
    description: "Directional monitoring for feature flags without randomized assignment and exposure facts.",
    businessQuestion: "Are operational outcomes changing while a feature flag is active?",
    numerator: "observed outcome events associated with the active flag window",
    denominator: "eligible observations in the flag window",
    grain: "flag_window",
    sourceFacts: ["feature_flag_state", "canonical_product_event"],
    sourceEvents: ["feature.flag.changed.v1", "product.event.v2"],
    requiredTrustClasses: ["canonical"],
    exclusions: ["internal actors", "fixture data", "non-production data"],
    cohort: "eligible observations while flag state is active",
    window: "operator-selected flag monitoring window",
    timezone: "UTC",
    maturity: "after the selected observation window closes",
    dedupe: "canonical source key",
    attributionRule: "correlation only; no causal claim",
    owner: "Growth Analytics",
    version: 1,
    effectiveAt: "2026-07-11T00:00:00.000Z",
    queryHash: "pending:flag-monitoring-v1",
    freshnessSlo: { maxAgeSeconds: 3600 },
    qualityState: "directional",
    decisionUse: "directional_only",
    lastValidatedAt: null,
    validationEvidence: [],
  },
]);
