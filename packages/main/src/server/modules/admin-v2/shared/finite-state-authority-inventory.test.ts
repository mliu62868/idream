import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(path, "utf8");
}

const productionTypeScript = globSync("src/**/*.ts")
  .filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".integration.test.ts"));

describe("Admin v2 finite-state authority inventory", () => {
  it("binds every Character Project phase writer to the phase authority", () => {
    const writers = productionTypeScript.filter((path) => {
      const contents = source(path);
      return /characterProject\.update(?:Many)?\(\{[\s\S]{0,600}?data:\s*\{[\s\S]{0,400}?phase:/.test(contents);
    });
    expect(writers.sort()).toEqual([
      "src/server/modules/admin-v2/characters/release-executor.ts",
      "src/server/modules/admin-v2/characters/release-lifecycle.ts",
    ]);
    for (const path of writers) {
      expect(source(path), path).toContain("isCharacterProjectPhaseTransitionAllowed");
    }
  });

  it("binds every Creative Run workflow or verification writer to both independent authorities", () => {
    const writers = productionTypeScript.filter((path) => {
      const contents = source(path);
      return /contentProductionBatch\.update(?:Many)?\(\{[\s\S]{0,500}?data:\s*\{[\s\S]{0,500}?(?:workflowStage|verificationState):/.test(contents);
    });
    expect(writers.sort()).toEqual([
      "src/server/modules/admin-v2/creative/retry-executor.ts",
      "src/server/modules/admin-v2/creative/workflow.ts",
    ]);
    for (const path of writers) {
      expect(source(path), path).toContain("isCreativeRunWorkflowTransitionAllowed");
      expect(source(path), path).toContain("isCreativeRunVerificationTransitionAllowed");
    }
    expect(source("src/server/modules/admin-v2/creative/workflow.ts")).toContain(
      "isCreativePlacementVerificationTransitionAllowed",
    );
  });

  it("funnels every ControlPlaneCommandAttempt mutation through one CAS authority", () => {
    const directWriters = productionTypeScript.filter((path) =>
      /controlPlaneCommandAttempt\.(?:update|updateMany)\(/.test(source(path)),
    );
    expect(directWriters).toEqual([
      "src/server/modules/admin-v2/shared/control-plane-command-attempt.ts",
    ]);
    const authority = source(directWriters[0]);
    expect(authority).toContain("isControlPlaneCommandAttemptTransitionAllowed");
    expect(authority).toContain("status: current.status");
  });

  it("excludes Creative execution, review, and deployment views because they are derived and not persisted axes", () => {
    const schema = source("prisma/schema.prisma");
    const batch = schema.match(/model ContentProductionBatch \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;
    expect(batch).toBeDefined();
    expect(batch).not.toMatch(/\bexecutionOutcome\b/);
    expect(batch).not.toMatch(/\breviewState\b/);
    expect(batch).not.toMatch(/\bdeploymentState\b/);
    const derivation = source("src/server/modules/admin/content-production-state.ts");
    expect(derivation).toContain("reviewState");
    expect(derivation).toContain("deploymentState");
    expect(derivation).toContain("executionOutcome");
  });
});
