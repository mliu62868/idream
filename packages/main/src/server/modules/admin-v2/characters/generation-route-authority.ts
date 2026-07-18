import type {
  GenerationRouteQualification,
  Prisma,
} from "@prisma/client";
import {
  assignWorkflowReferenceSlots,
  type WorkflowReferenceRole,
} from "@idream/shared/gen-workflow";
import { generationWorkflowDescriptor } from "@/server/modules/admin/generation-catalog";

type GenerationRouteAuthorityStore = Pick<
  Prisma.TransactionClient,
  "generationModelProfile"
>;

export const generationSourceVariationBlockers = [
  "no_qualified_route",
  "profile_init_image_unsupported",
  "workflow_source_image_unsupported",
  "workflow_source_identity_combination_unsupported",
  "reference_capacity_insufficient",
  "reference_slot_assignment_unsupported",
] as const;

export type GenerationSourceVariationBlocker =
  (typeof generationSourceVariationBlockers)[number];

export function normalizedGenerationReferenceRole(role: string) {
  if (role === "primary_face" || role === "identity_anchor") {
    return "identity_anchor" as const;
  }
  if (role === "identity_reference") return "identity_reference" as const;
  if (role === "look_reference") return "look_reference" as const;
  if (role === "source_image") return "source_image" as const;
  return null;
}

type GenerationWorkflowRuntimeView = {
  readonly version: number;
  readonly backendKind: string;
  readonly capabilities: readonly string[];
  readonly identity: {
    readonly mode: string;
    readonly maxReferences: number;
    readonly acceptedRoles: readonly WorkflowReferenceRole[];
    readonly supportsLookReference?: boolean;
    readonly supportsSourceImageWithIdentity?: boolean;
  };
  readonly inputs: readonly {
    readonly key: string;
    readonly type: string;
    readonly referenceRoles?: readonly WorkflowReferenceRole[];
    readonly required?: boolean;
  }[];
};

function generationWorkflowReferenceSlotAuthority(
  workflow: GenerationWorkflowRuntimeView,
  roles: readonly WorkflowReferenceRole[],
) {
  return assignWorkflowReferenceSlots({
    backendKind: workflow.backendKind,
    identity: workflow.identity,
    inputs: workflow.inputs,
  }, roles);
}

/**
 * One runtime truth for a More-like request. A qualified Character route must
 * already preserve canonical identity references. A source variation adds a
 * distinct init-image input without replacing those canonical references.
 */
export function generationSourceVariationAuthority(input: {
  readonly routeFingerprint: string | null;
  readonly routeQualified: boolean;
  readonly workflow: GenerationWorkflowRuntimeView | null;
  readonly qualificationWorkflowVersion: number;
  readonly profileCapabilities: unknown;
  readonly canonicalReferenceRoles: readonly string[];
  readonly sourceReferenceCount: number;
}) {
  const profileCapabilities = record(input.profileCapabilities);
  const workflow = input.workflow;
  const canonicalRoles = input.canonicalReferenceRoles.map(
    normalizedGenerationReferenceRole,
  );
  const requestedRoles = [
    ...canonicalRoles.filter((role): role is WorkflowReferenceRole => role !== null),
    ...Array.from(
      { length: input.sourceReferenceCount },
      () => "source_image" as const,
    ),
  ];
  let blocker: GenerationSourceVariationBlocker | null = null;
  if (
    !input.routeQualified ||
    !workflow ||
    workflow.version !== input.qualificationWorkflowVersion ||
    workflow.identity.mode === "none" ||
    !workflow.capabilities.includes("referenceImages") ||
    profileCapabilities.referenceImages !== true ||
    canonicalRoles.some((role) => role === null) ||
    canonicalRoles.some((role) =>
      role !== null && !workflow.identity.acceptedRoles.includes(role)
    )
  ) {
    blocker = "no_qualified_route";
  } else if (profileCapabilities.initImage !== true) {
    blocker = "profile_init_image_unsupported";
  } else if (!workflow.identity.acceptedRoles.includes("source_image")) {
    blocker = "workflow_source_image_unsupported";
  } else if (
    input.canonicalReferenceRoles.length > 0 &&
    input.sourceReferenceCount > 0 &&
    !workflow.identity.supportsSourceImageWithIdentity
  ) {
    blocker = "workflow_source_identity_combination_unsupported";
  } else {
    const slotAuthority = generationWorkflowReferenceSlotAuthority(
      workflow,
      requestedRoles,
    );
    if (!slotAuthority.ok) {
      blocker = slotAuthority.reason === "reference_cardinality_mismatch"
        ? "reference_capacity_insufficient"
        : "reference_slot_assignment_unsupported";
    }
  }
  return {
    routeFingerprint: input.routeFingerprint,
    ready: blocker === null,
    blocker,
  } as const;
}

