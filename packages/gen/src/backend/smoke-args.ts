import {
  workflowReferenceRoleSchema,
  type WorkflowReferenceRole,
} from "./workflow";

export type SmokeReference = {
  path: string;
  role: WorkflowReferenceRole;
};

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
