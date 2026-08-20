import { afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  findUser: vi.fn(),
}));

vi.mock("./lib/db", () => ({
  prisma: {
    user: { findUnique: db.findUser },
    $disconnect: vi.fn(async () => undefined),
  },
}));

import {
  DEFAULT_CHAT_SERVICE_PROBE_STREAM_TIMEOUT_MS,
  chatServiceProbeSettleTimeoutMs,
  assertDedicatedChatProbeActor,
  collectProbeRolloutEvidenceBeforeCleanup,
  parseExpectedCompanionRuntime,
  parseExpectedCompanionShadow,
  projectDshCompanionEvidence,
  projectDshShadowEvidence,
  runProbe,
  selectSoulReadyProbeCharacter,
  shadowProbeObservation,
} from "./probe-chat-service";

const auditActor = {
  id: "seed-chat-probe-user",
  dataClass: "audit",
  role: "user",
  status: "active",
  deletedAt: null,
};

function completedShadowEvidence() {
  return {
    schemaVersion: 1,
    status: "completed",
    profileVerified: true,
    primary: { provider: "openai", model: "fixture-model" },
    shadow: {
      provider: "openai",
      model: "fixture-model",
      finishReason: "stop",
      toolCalls: 1,
      dryRunToolCalls: 1,
      steps: 2,
    },
    workspace: {
      memoryMode: "shadow",
      workspaceClass: "shadow",
      disposition: "discarded",
      commitAccepted: false,
      promotionAttempted: false,
    },
  } as const;
}

function completedDshTrace(assignment: Record<string, unknown>) {
  return {
    companionRuntime: {
      runtime: "dsh",
      memoryBackend: "igrep-dsh",
      profile: "idream-companion-memory",
      private: false,
      sidecarUrl: "http://127.0.0.1:3101",
      assignment,
    },
    dsh: {
      profileDigest: "a".repeat(64),
      memoryMode: "normal",
      provider: "openai",
      model: "fixture-model",
      workspaceKeyHash: "must-not-leak",
    },
    primaryTelemetry: {
      schemaVersion: 1,
      runtime: "dsh",
      terminalStatus: "sent",
      truncated: false,
      provider: "openai",
      model: "fixture-model",
      sseTerminal: "done",
      memory: { outcome: "ingested", settleLagMs: 17 },
      sidecar: {
        instanceId: "5dd87053-012f-4ca3-a4d7-5aeb89466d5b",
        startedAt: "2026-08-19T12:00:00.000Z",
        profileDigest: "a".repeat(64),
      },
    },
    companion: {
      profile: "idream-companion-memory",
      memoryIngestOutcome: "ingested",
      memoryIngestSettledAt: "2026-08-19T12:00:01.000Z",
      attribution: {
        requestId: "chatcmpl-probe",
        actualProvider: "local-openai",
      },
    },
    trace: { systemPrompt: "must-not-leak" },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  db.findUser.mockReset();
});

