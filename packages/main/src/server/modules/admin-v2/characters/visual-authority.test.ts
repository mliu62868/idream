import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

const catalog = vi.hoisted(() => ({
  generationWorkflowDescriptor: vi.fn(),
}));

vi.mock("@/server/modules/generation/generation-catalog", () => ({
  generationWorkflowDescriptor: catalog.generationWorkflowDescriptor,
}));

import { findOperationalGenerationRoute } from "./visual-authority";

async function workflow(key: string) {
  return JSON.parse(
    await readFile(path.resolve(process.cwd(), `../gen/workflows/${key}.json`), "utf8"),
  );
}

function imageProfile(profileKey: string, workflowKey: string, costMultiplier: number) {
  return {
    profileKey,
    version: 1,
    workflowKey,
    pipelineModel: workflowKey,
    costMultiplier,
    requiredEntitlement: null,
    allowedOrientations: ["4:5"],
    runnerConfig: { capabilities: { textToImage: true, referenceImages: true } },
  };
}

describe("operational Character generation route", () => {
  // SPEC: without a qualified route, Admin production uses the same order as
  // public automatic selection — cheapest compatible profile first — so the
  // default REDQW21 profile, not an alphabetically earlier legacy route, owns
  // single-anchor Character images.
  it("prefers the cheapest compatible profile over profile key order", async () => {
    const workflows = await Promise.all(
      ["redqw21", "redcraft-krea2-identity-edit", "qwen-image-edit-multi-identity"].map(workflow),
    );
    catalog.generationWorkflowDescriptor.mockImplementation(async (key: string) =>
      workflows.find((candidate) => candidate.workflowKey === key) ?? null,
    );
    const db = {
      generationRouteQualification: { findMany: vi.fn(async () => []) },
      generationModelProfile: {
        findMany: vi.fn(async () => [
          imageProfile("character-image-multi-identity", "qwen-image-edit-multi-identity", 1.4),
          imageProfile("character-image-single-identity-redcraft", "redcraft-krea2-identity-edit", 1.3),
          imageProfile("profile_image_default_v1", "redqw21", 1),
        ]),
      },
    };

    const route = await findOperationalGenerationRoute(db as never, {
      style: "realistic",
      policyVersion: "policy",
      evaluatorVersion: "evaluator",
      at: new Date("2026-09-25T00:00:00.000Z"),
      requiredReferenceCount: 1,
      requiredReferenceRoles: ["identity_anchor"],
    });

    expect(route).toMatchObject({
      generationProfileKey: "profile_image_default_v1",
      workflowKey: "redqw21",
    });
  });

  it("does not let a materialized operator route pin production to an older profile", async () => {
    const workflows = await Promise.all(["redqw21", "redcraft-krea2-identity-edit"].map(workflow));
    catalog.generationWorkflowDescriptor.mockImplementation(async (key: string) =>
      workflows.find((candidate) => candidate.workflowKey === key) ?? null,
    );
    const db = {
      generationRouteQualification: {
        findMany: vi.fn(async () => [{
          id: "old-operator-route",
          routeFingerprint: "old",
          generationProfileKey: "character-image-single-identity-redcraft",
          generationProfileVersion: 1,
          workflowKey: "redcraft-krea2-identity-edit",
          workflowVersion: 5,
          style: "realistic",
          matrixKey: "operator-single-image-v1",
          sampleCount: 0,
          passCount: 0,
          identityMatch: 1,
          result: "qualified",
          evidence: { authorityMode: "operator_single_image", evaluatorVersion: "evaluator" },
          policyVersion: "policy",
          evaluatedAt: new Date("2026-09-02T00:00:00.000Z"),
          expiresAt: null,
        }]),
      },
      generationModelProfile: {
        findMany: vi.fn(async () => [
          imageProfile("character-image-single-identity-redcraft", "redcraft-krea2-identity-edit", 1.3),
          imageProfile("profile_image_default_v1", "redqw21", 1),
        ]),
        // The old route is still fully valid: its profile stays active so
        // Releases pinned to it keep serving.
        findFirst: vi.fn(async () => ({
          ...imageProfile("character-image-single-identity-redcraft", "redcraft-krea2-identity-edit", 1.3),
          enabled: true,
          rolloutPercent: 100,
        })),
      },
    };

    const route = await findOperationalGenerationRoute(db as never, {
      style: "realistic",
      policyVersion: "policy",
      evaluatorVersion: "evaluator",
      at: new Date("2026-09-29T00:00:00.000Z"),
      requiredReferenceCount: 1,
      requiredReferenceRoles: ["identity_anchor"],
    });

    expect(route).toMatchObject({ generationProfileKey: "profile_image_default_v1" });
  });
});
