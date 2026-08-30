import {
  workflowReferenceRoleSchema,
  type WorkflowReferenceRole,
} from "./workflow";

export type SmokeReference = {
  path: string;
  role: WorkflowReferenceRole;
};

export type SmokeGenerationOverrides = {
  seed?: string;
  steps?: number;
  refBoost?: number;
  groundingPx?: number;
};

type SmokeWorkflowPin = {
  readonly modelId: string;
  readonly workflowKey: string;
  readonly version: number;
};

// INVARIANT: the live smoke exercises the same immutable workflow pin that Main
// records on a real Attempt. A model id without workflowKey@version would now be
// rejected by BackendImageModel before ComfyUI submission.
export function resolveSmokeWorkflowPin(
  descriptors: readonly SmokeWorkflowPin[],
  requested: string,
) {
  const descriptor = descriptors.find(
    (candidate) =>
      candidate.modelId === requested || candidate.workflowKey === requested,
  );
  if (!descriptor) {
    throw new Error(`no workflow descriptor found for --model ${requested}`);
  }
  return {
    modelId: descriptor.modelId,
    workflowKey: descriptor.workflowKey,
    workflowVersion: descriptor.version,
  };
}

export function resolveSmokeGenerationOverrides(
  argv: string[],
): SmokeGenerationOverrides {
  const seeds = repeatedFlagValues(argv, "--seed");
  const stepValues = repeatedFlagValues(argv, "--steps");
  const refBoostValues = repeatedFlagValues(argv, "--ref-boost");
  const groundingPxValues = repeatedFlagValues(argv, "--grounding-px");
  if (seeds.length > 1) throw new Error("--seed may only be specified once");
  if (stepValues.length > 1) {
    throw new Error("--steps may only be specified once");
  }
  if (refBoostValues.length > 1) {
    throw new Error("--ref-boost may only be specified once");
  }
  if (groundingPxValues.length > 1) {
    throw new Error("--grounding-px may only be specified once");
  }

  const rawSteps = stepValues[0];
  const steps = rawSteps === undefined ? undefined : Number(rawSteps);
  if (
    steps !== undefined &&
    (!Number.isSafeInteger(steps) || steps <= 0)
  ) {
    throw new Error("--steps must be a positive integer");
  }
  const rawRefBoost = refBoostValues[0];
  const refBoost = rawRefBoost === undefined
    ? undefined
    : Number(rawRefBoost);
  if (
    refBoost !== undefined &&
    (!Number.isFinite(refBoost) || refBoost < 0)
  ) {
    throw new Error("--ref-boost must be a non-negative number");
  }
  const rawGroundingPx = groundingPxValues[0];
  const groundingPx = rawGroundingPx === undefined
    ? undefined
    : Number(rawGroundingPx);
  if (
    groundingPx !== undefined &&
    (!Number.isSafeInteger(groundingPx) || groundingPx < 0)
  ) {
    throw new Error("--grounding-px must be a non-negative integer");
  }

  return {
    ...(seeds[0] === undefined ? {} : { seed: seeds[0] }),
    ...(steps === undefined ? {} : { steps }),
    ...(refBoost === undefined ? {} : { refBoost }),
    ...(groundingPx === undefined ? {} : { groundingPx }),
  };
}

export function resolveSmokeReferences(argv: string[]): SmokeReference[] {
  const paths = repeatedFlagValues(argv, "--ref");
  const roleValues = repeatedFlagValues(argv, "--ref-role");

  if (paths.length === 0) {
    if (roleValues.length > 0) {
      throw new Error("--ref-role requires a matching --ref");
    }
    return [];
  }

  if (paths.length === 1 && roleValues.length === 0) {
    return [{ path: paths[0]!, role: "source_image" }];
  }

  if (roleValues.length !== paths.length) {
    throw new Error(
      "multiple references require exactly one --ref-role per reference",
    );
  }

  return paths.map((referencePath, index) => {
    const roleValue = roleValues[index]!;
    const role = workflowReferenceRoleSchema.safeParse(roleValue);
    if (!role.success) {
      throw new Error(`unsupported --ref-role ${roleValue}`);
    }
    return { path: referencePath, role: role.data };
  });
}

function repeatedFlagValues(argv: string[], flag: string): string[] {
  const prefix = `${flag}=`;
  const values: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument.startsWith(prefix)) {
      const value = argument.slice(prefix.length).trim();
      if (!value) throw new Error(`${flag} requires a value`);
      values.push(value);
      continue;
    }
    if (argument !== flag) continue;

    const value = argv[index + 1]?.trim();
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    values.push(value);
    index += 1;
  }

  return values;
}