function installFailFastProbeFetch(
  scenario: "normal_fatal" | "future_fatal" | "future_unsettled",
): string[] {
  const requests: string[] = [];
  let sessionListReads = 0;
  let messagePosts = 0;
  let sessionDeleted = false;
  vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
    const sse = (events: string[]) => new Response(events.join("\n"), { status: 200 });
    if (url.pathname === "/healthz") return json({ ok: true, service: "chat" });
    if (url.pathname === "/api/v1/chat/runtime-authority") {
      return json({ chatFsRootFingerprint: "a".repeat(64), sourceRevision: "probe-revision" });
    }
    if (url.pathname === "/internal/admin/companion-rollout-evidence") {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      return json({
        schemaVersion: 1,
        window: { from, to },
        releaseDecision: { status: "not_evaluated" },
        runtimes: { native: { attempts: 1 }, dsh: { attempts: 0 } },
        dataScope: {
          userAuthority: "core.chat_user_view",
          scope: "internal-audit",
          includedDataClass: "audit",
          activeCustomersOnly: false,
          exactAuditActorOnly: true,
          userFilterApplied: true,
          windowBasis: "message_versions.created_at",
        },
      });
    }
    if (url.pathname === "/api/v1/chat/sessions" && method === "GET") {
      sessionListReads += 1;
      return sessionListReads === 2 ? json({}, 401) : json([]);
    }
    if (url.pathname === "/api/v1/chat/memories" && method === "GET") {
      return json({ memories: [] });
    }
    if (url.pathname === "/api/v1/chat/relationships" && method === "GET") {
      return json({ relationships: [] });
    }
    if (url.pathname === "/api/v1/chat/sessions" && method === "POST") {
      return json({ id: "session-probe" }, 201);
    }
    if (url.pathname === "/api/v1/chat/sessions/session-probe/messages" && method === "POST") {
      messagePosts += 1;
      const normal = messagePosts === 1;
      return json({
        assistantMessageId: normal ? "assistant-normal" : "assistant-future",
        userMessageId: normal ? "user-normal" : "user-future",
        attempt: 1,
        status: "pending",
      }, 202);
    }
    if (url.pathname === "/api/v1/chat/messages/assistant-normal/stream") {
      return scenario === "normal_fatal"
        ? sse([
            "event: error",
            'data: {"type":"error","attempt":1,"code":"provider_failed","retryable":false}',
            "",
          ])
        : sse([
            "event: start",
            'data: {"type":"start","attempt":1}',
            "",
            "event: delta",
            'data: {"type":"delta","attempt":1,"seq":1,"delta":"ok"}',
            "",
            "event: done",
            'data: {"type":"done","attempt":1,"usage":{}}',
            "",
          ]);
    }
    if (url.pathname === "/api/v1/chat/messages/assistant-future/stream") {
      return scenario === "future_fatal"
        ? sse([
            "event: error",
            'data: {"type":"error","attempt":1,"code":"provider_failed","retryable":false}',
            "",
          ])
        : sse([
        "event: start",
        'data: {"type":"start","attempt":1}',
        "",
        "event: delta",
        'data: {"type":"delta","attempt":1,"seq":1,"delta":"future"}',
        "",
        "event: done",
        'data: {"type":"done","attempt":1,"usage":{}}',
        "",
          ]);
    }
    if (url.pathname === "/api/v1/chat/sessions/session-probe" && method === "GET") {
      if (sessionDeleted) return json({}, 404);
      return json({
        messages: [
          {
            id: "user-future",
            role: "user",
            status: "sent",
            sceneVersion: 1,
          },
          {
            id: "assistant-normal",
            role: "assistant",
            status: "sent",
            content: "ok",
            attempt: 1,
            memoryExtractedAttempt: 1,
            scene: { version: 0 },
            runtimeTrace: { primaryTelemetry: { sseTerminal: "done" } },
          },
          ...(messagePosts > 1
            ? [{
                id: "assistant-future",
                role: "assistant",
                status: "generating",
                attempt: 1,
                memoryExtractedAttempt: 0,
                scene: { version: 1 },
                runtimeTrace: { primaryTelemetry: {} },
              }]
            : []),
        ],
      });
    }
    if (url.pathname === "/api/v1/chat/sessions/session-probe/memory" && method === "POST") {
      return json({ ok: true });
    }
    if (url.pathname === "/api/v1/chat/sessions/session-probe" && method === "DELETE") {
      sessionDeleted = true;
      return json({ ok: true });
    }
    return json({ error: "unexpected probe request" }, 500);
  }));
  return requests;
}

