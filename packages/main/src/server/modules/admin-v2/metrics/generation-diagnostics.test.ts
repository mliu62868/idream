import { describe, expect, it } from "vitest";
import {
  summarizeGenerationDiagnostics, timingDistribution,
  type DiagnosticJob, type DiagnosticAttempt, type DiagnosticTransport,
} from "./generation-diagnostics";

const start = new Date("2026-09-06T12:00:00.000Z");
const after = (milliseconds: number) => new Date(start.getTime() + milliseconds);
const job = (id: string, dataClass = "audit"): DiagnosticJob => ({
  id, dataClass, mode: "image", status: "completed", sourceType: "generator",
  profileId: "default-image", profileVersion: 2, model: "requested-model", provider: "workflow-native",
  createdAt: start, completedAt: after(100_000), finishedAt: after(100_000),
});
const attempt = (id: string, requestId: string, attemptNo = 1): DiagnosticAttempt => ({
  id, requestId, attemptNo, profileKey: "default-image", profileVersion: 2,
  workflowKey: "image-workflow", workflowVersion: 3, provider: "workflow-native",
  status: "succeeded", createdAt: start, startedAt: after(30_000),
});
const transport = (id: string, attemptId: string, latencyMs: number | null): DiagnosticTransport => ({
  id, attemptId, transportAttemptNo: 1, status: "succeeded", latencyMs,
  startedAt: after(30_000), finishedAt: after(90_000),
});

describe("generation operational diagnostics", () => {
  it("reports missing observations as null and uses nearest-rank percentiles", () => {
    expect(timingDistribution([])).toEqual({ samples: 0, missing: 0, p50Ms: null, p95Ms: null });
    expect(timingDistribution([null, -1, Number.NaN])).toEqual({ samples: 0, missing: 3, p50Ms: null, p95Ms: null });
    expect(timingDistribution([10, 100, 30, 20, null])).toEqual({ samples: 4, missing: 1, p50Ms: 20, p95Ms: 100 });
  });

  it("keeps audit, customer and workflow versions separate and never invents invocation latency", () => {
    const jobs = [job("audit"), job("customer", "customer"), job("new-workflow")];
    const attempts = [attempt("a", "audit"), attempt("c", "customer"), { ...attempt("n", "new-workflow"), workflowVersion: 4 }];
    const groups = summarizeGenerationDiagnostics({
      jobs, attempts, transports: [transport("at", "a", 60_000), transport("ct", "c", 90_000), transport("nt", "n", null)], usage: [],
    });
    expect(groups).toHaveLength(3);
    expect(groups.find((group) => group.dataClass === "customer")?.executionMs).toMatchObject({ samples: 1, p50Ms: 90_000 });
    const unmeasured = groups.find((group) => group.workflowVersion === 4)!;
    expect(unmeasured.executionMs).toEqual({ samples: 0, missing: 1, p50Ms: null, p95Ms: null });
    expect(unmeasured.queueMs).toMatchObject({ samples: 1, p50Ms: 30_000 });
    expect(unmeasured.invocationEvidence[0].performance).toBeNull();
  });

  it("assigns request completion once to the final attempt and preserves recorded performance without filling gaps", () => {
    const performance = {
      resourceWaitMs: 29_000, runnerPreparationMs: 300, artifactPersistenceMs: 500, totalMs: 90_000,
      requests: [{ providerRequestId: "provider-1", prepareMs: 50, submitMs: 20, waitMs: 60_000,
        downloadMs: 100, validationMs: 20, providerExecutionMs: null, cachedNodeCount: null }],
    };
    const groups = summarizeGenerationDiagnostics({
      jobs: [job("retried")],
      attempts: [{ ...attempt("old", "retried"), profileVersion: 1, status: "failed" }, attempt("final", "retried", 2)],
      transports: [{ ...transport("ot", "old", 1_000), status: "failed" }, transport("ft", "final", 60_000)],
      usage: [{ transportExecutionId: "ft", provider: "workflow-native", model: "actual-model", usage: { performance } }],
    });
    expect(groups.find((group) => group.profileVersion === 1)).toMatchObject({
      jobs: { samples: 0 }, attempts: { samples: 1, statuses: { failed: 1 } },
      endToEndMs: { samples: 0, p50Ms: null },
    });
    const completed = groups.find((group) => group.profileVersion === 2)!;
    expect(completed.jobs).toEqual({ samples: 1, statuses: { completed: 1 } });
    expect(completed.endToEndMs).toMatchObject({ samples: 1, p50Ms: 100_000 });
    expect(completed.resourceWaitMs).toMatchObject({ samples: 1, p50Ms: 29_000 });
    expect(completed.invocationEvidence[0]).toMatchObject({ model: "actual-model", performance });
    expect(completed.invocationEvidence[0].performance).toEqual(performance);
  });
});
