import type { GenerationRouteQualification, Prisma } from "@prisma/client";
import {
  evaluateEffectiveGenerationRouteAuthority,
  generationRouteRuntimeCompatibility,
  OPERATOR_SINGLE_IMAGE_ROUTE_MATRIX_KEY,
} from "./generation-route-authority";
import { generationWorkflowDescriptor } from "@/server/modules/admin/generation-catalog";
import { canonicalSha256 } from "../shared/canonical-json";
import { toInputJson } from "../shared/prisma-json";

export const QUALIFIED_ROUTE_MINIMUM_SAMPLE_COUNT = 40;
export const QUALIFIED_ROUTE_MINIMUM_IDENTITY_MATCH = 0.9;
type QualificationStore = Pick<Prisma.TransactionClient, "generationModelProfile" | "generationRouteQualification">;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function strings(value: Prisma.JsonValue | null | undefined) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export async function findQualifiedGenerationRoute(
  db: QualificationStore,
  input: {
    style: string;
    policyVersion: string;
    evaluatorVersion: string;
    at: Date;
    requiredReferenceCount?: number;
    requiredReferenceRoles?: readonly string[];
  },
) {
  const pageSize = 20;
  let boundary: { readonly evaluatedAt: Date; readonly id: string } | null = null;
  while (true) {
    const candidates: GenerationRouteQualification[] =
      await db.generationRouteQualification.findMany({
      where: {
        style: input.style,
        result: "qualified",
        policyVersion: input.policyVersion,
        OR: [{ expiresAt: null }, { expiresAt: { gt: input.at } }],
        ...(boundary ? {
          AND: [{
            OR: [
              { evaluatedAt: { lt: boundary.evaluatedAt } },
              { evaluatedAt: boundary.evaluatedAt, id: { lt: boundary.id } },
            ],
          }],
        } : {}),
      },
      orderBy: [{ evaluatedAt: "desc" }, { id: "desc" }],
      take: pageSize,
    });
    for (const candidate of candidates) {
      const effective = await evaluateEffectiveGenerationRouteAuthority(db, {
        qualification: candidate,
        currentPolicyVersion: input.policyVersion,
        currentEvaluatorVersion: input.evaluatorVersion,
        now: input.at,
        requiredReferenceCount: input.requiredReferenceCount,
        requiredReferenceRoles: input.requiredReferenceRoles,
      });
      if (effective.state === "qualified") return candidate;
    }
    if (candidates.length < pageSize) return null;
    const last: GenerationRouteQualification = candidates[candidates.length - 1]!;
    boundary = { evaluatedAt: last.evaluatedAt, id: last.id };
  }
}

function operationalRouteFingerprint(input: {
  readonly generationProfileKey: string;
  readonly generationProfileVersion: number;
  readonly workflowKey: string;
  readonly workflowVersion: number;
  readonly style: string;
}) {
  return canonicalSha256(input);
}

async function configuredOperationalGenerationRoute(
  db: QualificationStore,
  input: {
    style: string;
    policyVersion: string;
    evaluatorVersion: string;
    at: Date;
    requiredReferenceCount?: number;
    requiredReferenceRoles?: readonly string[];
  },
) {
  const profiles = await db.generationModelProfile.findMany({
    where: {
      mode: "image",
      status: "active",
      enabled: true,
      rolloutPercent: { gt: 0 },
    },
    orderBy: [
      { publishedAt: "desc" },
      { version: "desc" },
      { profileKey: "asc" },
    ],
    take: 80,
  });
  const ordered = [...profiles].sort((left, right) =>
    Number(Boolean(left.requiredEntitlement)) -
      Number(Boolean(right.requiredEntitlement)) ||
    left.profileKey.localeCompare(right.profileKey) ||
    right.version - left.version
  );
  for (const profile of ordered) {
    const workflowKey = profile.workflowKey ?? profile.pipelineModel;
    const workflow = await generationWorkflowDescriptor(workflowKey);
    const incompatibility = generationRouteRuntimeCompatibility({
      workflow,
      qualificationWorkflowVersion: workflow?.version ?? 0,
      profileCapabilities: record(profile.runnerConfig).capabilities,
      requiredReferenceCount: input.requiredReferenceCount,
      requiredReferenceRoles: input.requiredReferenceRoles,
    });
    if (incompatibility || !workflow) continue;
    const route = {
      generationProfileKey: profile.profileKey,
      generationProfileVersion: profile.version,
      workflowKey,
      workflowVersion: workflow.version,
      style: input.style,
    };
    const routeFingerprint = operationalRouteFingerprint(route);
    return {
      id: `operational:${routeFingerprint}`,
      ...route,
      routeFingerprint,
      matrixKey: OPERATOR_SINGLE_IMAGE_ROUTE_MATRIX_KEY,
      sampleCount: 0,
      passCount: 0,
      identityMatch: 1,
      result: "qualified",
      evidence: {
        evidenceSchemaVersion: "operator-single-image-v1",
        evaluatorVersion: input.evaluatorVersion,
        authorityMode: "operator_single_image",
        generationPolicy: "one_image_per_run",
        reviewPolicy: "operator_reviews_each_image",
      } as Prisma.JsonObject,
      policyVersion: input.policyVersion,
      evaluatedAt: input.at,
      expiresAt: null,
      createdAt: input.at,
      updatedAt: input.at,
      allowedOrientations: strings(profile.allowedOrientations),
    };
  }
  return null;
}

export async function findOperationalGenerationRoute(
  db: QualificationStore,
  input: {
    style: string;
    policyVersion: string;
    evaluatorVersion: string;
    at: Date;
    requiredReferenceCount?: number;
    requiredReferenceRoles?: readonly string[];
  },
) {
  return await findQualifiedGenerationRoute(db, input) ??
    configuredOperationalGenerationRoute(db, input);
}

export async function ensureOperationalGenerationRoute(
  db: QualificationStore,
  input: {
    style: string;
    policyVersion: string;
    evaluatorVersion: string;
    at: Date;
    requiredReferenceCount?: number;
    requiredReferenceRoles?: readonly string[];
  },
) {
  const route = await findOperationalGenerationRoute(db, input);
  if (!route || !route.id.startsWith("operational:")) return route;
  return db.generationRouteQualification.upsert({
    where: {
      routeFingerprint_matrixKey_policyVersion: {
        routeFingerprint: route.routeFingerprint,
        matrixKey: route.matrixKey,
        policyVersion: route.policyVersion,
      },
    },
    update: {},
    create: {
      routeFingerprint: route.routeFingerprint,
      generationProfileKey: route.generationProfileKey,
      generationProfileVersion: route.generationProfileVersion,
      workflowKey: route.workflowKey,
      workflowVersion: route.workflowVersion,
      style: route.style,
      matrixKey: route.matrixKey,
      sampleCount: route.sampleCount,
      passCount: route.passCount,
      identityMatch: route.identityMatch,
      result: route.result,
      evidence: toInputJson(route.evidence),
      policyVersion: route.policyVersion,
    },
  });
}