describe("chat service probe actor authority", () => {
  it("accepts only the dedicated active audit actor", () => {
    expect(
      assertDedicatedChatProbeActor(auditActor, auditActor.id),
    ).toEqual({
      actorDataClass: "audit",
      dedicatedActor: true,
    });
  });

  it.each([
    null,
    { ...auditActor, id: "seed-dev-user", dataClass: "internal" },
    { ...auditActor, dataClass: "customer" },
    { ...auditActor, role: "admin" },
    { ...auditActor, status: "suspended" },
    { ...auditActor, deletedAt: new Date() },
  ])("fails closed for a non-dedicated actor %#", (actor) => {
    expect(() =>
      assertDedicatedChatProbeActor(actor, actor?.id ?? "missing"),
    ).toThrow("dedicated active audit actor");
  });

  it("skips approved characters whose pinned content lacks a complete immutable Soul", () => {
    expect(selectSoulReadyProbeCharacter([
      {
        id: "newer-but-incomplete",
        personaSnapshot: {
          name: "Fixture",
          age: 29,
          description: "Missing immutable prompt bytes.",
        },
      },
      {
        id: "older-soul-ready",
        personaSnapshot: {
          name: "Alexa Reeves",
          age: 27,
          gender: "female",
          relationshipArchetype: "confidante",
          characterPromise: "A candid late-night confidante.",
          personality: "Bold and emotionally perceptive.",
          tone: "Playful and direct.",
          backstory: "She learned to read a room before speaking.",
          systemPrompt: "PINNED LEGACY PROMPT — DO NOT RECOMPILE",
        },
      },
    ])).toBe("older-soul-ready");
  });
});

