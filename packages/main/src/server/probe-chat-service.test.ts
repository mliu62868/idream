import { afterEach, describe, expect, it, vi } from "vitest";
import { compileCharacterSoul } from "@idream/shared";
import { BFF_HEADER } from "@idream/shared/bff";

const db = vi.hoisted(() => ({
  findUser: vi.fn(),
  findTurn: vi.fn(),
  findPendingProjection: vi.fn(),
  createSession: vi.fn(async () => ({})),
  deleteSessions: vi.fn(async () => ({ count: 1 })),
}));

vi.mock("./lib/db", () => ({
  prisma: {
    user: { findUnique: db.findUser },
    chatTurn: { findUnique: db.findTurn },
    mainOutboxEvent: { findFirst: db.findPendingProjection },
    session: { create: db.createSession, deleteMany: db.deleteSessions },
    $disconnect: vi.fn(async () => undefined),
  },
}));

import {
  DEFAULT_CHAT_SERVICE_PROBE_STREAM_TIMEOUT_MS,
  chatServiceProbeSettleTimeoutMs,
  assertDedicatedChatProbeActor,
  cleanupCompletedProbeState,
  cleanupExistingProbeState,
  describeDshRecallFailure,
  fetchProbeCompanionAttemptEvidence,
  evaluateDshRecallEvidence,
  projectDshCompanionEvidence,
  runProbe,
  selectSoulReadyProbeCharacter,
} from "./probe-chat-service";

const auditActor = {
  id: "seed-chat-probe-user",
  dataClass: "audit",
  role: "user",
  status: "active",
  deletedAt: null,
};

function completedDshTrace() {
  return {
    authority: "dsh_terminal_candidate",
    prompt: {
      productPromptVersion: "companion-product-1",
      preparedTurnVersion: 4,
      systemPromptDigest: "c".repeat(64),
      soulFingerprint: "d".repeat(64),
    },
    attemptId: "assistant-normal:1",
    runtime: "embedded_dsh",
    memoryMode: "normal",
    provider: "openai",
    model: "fixture-model",
    finishReason: "stop",
    completedAt: "2026-08-19T12:00:01.000Z",
    execution: { steps: 2, toolCalls: 0 },
    tools: [],
    profileDigest: "a".repeat(64),
    runtimeInstance: {
      id: "5dd87053-012f-4ca3-a4d7-5aeb89466d5b",
      startedAt: "2026-08-19T12:00:00.000Z",
    },
    igrepVersion: "0.14.1",
    pluginVersion: "0.1.0",
    contentDigest: "b".repeat(64),
    igrepObservations: {
      wake: { calls: 1, hits: 0, failures: 0, evidenceMatches: 0 },
      search: { calls: 0, hits: 0, failures: 0, evidenceMatches: 0 },
      memory: { calls: 1, hits: 1, failures: 0, evidenceMatches: 1 },
    },
    attribution: {
      requestId: "chatcmpl-probe",
      actualProvider: "local-openai",
    },
    privateTrace: "must-not-leak",
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  db.findUser.mockReset();
  db.findTurn.mockReset();
  db.findPendingProjection.mockReset();
  db.createSession.mockClear();
  db.deleteSessions.mockClear();
});