export function generationRouteRuntimeCompatibility(input: {
  readonly workflow: GenerationWorkflowRuntimeView | null;
  readonly qualificationWorkflowVersion: number;
  readonly profileCapabilities: unknown;
  readonly requiredReferenceCount?: number;
  readonly requiredReferenceRoles?: readonly string[];
}) {
  const capabilities = record(input.profileCapabilities);
  const workflow = input.workflow;
  if (
    !workflow ||
    workflow.version !== input.qualificationWorkflowVersion ||
    workflow.identity.mode === "none" ||
    workflow.identity.maxReferences < 1 ||
    !workflow.capabilities.includes("referenceImages") ||
    capabilities.referenceImages !== true
  ) {
    return "generation_workflow_unavailable" as const;
  }
  const requiredReferenceRoles = input.requiredReferenceRoles?.map(
    normalizedGenerationReferenceRole,
  );
  if (
    requiredReferenceRoles?.some((role) => role === null) ||
    requiredReferenceRoles?.some((role) =>
      role !== null && !workflow.identity.acceptedRoles.includes(role)
    )
  ) {
    return "generation_route_reference_role_unsupported" as const;
  }
  if (
    input.requiredReferenceCount !== undefined &&
    (
      !requiredReferenceRoles ||
      requiredReferenceRoles.length !== input.requiredReferenceCount
    )
  ) {
    return "generation_route_reference_role_unsupported" as const;
  }
  if (requiredReferenceRoles) {
    const slotAuthority = generationWorkflowReferenceSlotAuthority(
      workflow,
      requiredReferenceRoles.filter(
        (role): role is WorkflowReferenceRole => role !== null,
      ),
    );
    if (!slotAuthority.ok) {
      return slotAuthority.reason === "reference_cardinality_mismatch"
        ? "generation_route_reference_capacity_insufficient" as const
        : "generation_route_reference_slot_assignment_unsupported" as const;
    }
  }
  return null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function evaluateRouteQualification(input: {
  readonly qualification: {
    readonly result: string;
    readonly sampleCount: number;
    readonly identityMatch: number;
    readonly policyVersion: string;
    readonly expiresAt: Date | null;
    readonly evidence: Prisma.JsonValue;
  } | null;
  readonly currentPolicyVersion: string;
  readonly currentEvaluatorVersion: string;
  readonly now: Date;
}) {
  const qualification = input.qualification;
  if (!qualification) {
    return { state: "unqualified" as const, reason: "missing_qualification" };
  }
  if (
    qualification.expiresAt &&
    qualification.expiresAt.getTime() <= input.now.getTime()
  ) {
    return { state: "expired" as const, reason: "qualification_expired" };
  }
  if (qualification.policyVersion !== input.currentPolicyVersion) {
    return { state: "stale" as const, reason: "policy_version_changed" };
  }
  if (
    record(qualification.evidence).evaluatorVersion !==
    input.currentEvaluatorVersion
  ) {
    return { state: "stale" as const, reason: "evaluator_version_changed" };
  }
  if (
    qualification.result !== "qualified" ||
    qualification.sampleCount < 40 ||
    qualification.identityMatch < 0.9
  ) {
    return {
      state: "unqualified" as const,
      reason: "qualification_threshold_failed",
    };
  }
  return { state: "qualified" as const, reason: null };
}

export async function evaluateEffectiveGenerationRouteAuthority(
  db: GenerationRouteAuthorityStore,
  input: {
    readonly qualification: GenerationRouteQualification | null;
    readonly currentPolicyVersion: string;
    readonly currentEvaluatorVersion: string;
    readonly now: Date;
    readonly requiredReferenceCount?: number;
    readonly requiredReferenceRoles?: readonly string[];
  },
) {
  const qualificationState = evaluateRouteQualification(input);
  if (qualificationState.state !== "qualified" || !input.qualification) {
    return qualificationState;
  }
  const qualification = input.qualification;
  const [profile, workflow] = await Promise.all([
    db.generationModelProfile.findFirst({
      where: {
        profileKey: qualification.generationProfileKey,
        version: qualification.generationProfileVersion,
        status: "active",
      },
    }),
    generationWorkflowDescriptor(qualification.workflowKey),
  ]);
  if (!profile || !profile.enabled || profile.rolloutPercent <= 0) {
    return {
      state: "unqualified" as const,
      reason: "generation_profile_unavailable",
    };
  }
  if (
    (profile.workflowKey ?? profile.pipelineModel) !==
    qualification.workflowKey
  ) {
    return {
      state: "unqualified" as const,
      reason: "generation_profile_workflow_changed",
    };
  }
  const runtimeIncompatibility = generationRouteRuntimeCompatibility({
    workflow,
    qualificationWorkflowVersion: qualification.workflowVersion,
    profileCapabilities: record(profile.runnerConfig).capabilities,
    requiredReferenceCount: input.requiredReferenceCount,
    requiredReferenceRoles: input.requiredReferenceRoles,
  });
  if (runtimeIncompatibility) {
    return {
      state: "unqualified" as const,
      reason: runtimeIncompatibility,
    };
  }
  return { state: "qualified" as const, reason: null };
}
