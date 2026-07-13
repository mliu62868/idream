import type { Prisma } from "@prisma/client";
import { generationWorkflowDescriptor } from "@/server/modules/admin/generation-catalog";
import { evaluateRouteQualification } from "./release-monitor";

export const QUALIFIED_ROUTE_MINIMUM_SAMPLE_COUNT = 40;
export const QUALIFIED_ROUTE_MINIMUM_IDENTITY_MATCH = 0.9;

type QualificationStore = Pick<Prisma.TransactionClient, "generationModelProfile" | "generationRouteQualification">;

export async function findQualifiedGenerationRoute(
  db: QualificationStore,
  input: { style: string; policyVersion: string; evaluatorVersion: string; at: Date },
) {
  const candidates = await db.generationRouteQualification.findMany({
    where: {
      style: input.style,
      result: "qualified",
      sampleCount: { gte: QUALIFIED_ROUTE_MINIMUM_SAMPLE_COUNT },
      identityMatch: { gte: QUALIFIED_ROUTE_MINIMUM_IDENTITY_MATCH },
    },
    orderBy: { evaluatedAt: "desc" },
    take: 20,
  });
  for (const candidate of candidates) {
    if (evaluateRouteQualification({
      qualification: candidate,
      currentPolicyVersion: input.policyVersion,
      currentEvaluatorVersion: input.evaluatorVersion,
      now: input.at,
    }).state !== "qualified") continue;
    const [profile, workflow] = await Promise.all([
      db.generationModelProfile.findFirst({
        where: {
          profileKey: candidate.generationProfileKey,
          version: candidate.generationProfileVersion,
          status: "active",
        },
      }),
      generationWorkflowDescriptor(candidate.workflowKey),
    ]);
    if (
      profile
      && (profile.workflowKey ?? profile.pipelineModel) === candidate.workflowKey
      && workflow?.version === candidate.workflowVersion
    ) return candidate;
  }
  return null;
}