describe("chat service DSH evidence", () => {
  it("requires an explicit exact DSH mode instead of accepting an ambiguous value", () => {
    expect(parseExpectedCompanionRuntime(undefined)).toBeNull();
    expect(parseExpectedCompanionRuntime("dsh")).toBe("dsh");
    expect(parseExpectedCompanionRuntime(" dsh ")).toBe("dsh");
    expect(() => parseExpectedCompanionRuntime("native")).toThrow(
      "expected companion runtime must be dsh",
    );
  });

  it("requires an explicit exact DSH shadow mode", () => {
    expect(parseExpectedCompanionShadow(undefined)).toBeNull();
    expect(parseExpectedCompanionShadow("dsh")).toBe("dsh");
    expect(parseExpectedCompanionShadow(" dsh ")).toBe("dsh");
    expect(() => parseExpectedCompanionShadow("native")).toThrow(
      "expected companion shadow must be dsh",
    );
  });

  it("gives Shadow settlement its own 330 second observation envelope", () => {
    expect(chatServiceProbeSettleTimeoutMs(false)).toBe(90_000);
    expect(chatServiceProbeSettleTimeoutMs(true)).toBe(330_000);
    vi.stubEnv("CHAT_SERVICE_PROBE_SHADOW_SETTLE_TIMEOUT_MS", "345000");
    expect(chatServiceProbeSettleTimeoutMs(true)).toBe(345_000);
  });

  it("projects completed DSH shadow evidence without exposing answer bytes", () => {
    const evidence = projectDshShadowEvidence({
      companionRuntime: {
        runtime: "native",
        memoryBackend: "legacy",
        private: false,
      },
      shadowEvidence: completedShadowEvidence(),
    }, "normal");

    expect(evidence).toEqual({
      ok: true,
      status: "completed",
      primaryRuntime: "native",
      profileVerified: true,
      primaryProvider: "openai",
      primaryModel: "fixture-model",
      shadowProvider: "openai",
      shadowModel: "fixture-model",
      shadowFinishReason: "stop",
      shadowToolCalls: 1,
      shadowDryRunToolCalls: 1,
      shadowSteps: 2,
      workspaceClass: "shadow",
      promotionAttempted: false,
      commitRejected: true,
      privateSkipped: false,
      error: null,
    });
    expect(JSON.stringify(evidence)).not.toContain("profileDigest");
  });

  it("proves a private native turn skipped DSH shadow admission", () => {
    const evidence = projectDshShadowEvidence({
      companionRuntime: {
        runtime: "native",
        memoryBackend: "legacy",
        private: true,
      },
      primaryTelemetry: {
        schemaVersion: 1,
        runtime: "native",
        terminalStatus: "sent",
        sseTerminal: "done",
        memory: { outcome: "disabled" },
      },
      shadowEvidence: {
        schemaVersion: 1,
        status: "skipped_private",
        enqueued: false,
      },
    }, "private");

    expect(evidence).toEqual({
      ok: true,
      primaryRuntime: "native",
      privateSkipped: true,
      error: null,
    });
  });

  it("rejects any persisted Shadow comparison on a private turn", () => {
    const evidence = projectDshShadowEvidence({
      companionRuntime: {
        runtime: "native",
        memoryBackend: "legacy",
        private: true,
      },
      primaryTelemetry: {
        schemaVersion: 1,
        runtime: "native",
        terminalStatus: "sent",
        sseTerminal: "done",
        memory: { outcome: "disabled" },
      },
      shadowEvidence: {
        schemaVersion: 1,
        status: "skipped_private",
        enqueued: false,
      },
      shadowComparison: { must: "remain private" },
    }, "private");

    expect(evidence.ok).toBe(false);
    expect(evidence.privateSkipped).toBe(false);
    expect(evidence.error).toContain("shadowEvidence.privateFieldsAbsent");
  });

  it("fails closed when a Shadow tool call was not dry-run", () => {
    const evidence = projectDshShadowEvidence({
      companionRuntime: { runtime: "native", memoryBackend: "legacy", private: false },
      shadowEvidence: {
        ...completedShadowEvidence(),
        shadow: {
          ...completedShadowEvidence().shadow,
          dryRunToolCalls: 0,
        },
      },
    }, "normal");

    expect(evidence.ok).toBe(false);
    expect(evidence.error).toContain("shadowEvidence.contract");
  });

  it("fails immediately on a terminal Shadow admission skip", () => {
    expect(shadowProbeObservation({
      shadowEvidence: {
        schemaVersion: 1,
        status: "skipped_readiness",
        enqueued: false,
      },
    })).toBe("failed");
    expect(shadowProbeObservation({
      shadowEvidence: completedShadowEvidence(),
    })).toBe("completed");
    expect(shadowProbeObservation({})).toBe("pending");
  });

  it("projects a settled allowlisted DSH turn without exposing the raw trace", () => {
    const evidence = projectDshCompanionEvidence(completedDshTrace({
      policyVersion: 1,
      reason: "allowlist",
    }), "normal");

    expect(evidence).toEqual({
      ok: true,
      runtime: "dsh",
      memoryBackend: "igrep-dsh",
      profile: "idream-companion-memory",
      private: false,
      assignmentReason: "allowlist",
      primaryRuntime: "dsh",
      terminalStatus: "sent",
      sseTerminal: "done",
      provider: "openai",
      model: "fixture-model",
      profileDigest: "a".repeat(64),
      requestId: "chatcmpl-probe",
      actualProvider: "local-openai",
      memoryOutcome: "ingested",
      memoryIngestOutcome: "ingested",
      memorySettledAt: "2026-08-19T12:00:01.000Z",
      memorySettleLagMs: 17,
      sidecarInstanceId: "5dd87053-012f-4ca3-a4d7-5aeb89466d5b",
      error: null,
    });
    expect(JSON.stringify(evidence)).not.toContain("must-not-leak");
  });

  it("accepts a provable threshold assignment for a full DSH rollout", () => {
    const evidence = projectDshCompanionEvidence(completedDshTrace({
      policyVersion: 1,
      reason: "threshold",
      bucketBps: 9_999,
      thresholdBps: 10_000,
    }), "normal");

    expect(evidence).toMatchObject({
      ok: true,
      runtime: "dsh",
      assignmentReason: "threshold",
      error: null,
    });
  });

  it("rejects an unprovable threshold assignment", () => {
    const evidence = projectDshCompanionEvidence(completedDshTrace({
      policyVersion: 1,
      reason: "threshold",
      bucketBps: 4_000,
      thresholdBps: 4_000,
    }), "normal");

    expect(evidence.ok).toBe(false);
    expect(evidence.error).toContain("companionRuntime.assignment");
  });

  it("fails closed when the started sidecar digest differs from the durable attempt pin", () => {
    const evidence = projectDshCompanionEvidence({
      companionRuntime: {
        runtime: "dsh",
        memoryBackend: "igrep-dsh",
        profile: "idream-companion-memory",
        private: false,
        assignment: { policyVersion: 1, reason: "allowlist" },
      },
      dsh: {
        profileDigest: "a".repeat(64),
        memoryMode: "normal",
        provider: "openai",
        model: "fixture-model",
      },
      primaryTelemetry: {
        schemaVersion: 1,
        runtime: "dsh",
        terminalStatus: "sent",
        truncated: false,
        provider: "openai",
        model: "fixture-model",
        sseTerminal: "done",
        memory: { outcome: "ingested", settleLagMs: 17 },
        sidecar: {
          instanceId: "5dd87053-012f-4ca3-a4d7-5aeb89466d5b",
          startedAt: "2026-08-19T12:00:00.000Z",
          profileDigest: "b".repeat(64),
        },
      },
      companion: {
        profile: "idream-companion-memory",
        memoryIngestOutcome: "ingested",
        memoryIngestSettledAt: "2026-08-19T12:00:01.000Z",
        attribution: { requestId: "chatcmpl-probe" },
      },
    }, "normal");

    expect(evidence.ok).toBe(false);
    expect(evidence.error).toContain("primaryTelemetry.sidecar.profileDigest");
  });

  it("fails closed when a normal DSH candidate has no provider attribution", () => {
    const evidence = projectDshCompanionEvidence({
      companionRuntime: {
        runtime: "dsh",
        memoryBackend: "igrep-dsh",
        profile: "idream-companion-memory",
        private: false,
        assignment: { policyVersion: 1, reason: "allowlist" },
      },
      dsh: {
        profileDigest: "b".repeat(64),
        memoryMode: "normal",
        provider: "openai",
        model: "fixture-model",
      },
      primaryTelemetry: {
        schemaVersion: 1,
        runtime: "dsh",
        terminalStatus: "sent",
        truncated: false,
        provider: "openai",
        model: "fixture-model",
        sseTerminal: "done",
        memory: { outcome: "ingested", settleLagMs: 0 },
        sidecar: {
          instanceId: "5dd87053-012f-4ca3-a4d7-5aeb89466d5b",
          startedAt: "2026-08-19T12:00:00.000Z",
        },
      },
      companion: {
        profile: "idream-companion-memory",
        memoryIngestOutcome: "ingested",
        memoryIngestSettledAt: "2026-08-19T12:00:01.000Z",
      },
    }, "normal");

    expect(evidence.ok).toBe(false);
    expect(evidence.error).toContain("companion.attribution");
  });

  it("accepts model output authority for a private turn but rejects a writable memory outcome", () => {
    const evidence = projectDshCompanionEvidence({
      companionRuntime: {
        runtime: "dsh",
        memoryBackend: "igrep-dsh",
        profile: "idream-companion-private",
        private: true,
        assignment: { policyVersion: 1, reason: "allowlist" },
      },
      dsh: {
        profileDigest: "c".repeat(64),
        memoryMode: "private",
        provider: "openai",
        model: "fixture-model",
      },
      outputAuthority: "model",
      primaryTelemetry: {
        schemaVersion: 1,
        runtime: "dsh",
        terminalStatus: "sent",
        truncated: false,
        provider: "openai",
        model: "fixture-model",
        sseTerminal: "done",
        memory: { outcome: "pending" },
      },
    }, "private");

    expect(evidence.ok).toBe(false);
    expect(evidence.error).not.toContain("outputAuthority");
    expect(evidence.error).toContain("primaryTelemetry.memory.outcome");
  });
});