function installFailFastProbeFetch(
  scenario: "normal_fatal" | "recall_fatal" | "recall_mismatch" | "regenerate_fatal"
    | "recall_create_failed" | "recall_session_reused" | "archive_failed",
): string[] {
  let recallSessionId = "session-probe";
  db.findTurn.mockImplementation(async (args: { where: { assistantMessageId: string } }) => ({
    id: args.where.assistantMessageId === "assistant-normal" ? "turn-normal" : "turn-recall",
    attempt: 1,
    assistantStatus: "sent",
    terminalEvidence: {
      ...completedDshTrace(),
      attribution: {
        requestId: `chatcmpl-${args.where.assistantMessageId}`,
        actualProvider: "local-openai",
      },
    },
    memoryEnabled: true,
    sceneVersion: 0,
    session: {
      sessionId: args.where.assistantMessageId === "assistant-normal" ? "session-probe" : recallSessionId,
      userId: auditActor.id,
      characterId: "lola-moonstruck",
    },
  }));
  db.findPendingProjection.mockResolvedValue(null);
  const requests: string[] = [];
  let messagePosts = 0;
  let regenerated = false;
  let seededRecallMarker: string | undefined;
  let archived = false;
  const deletedSessions = new Set<string>();
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
      if (!new Headers(init?.headers).has(BFF_HEADER)) return json({}, 401);
      return json({ chatFsRootFingerprint: "a".repeat(64), sourceRevision: "probe-revision" });
    }
    if (url.pathname === "/api/v1/chat/sessions" && method === "GET") {
      return json([]);
    }
    if (url.pathname.startsWith("/api/v1/chat/memory/") && method === "DELETE") {
      return json({ ok: true });
    }
    if (url.pathname === "/api/v1/chat/sessions" && method === "POST") {
      if (archived && scenario === "recall_create_failed") return json({}, 503);
      if (archived && scenario !== "recall_session_reused") recallSessionId = "session-recall";
      return json({ id: recallSessionId }, 201);
    }
    if (url.pathname === "/api/v1/chat/sessions/session-probe/archive" && method === "POST") {
      if (scenario === "archive_failed") return json({}, 409);
      archived = true;
      return json({ id: "session-probe", status: "archived" });
    }
    if (/^\/api\/v1\/chat\/sessions\/(session-probe|session-recall)\/messages$/u.test(url.pathname) && method === "POST") {
      messagePosts += 1;
      const normal = messagePosts === 1;
      if (normal) {
        const content = JSON.parse(String(init?.body)) as { content: string };
        seededRecallMarker = /idreamrecall_[a-f0-9]{32}/u.exec(content.content)?.[0];
        expect(seededRecallMarker).toBeTruthy();
      }
      if (!normal) {
        const content = JSON.parse(String(init?.body)) as { content: string };
        expect(content.content).not.toContain(seededRecallMarker);
        expect(content.content).toContain(
          'Call memory_search with query exactly "exact rooftop probe code word"',
        );
      }
      return json({
        assistantMessageId: normal ? "assistant-normal" : "assistant-recall",
        userMessageId: normal ? "user-normal" : "user-recall",
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
    if (url.pathname === "/api/v1/chat/messages/assistant-recall/stream") {
      if (scenario === "recall_fatal" || scenario === "archive_failed" || scenario === "recall_create_failed"
        || scenario === "recall_session_reused" || (scenario === "regenerate_fatal" && regenerated)) {
        return sse([
          "event: error",
          `data: {"type":"error","attempt":${regenerated ? 2 : 1},"code":"provider_failed","retryable":false}`,
          "",
        ]);
      }
      return sse([
        "event: start",
        'data: {"type":"start","attempt":1}',
        "",
        "event: delta",
        'data: {"type":"delta","attempt":1,"seq":1,"delta":"recalled"}',
        "",
        "event: done",
        'data: {"type":"done","attempt":1,"usage":{}}',
        "",
      ]);
    }
    if (url.pathname === "/api/v1/chat/messages/assistant-recall/regenerate" && method === "POST") {
      regenerated = true;
      return json({ assistantMessageId: "assistant-recall", attempt: 2 }, 202);
    }
    const sessionMatch = /^\/api\/v1\/chat\/sessions\/(session-probe|session-recall)$/u.exec(url.pathname);
    if (sessionMatch && method === "GET") {
      if (deletedSessions.has(sessionMatch[1])) return json({}, 404);
      return json({
        messages: [
          ...(sessionMatch[1] === "session-probe" ? [{
            id: "assistant-normal",
            role: "assistant",
            status: "sent",
            content: "ok",
            attempt: 1,
            memoryExtractedAttempt: 1,
            scene: { version: 0 },
            runtimeTrace: { primaryTelemetry: { sseTerminal: "done" } },
          }] : []),
          ...(messagePosts > 1 && sessionMatch[1] === recallSessionId
            ? [{
                id: "assistant-recall",
                role: "assistant",
                status: "sent",
                content: scenario === "recall_mismatch"
                  ? "You told me the code word was rooftop."
                  : `You told me ${seededRecallMarker}.`,
                attempt: 1,
                scene: { version: 0 },
              }]
            : []),
        ],
      });
    }
    if (/^\/api\/v1\/chat\/sessions\/(session-probe|session-recall)\/memory$/u.test(url.pathname) && method === "POST") {
      return json({ ok: true });
    }
    if (sessionMatch && method === "DELETE") {
      deletedSessions.add(sessionMatch[1]);
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
    const ready = compileCharacterSoul({
      name: "Alexa Reeves",
      age: 27,
      gender: "female",
      characterPromise: "A candid late-night confidante.",
      detailsMarkdown: [
        "## Personality and voice",
        "Bold, emotionally perceptive, playful, and direct.",
        "",
        "## Background",
        "She learned to read a room before speaking.",
      ].join("\n"),
    });
    if (!ready.ok) throw new Error("probe fixture Soul must compile");
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
        personaSnapshot: ready.snapshot,
      },
    ])).toBe("older-soul-ready");
  });
});

