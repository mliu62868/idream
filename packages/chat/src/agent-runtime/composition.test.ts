import { describe, expect, it } from "vitest";
import {
  COMPANION_CORE_PACKAGES,
  assertCompanionExecutionManifest,
  companionCompositionDigest,
  companionCompositionManifest,
  companionIgrepConfig,
  companionIgrepRoutes,
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
      schemaVersion: 3, piVersion: "1.3.0", igrepVersion: "0.1.161", storage: "memory", builtInTools: [],
      igrepMaintenance: { sampling: { temperature: 0, top_p: 1, presence_penalty: 0 } },
      execution: { version: 30, maxSteps: 8, maxParallelToolCalls: 1, toolExecution: "sequential", retry: false,
        deadlineSource: "invocation.deadlineAt", commitBeforeProjection: true },
    });
    expect(manifest.corePackages).toEqual(COMPANION_CORE_PACKAGES);
    expect(() => assertCompanionExecutionManifest({ ...manifest, builtInTools: ["shell"] })).toThrow();
    expect(() => assertCompanionExecutionManifest({ ...manifest, storage: "sqlite" })).toThrow();
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

  it("builds an immutable plan without mutating the explicit retrieval policy", () => {
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


describe("explicit web composition identity", () => {
  const authority = {maxSteps:8,igrepLlm:{url:"https://maintenance.example/v1",model:"maintenance"}};
  const env = {IGREP_WEB_SEARCH_PROVIDER:"searxng",IGREP_SEARXNG_URL:"https://search.example",IGREP_SEARXNG_API_KEY:"private-key"};
  const digest = (environment: Record<string,string>) => companionCompositionDigest("private",companionIgrepConfig("private","igrep",environment),{...authority,igrepRoutes:companionIgrepRoutes(environment)});
  it("includes explicit web registration and route policy but never the credential", () => {
    const config = companionIgrepConfig("private","igrep",env);
    expect(config.web).toMatchObject({provider:"searxng",url:"https://search.example",mode:"fast",maxResults:6,timeoutMs:30000});
    expect(companionIgrepConfig("private","igrep").web).toBe(false);
    expect(digest(env)).not.toBe(digest({}));
    expect(digest(env)).not.toBe(digest({...env,IGREP_SEARXNG_URL:"https://other.example"}));
    expect(digest(env)).toBe(digest({...env,IGREP_SEARXNG_API_KEY:"rotated-key"}));
    expect(JSON.stringify(companionCompositionManifest("private",config,{...authority,igrepRoutes:companionIgrepRoutes(env)}))).not.toContain("private-key");
  });
});