describe("chat service conversation probe", () => {
  it("keeps the SSE observer outside the default DSH execution deadline", () => {
    expect(DEFAULT_CHAT_SERVICE_PROBE_STREAM_TIMEOUT_MS).toBe(330_000);
  });

  it("collects exact-actor aggregate Gate R evidence before cleanup", async () => {
    const requests: string[] = [];
    const checkedAt = "2026-08-20T12:00:00.000Z";
    const collectedAt = "2026-08-20T12:05:00.000Z";
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      requests.push(`${init?.method ?? "GET"} ${url.pathname}?${url.searchParams}`);
      expect(init?.headers).toEqual({ "x-internal-token": "internal-probe-token" });
      return new Response(JSON.stringify({
        schemaVersion: 1,
        generatedAt: collectedAt,
        window: { from: checkedAt, to: collectedAt, durationMs: 300_000 },
        comparisonStatus: "sample_insufficient",
        sampleEvidence: { native: "no_samples", dsh: "observed" },
        releaseDecision: {
          status: "not_evaluated",
          reason: "no_gate_thresholds_or_observation_window_policy",
        },
        runtimes: {
          native: { attempts: 0 },
          dsh: { attempts: 3 },
        },
        dataScope: {
          userAuthority: "core.chat_user_view",
          scope: "internal-audit",
          includedDataClass: "audit",
          activeCustomersOnly: false,
          exactAuditActorOnly: true,
          userFilterApplied: true,
          windowBasis: "message_versions.created_at",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const evidence = await collectProbeRolloutEvidenceBeforeCleanup({
      serviceUrl: "http://127.0.0.1:3100",
      internalToken: "internal-probe-token",
      userId: auditActor.id,
      checkedAt,
      expectedCompanionRuntime: "dsh",
      now: () => new Date(collectedAt),
      fetchImpl,
    });

    expect(evidence).toMatchObject({
      ok: true,
      status: 200,
      collectedAt,
      aggregate: {
        dataScope: { scope: "internal-audit", exactAuditActorOnly: true },
        releaseDecision: { status: "not_evaluated" },
        runtimes: { dsh: { attempts: 3 } },
      },
    });
    expect(requests).toEqual([
      "GET /internal/admin/companion-rollout-evidence?" +
      "from=2026-08-20T12%3A00%3A00.000Z&" +
      "to=2026-08-20T12%3A05%3A00.000Z&" +
      "scope=internal-audit&userId=seed-chat-probe-user",
    ]);
    expect(JSON.stringify(evidence)).not.toContain("internal-probe-token");
  });

  it("fails closed when pre-cleanup Gate R evidence is not attributable", async () => {
    const evidence = await collectProbeRolloutEvidenceBeforeCleanup({
      serviceUrl: "http://127.0.0.1:3100",
      internalToken: "internal-probe-token",
      userId: auditActor.id,
      checkedAt: "2026-08-20T12:00:00.000Z",
      expectedCompanionRuntime: "dsh",
      now: () => new Date("2026-08-20T12:05:00.000Z"),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        schemaVersion: 1,
        window: {
          from: "2026-08-20T12:00:00.000Z",
          to: "2026-08-20T12:05:00.000Z",
        },
        releaseDecision: { status: "not_evaluated" },
        runtimes: { native: { attempts: 0 }, dsh: { attempts: 0 } },
        dataScope: { scope: "customers" },
      }), { status: 200 })),
    });

    expect(evidence).toMatchObject({ ok: false, status: 200 });
    expect(evidence.error).toContain("internal-audit aggregate");
  });

  it("does not collect pre-cleanup evidence without INTERNAL_TOKEN", async () => {
    const fetchImpl = vi.fn();
    const evidence = await collectProbeRolloutEvidenceBeforeCleanup({
      serviceUrl: "http://127.0.0.1:3100",
      internalToken: null,
      userId: auditActor.id,
      checkedAt: "2026-08-20T12:00:00.000Z",
      expectedCompanionRuntime: "dsh",
      now: () => new Date("2026-08-20T12:05:00.000Z"),
      fetchImpl,
    });

    expect(evidence).toMatchObject({
      ok: false,
      error: "INTERNAL_TOKEN is required for pre-cleanup Gate R evidence",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops before the future turn when the normal stream is terminally failed", async () => {
    db.findUser.mockResolvedValue(auditActor);
    vi.stubEnv("CHAT_SERVICE_PROBE_SETTLE_TIMEOUT_MS", "1");
    vi.stubEnv("CHAT_SERVICE_PROBE_STREAM_TIMEOUT_MS", "100");
    const requests = installFailFastProbeFetch("normal_fatal");

    const report = await runProbe({
      serviceUrl: "http://127.0.0.1:3100",
      secret: "probe-secret",
      internalToken: "internal-probe-token",
      userId: auditActor.id,
      characterId: "lola-moonstruck",
    });

    expect(report.conversation?.error).toBe("normal stream failed: provider_failed");
    expect(requests.filter((request) =>
      request === "POST /api/v1/chat/sessions/session-probe/messages")).toHaveLength(1);
    expect(requests.some((request) => request.includes("/regenerate"))).toBe(false);
    expect(
      requests.indexOf("GET /internal/admin/companion-rollout-evidence"),
    ).toBeLessThan(requests.indexOf("DELETE /api/v1/chat/sessions/session-probe"));
  });

  it("stops before regeneration when the future terminal state never settles", async () => {
    db.findUser.mockResolvedValue(auditActor);
    vi.stubEnv("CHAT_SERVICE_PROBE_SETTLE_TIMEOUT_MS", "1");
    vi.stubEnv("CHAT_SERVICE_PROBE_STREAM_TIMEOUT_MS", "100");
    const requests = installFailFastProbeFetch("future_unsettled");

    const report = await runProbe({
      serviceUrl: "http://127.0.0.1:3100",
      secret: "probe-secret",
      internalToken: "internal-probe-token",
      userId: auditActor.id,
      characterId: "lola-moonstruck",
    });

    expect(report.conversation?.regenerateAnchor?.error).toContain(
      "future scene terminal state failed",
    );
    expect(requests.some((request) => request.includes("/regenerate"))).toBe(false);
    expect(requests.filter((request) =>
      request === "POST /api/v1/chat/sessions/session-probe/messages")).toHaveLength(2);
  });

  it("stops after a fatal future-turn stream error and preserves its code", async () => {
    db.findUser.mockResolvedValue(auditActor);
    vi.stubEnv("CHAT_SERVICE_PROBE_SETTLE_TIMEOUT_MS", "1");
    vi.stubEnv("CHAT_SERVICE_PROBE_STREAM_TIMEOUT_MS", "100");
    const requests = installFailFastProbeFetch("future_fatal");

    const report = await runProbe({
      serviceUrl: "http://127.0.0.1:3100",
      secret: "probe-secret",
      internalToken: "internal-probe-token",
      userId: auditActor.id,
      characterId: "lola-moonstruck",
    });
    expect(report.conversation).not.toBeNull();
    const conversation = report.conversation!;

    expect(conversation.regenerateAnchor).toMatchObject({
      ok: false,
      assistantMessageId: "assistant-future",
      error: "future scene stream failed: provider_failed",
    });
    expect(conversation.error).toBe("future scene stream failed: provider_failed");
    expect(requests.some((request) => request.includes("/regenerate"))).toBe(false);
    expect(
      requests.filter((request) =>
        request === "POST /api/v1/chat/sessions/session-probe/messages"),
    ).toHaveLength(2);
    expect(conversation.cleanup?.ok).toBe(true);
  });
});