describe("chat service DSH evidence", () => {
  it("uses one bounded settlement envelope for the sole DSH runtime", () => {
    expect(chatServiceProbeSettleTimeoutMs()).toBe(90_000);
    vi.stubEnv("CHAT_SERVICE_PROBE_SETTLE_TIMEOUT_MS", "120000");
    expect(chatServiceProbeSettleTimeoutMs()).toBe(120_000);
  });

  it("projects a settled allowlisted DSH turn without exposing the raw trace", () => {
    const evidence = projectDshCompanionEvidence(completedDshTrace(), "normal");

    expect(evidence).toEqual({
      ok: true,
      productPromptVersion: "companion-product-1",
      preparedTurnVersion: 4,
      systemPromptDigest: "c".repeat(64),
      soulFingerprint: "d".repeat(64),
      runtime: "embedded_dsh",
      memoryMode: "normal",
      provider: "openai",
      model: "fixture-model",
      profileDigest: "a".repeat(64),
      runtimeInstanceId: "5dd87053-012f-4ca3-a4d7-5aeb89466d5b",
      igrepVersion: "0.14.1",
      pluginVersion: "0.1.0",
      requestId: "chatcmpl-probe",
      actualProvider: "local-openai",
      memoryOutcome: "projected",
      wakeCalls: 1,
      wakeFailures: 0,
      igrepSearchCalls: 0,
      igrepSearchFailures: 0,
      memorySearchCalls: 1,
      memorySearchHits: 1,
      memorySearchEvidenceMatches: 1,
      memorySearchFailures: 0,
      error: null,
    });
    expect(JSON.stringify(evidence)).not.toContain("must-not-leak");
  });

  it("fails closed when a normal DSH candidate has no provider attribution", () => {
    const trace = completedDshTrace();
    delete (trace as { attribution?: unknown }).attribution;
    const evidence = projectDshCompanionEvidence(trace, "normal");

    expect(evidence.ok).toBe(false);
    expect(evidence.error).toContain("attribution");
  });

  it("requires private turns to carry no igrep activity", () => {
    const trace = completedDshTrace();
    trace.memoryMode = "private";
    const evidence = projectDshCompanionEvidence(trace, "private");

    expect(evidence.ok).toBe(false);
    expect(evidence.error).toContain("privateMemoryIsolation");
  });
});

