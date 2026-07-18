import type { GenerationRouteQualification, Prisma } from "@prisma/client";
import { evaluateEffectiveGenerationRouteAuthority } from "./generation-route-authority";

export const QUALIFIED_ROUTE_MINIMUM_SAMPLE_COUNT = 40;
export const QUALIFIED_ROUTE_MINIMUM_IDENTITY_MATCH = 0.9;

type QualificationStore = Pick<Prisma.TransactionClient, "generationModelProfile" | "generationRouteQualification">;

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
        sampleCount: { gte: QUALIFIED_ROUTE_MINIMUM_SAMPLE_COUNT },
        identityMatch: { gte: QUALIFIED_ROUTE_MINIMUM_IDENTITY_MATCH },
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
