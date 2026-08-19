import { describe, expect, it } from "vitest";
import {
  assertDedicatedChatProbeActor,
  parseExpectedCompanionRuntime,
  projectDshCompanionEvidence,
  selectSoulReadyProbeCharacter,
} from "./probe-chat-service";

const auditActor = {
  id: "seed-chat-probe-user",
  dataClass: "audit",
  role: "user",
  status: "active",
  deletedAt: null,
};

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

  it("projects a settled allowlisted DSH turn without exposing the raw trace", () => {
    const evidence = projectDshCompanionEvidence({
      companionRuntime: {
        runtime: "dsh",
        memoryBackend: "igrep-dsh",
        profile: "idream-companion-memory",
        private: false,
        sidecarUrl: "http://127.0.0.1:3101",
        assignment: { policyVersion: 1, reason: "allowlist" },
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
    }, "normal");

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

  it("fails closed when the DSH private pin did not enforce the no-memory boundary", () => {
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
    expect(evidence.error).toContain("outputAuthority");
    expect(evidence.error).toContain("primaryTelemetry.memory.outcome");
  });
});