describe("chat service conversation probe", () => {
  it.each([
    ["preflight", false, false],
    ["preflight", false, true],
    ["preflight", true, false],
    ["finally", false, false],
    ["finally", true, false],
  ] as const)("waits for each relationship mutation during %s cleanup (final stall: %s, initial pending: %s)", async (phase, finalStall, initialPending) => {
    vi.useFakeTimers();
    vi.stubEnv("CHAT_SERVICE_PROBE_SETTLE_TIMEOUT_MS", "250");
    let pending = initialPending;
    if (initialPending) setTimeout(() => { pending = false; }, 100);
    const remaining = new Set(["session-source", "session-recall"]);
    const deletes: string[] = [];
    db.findPendingProjection.mockImplementation(async () => pending ? { id: "relationship-rebuild" } : null);
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const method = init?.method ?? "GET";
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
      if (url.pathname === "/api/v1/chat/sessions" && method === "GET") {
        return json([...remaining].map((id) => ({ id })));
      }
      if (url.pathname === "/api/v1/chat/memory/lola-moonstruck" && method === "DELETE") {
        return json({ ok: true });
      }
      if (url.pathname.endsWith("/memory") && method === "POST") return json({ ok: true });
      const sessionId = url.pathname.split("/").at(-1)!;
      if (method === "DELETE") {
        deletes.push(sessionId);
        if (pending) return json({ error: "Companion memory is changing; retry shortly" }, 409);
        remaining.delete(sessionId);
        pending = true;
        if (!finalStall || sessionId === "session-source") setTimeout(() => { pending = false; }, 100);
        return json({ ok: true });
      }
      return json({}, remaining.has(sessionId) ? 200 : 404);
    }));
    const input = {
      serviceUrl: "http://127.0.0.1:3100",
      mainWebUrl: "http://127.0.0.1:3000",
      authToken: "probe-auth-token",
      secret: "probe-secret",
      userId: auditActor.id,
      characterId: "lola-moonstruck",
      sessionId: "session-recall",
      sessionIds: ["session-source", "session-recall"],
    };
    const resultPromise = phase === "preflight"
      ? cleanupExistingProbeState(input)
      : cleanupCompletedProbeState(input);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(deletes).toEqual(["session-source", "session-recall"]);
    expect(remaining.size).toBe(0);
    expect(result.ok).toBe(!finalStall);
    if (finalStall) {
      expect(result.error).toContain(phase === "finally"
        ? "memorySettled=false; memoryStage=after_delete:session-recall"
        : "companion memory did not settle after deleting session session-recall");
    } else {
      expect(pending).toBe(false);
    }
  });

  it("preserves exact recall diagnostics before cleanup without passing a mismatched answer", async () => {
    db.findUser.mockResolvedValue(auditActor);
    vi.stubEnv("CHAT_SERVICE_PROBE_SETTLE_TIMEOUT_MS", "1");
    const requests = installFailFastProbeFetch("recall_mismatch");

    const report = await runProbe({
      serviceUrl: "http://127.0.0.1:3100",
      secret: "probe-secret",
      internalToken: "internal-probe-token",
      userId: auditActor.id,
      characterId: "lola-moonstruck",
    });

    expect(report.ok).toBe(false);
    expect(report.conversation.recall).toMatchObject({
      ok: false,
      expectedPhrase: expect.stringMatching(/^idreamrecall_[a-f0-9]{32}$/u),
      actualAnswer: "You told me the code word was rooftop.",
      sourceSessionId: "session-probe",
      sourceTurnId: "turn-normal",
      sourceAssistantMessageId: "assistant-normal",
      sessionId: "session-recall",
      distinctSession: true,
      turnId: "turn-recall",
      assistantMessageId: "assistant-recall",
      recallMatched: false,
      wakeObserved: true,
      memorySearchHit: true,
      dsh: { requestId: "chatcmpl-assistant-recall", memorySearchEvidenceMatches: 1 },
    });
    expect(report.conversation.error).toContain("matched=false");
    expect(report.conversation.cleanup.ok).toBe(true);
    expect(requests).toContain("DELETE /api/v1/chat/sessions/session-probe");
    expect(report.conversation.cleanup.sessions).toEqual([
      { sessionId: "session-probe", deleted: true, gone: true, deleteStatus: 200, verifyStatus: 404 },
      { sessionId: "session-recall", deleted: true, gone: true, deleteStatus: 200, verifyStatus: 404 },
    ]);
    expect(requests.filter((request) => request.endsWith("/messages"))).toEqual([
      "POST /api/v1/chat/sessions/session-probe/messages",
      "POST /api/v1/chat/sessions/session-recall/messages",
    ]);
    expect(requests.some((request) => request.includes("/regenerate"))).toBe(false);
    expect(JSON.stringify(report)).not.toContain("must-not-leak");
  });

  it.each([
    ["archive_failed", "archive source session failed: HTTP 409"],
    ["recall_create_failed", "create recall session failed: HTTP 503"],
    ["recall_session_reused", "recall requires a distinct session"],
  ] as const)("cleans the source session when cross-session setup fails: %s", async (scenario, error) => {
    db.findUser.mockResolvedValue(auditActor);
    vi.stubEnv("CHAT_SERVICE_PROBE_SETTLE_TIMEOUT_MS", "1");
    const requests = installFailFastProbeFetch(scenario);
    const report = await runProbe({
      serviceUrl: "http://127.0.0.1:3100",
      secret: "probe-secret",
      internalToken: "internal-probe-token",
      userId: auditActor.id,
      characterId: "lola-moonstruck",
    });

    expect(report.ok).toBe(false);
    expect(report.conversation.error).toBe(error);
    expect(report.conversation.cleanup).toMatchObject({
      ok: true,
      sessions: [{ sessionId: "session-probe", deleted: true, gone: true }],
    });
    expect(requests.filter((request) => request.endsWith("/messages"))).toEqual([
      "POST /api/v1/chat/sessions/session-probe/messages",
    ]);
  });

  it("requires actual wake and a memory_search hit without exposing the recall sentinel", () => {
    const sentinel = "recall-probe-secret-42";
    const evidence = evaluateDshRecallEvidence({
      assistantContent: `You told me ${sentinel}.`,
      sentinel,
      dsh: projectDshCompanionEvidence(completedDshTrace(), "normal"),
    });
    expect(evidence).toEqual({
      ok: true,
      recallMatched: true,
      wakeObserved: true,
      memorySearchHit: true,
    });
    expect(JSON.stringify(evidence)).not.toContain(sentinel);
    expect(evaluateDshRecallEvidence({
      assistantContent: "I cannot recall it.",
      sentinel,
      dsh: projectDshCompanionEvidence(completedDshTrace(), "normal"),
    }).ok).toBe(false);
    const unrelated = completedDshTrace();
    unrelated.igrepObservations.memory.evidenceMatches = 0;
    expect(evaluateDshRecallEvidence({
      assistantContent: `You told me ${sentinel}.`,
      sentinel,
      dsh: projectDshCompanionEvidence(unrelated, "normal"),
    }).ok).toBe(false);
    expect(describeDshRecallFailure({
      ok: false,
      recallMatched: false,
      wakeObserved: true,
      memorySearchHit: false,
    }, projectDshCompanionEvidence(unrelated, "normal"))).toBe(
      "matched=false;wake=true;memorySearch=false;calls=1;hits=1;evidenceMatches=0",
    );
  });

  it("keeps the SSE observer outside the default DSH execution deadline", () => {
    expect(DEFAULT_CHAT_SERVICE_PROBE_STREAM_TIMEOUT_MS).toBe(330_000);
  });

  it("reads content-free evidence from Main's durable terminal authority", async () => {
    db.findTurn.mockResolvedValue({
      attempt: 1,
      assistantStatus: "sent",
      terminalEvidence: completedDshTrace(),
      memoryEnabled: true,
      session: {
        sessionId: "session-probe",
        userId: auditActor.id,
        characterId: "character-probe",
      },
    });
    db.findPendingProjection.mockResolvedValue(null);

    const evidence = await fetchProbeCompanionAttemptEvidence({
      serviceUrl: "http://127.0.0.1:3100",
      internalToken: "internal-probe-token",
      userId: auditActor.id,
      sessionId: "session-probe",
      messageId: "assistant-normal",
      attempt: 1,
      mode: "normal",
    });

    expect(evidence).toMatchObject({
      ok: true,
      runtime: "embedded_dsh",
      memoryOutcome: "projected",
    });
    expect(JSON.stringify(evidence)).not.toContain("must-not-leak");
  });

  it("polls until Main's relationship projection leaves pending", async () => {
    db.findTurn.mockResolvedValue({
      attempt: 1,
      assistantStatus: "sent",
      terminalEvidence: completedDshTrace(),
      memoryEnabled: true,
      session: {
        sessionId: "session-probe",
        userId: auditActor.id,
        characterId: "character-probe",
      },
    });
    db.findPendingProjection
      .mockResolvedValueOnce({ id: "projection-1" })
      .mockResolvedValueOnce({ id: "projection-1" })
      .mockResolvedValueOnce(null);
    const sleeps: number[] = [];

    const evidence = await fetchProbeCompanionAttemptEvidence({
      serviceUrl: "http://127.0.0.1:3100",
      internalToken: "internal-probe-token",
      userId: auditActor.id,
      sessionId: "session-probe",
      messageId: "assistant-normal",
      attempt: 1,
      mode: "normal",
      sleep: async (ms) => { sleeps.push(ms); },
    });

    expect(db.findPendingProjection).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([500, 500]);
    expect(evidence).toMatchObject({ ok: true, memoryOutcome: "projected" });
  });

  it("can inspect terminal evidence without waiting for its async projection", async () => {
    db.findTurn.mockResolvedValue({
      attempt: 1,
      assistantStatus: "sent",
      terminalEvidence: completedDshTrace(),
      memoryEnabled: true,
      session: {
        sessionId: "session-probe",
        userId: auditActor.id,
        characterId: "character-probe",
      },
    });
    db.findPendingProjection.mockResolvedValue({ id: "projection-1" });
    const sleep = vi.fn(async () => undefined);

    const evidence = await fetchProbeCompanionAttemptEvidence({
      serviceUrl: "http://127.0.0.1:3100",
      internalToken: "internal-probe-token",
      userId: auditActor.id,
      sessionId: "session-probe",
      messageId: "assistant-normal",
      attempt: 1,
      mode: "normal",
      awaitProjection: false,
      sleep,
    });

    expect(evidence).toMatchObject({ ok: true, memoryOutcome: "pending" });
    expect(db.findPendingProjection).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
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
    expect(requests).toContain("DELETE /api/v1/chat/sessions/session-probe");
  });

  it("stops before regeneration when relationship recall is terminally failed", async () => {
    db.findUser.mockResolvedValue(auditActor);
    vi.stubEnv("CHAT_SERVICE_PROBE_SETTLE_TIMEOUT_MS", "1");
    vi.stubEnv("CHAT_SERVICE_PROBE_STREAM_TIMEOUT_MS", "100");
    const requests = installFailFastProbeFetch("recall_fatal");

    const report = await runProbe({
      serviceUrl: "http://127.0.0.1:3100",
      secret: "probe-secret",
      internalToken: "internal-probe-token",
      userId: auditActor.id,
      characterId: "lola-moonstruck",
    });

    expect(report.conversation?.error).toBe("recall stream failed: provider_failed");
    expect(requests.some((request) => request.includes("/regenerate"))).toBe(false);
    expect(requests.filter((request) =>
      request.endsWith("/messages"))).toEqual([
        "POST /api/v1/chat/sessions/session-probe/messages",
        "POST /api/v1/chat/sessions/session-recall/messages",
      ]);
  });

  it("stops after a fatal regenerate stream error and preserves its code", async () => {
    db.findUser.mockResolvedValue(auditActor);
    vi.stubEnv("CHAT_SERVICE_PROBE_SETTLE_TIMEOUT_MS", "1");
    vi.stubEnv("CHAT_SERVICE_PROBE_STREAM_TIMEOUT_MS", "100");
    const requests = installFailFastProbeFetch("regenerate_fatal");

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
      assistantMessageId: "assistant-recall",
      error: "regenerate stream failed: provider_failed",
    });
    expect(conversation.error).toBe("regenerate stream failed: provider_failed");
    expect(requests).toContain("POST /api/v1/chat/messages/assistant-recall/regenerate");
    expect(
      requests.filter((request) =>
        request.endsWith("/messages")),
    ).toHaveLength(2);
    expect(conversation.cleanup?.ok).toBe(true);
  });
});
