import { describe, expect, it } from "vitest";
import {
  COMPANION_EXECUTION_PLUGIN_ORDER,
  FORBIDDEN_COMPANION_EXECUTION_SERVICES,
  companionCompositionDigest,
  companionCompositionManifest,
  createCompanionCompositionPlan,
} from "./composition";

describe("companion composition identity", () => {
  it("pins iDream adapter, bridge and execution policy while excluding paths and secrets", () => {
    const authority = {
      maxSteps: 8,
      igrepLlm: { url: "https://maintenance.example/v1", model: "maintenance-model" },
    };
    const manifest = companionCompositionManifest(
      "normal",
      {
        command: "/opt/idream/igrep/bin/igrep",
        apiKey: "must-not-enter-the-digest",
        search: true,
        memory: true,
        ingest: true,
        wake: true,
      },
      authority,
    );

    expect(manifest).toMatchObject({
      schemaVersion: 2,
      idream: {
        igrepMaintenance: { sampling: { temperature: 0, top_p: 1, presence_penalty: 0 } },
        adapter: { name: "openai-compatible", contractVersion: 1 },
        bridges: {
          preparedTurn: 1,
          tool: 1,
          event: 1,
          commit: 1,
        },
        executionPolicy: {
          version: 9,
          maxSteps: 8,
          maxParallelToolCalls: 1,
          effectfulToolConcurrency: 1,
          deadlineSource: "invocation.deadlineAt",
          commitBeforeProjection: true,
        },
      },
    });
    expect(manifest.pluginOrder).toEqual(COMPANION_EXECUTION_PLUGIN_ORDER);
    expect(manifest.pluginOrder).not.toEqual(expect.arrayContaining(
      [...FORBIDDEN_COMPANION_EXECUTION_SERVICES],
    ));
    expect(JSON.stringify(manifest)).not.toContain("/opt/idream");
    expect(JSON.stringify(manifest)).not.toContain("must-not-enter-the-digest");

    const alternateRuntime = companionCompositionDigest(
      "normal",
      {
        command: "/different/runtime/path/igrep",
        apiKey: "different-secret",
        search: true,
        memory: true,
        ingest: true,
        wake: true,
      },
      authority,
    );
    expect(alternateRuntime).toBe(companionCompositionDigest(
      "normal",
      {
        command: "/opt/idream/igrep/bin/igrep",
        apiKey: "must-not-enter-the-digest",
        search: true,
        memory: true,
        ingest: true,
        wake: true,
      },
      authority,
    ));
    expect(companionCompositionDigest(
      "normal",
      { search: true, memory: true, ingest: true, wake: true },
      { ...authority, maxSteps: 9 },
    )).not.toBe(alternateRuntime);
    expect(companionCompositionDigest(
      "normal",
      { search: true, memory: true, ingest: true, wake: true },
      {
        ...authority,
        igrepLlm: { ...authority.igrepLlm, model: "different-maintenance-model" },
      },
    )).not.toBe(alternateRuntime);
  });

  it("builds an immutable plan without mutating the resolved plugin config", () => {
    const normalized = {
      command: "/opt/idream/igrep/bin/igrep",
      search: true,
      memory: true,
      ingest: true,
      wake: true,
    };
    const authority = {
      maxSteps: 8,
      igrepLlm: { url: "https://maintenance.example/v1", model: "maintenance-model" },
    };

    const plan = createCompanionCompositionPlan("normal", normalized, authority);

    expect(Object.isFrozen(normalized)).toBe(false);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.normalizedIgrepConfig)).toBe(true);
    expect(Object.isFrozen(plan.manifest)).toBe(true);
    expect(plan.digest).toBe(companionCompositionDigest("normal", normalized, authority));
  });
});
