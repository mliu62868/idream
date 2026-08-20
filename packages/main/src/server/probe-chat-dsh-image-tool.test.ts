import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  signedFetch: vi.fn(),
  preflightCleanup: vi.fn(),
  completedCleanup: vi.fn(),
  probeStream: vi.fn(),
}));

vi.mock("./lib/db", () => ({
  prisma: {
    user: { findUnique: mocks.findUser },
    $disconnect: vi.fn(async () => undefined),
  },
}));

vi.mock("./probe-chat-service", () => ({
  assertDedicatedChatProbeActor: vi.fn(() => ({
    actorDataClass: "audit",
    dedicatedActor: true,
  })),
  cleanupCompletedProbeState: mocks.completedCleanup,
  cleanupExistingProbeState: mocks.preflightCleanup,
  probeStream: mocks.probeStream,
  projectDshCompanionEvidence: vi.fn(() => ({
    ok: true,
    runtime: "dsh",
    provider: "local-openai",
    model: "qwen3.6-35b",
  })),
  signedFetch: mocks.signedFetch,
}));

vi.mock("./probe-generation-persistence", () => ({
  inspectGenerationPersistence: vi.fn(),
}));

import {
  chatProjectionReceiptSourceService,
  classifyDshImageToolMainCleanup,
  dshImageToolProbeExitCode,
  runDshImageToolProbe,
} from "./probe-chat-dsh-image-tool";

const input = {
  serviceUrl: "http://127.0.0.1:3100",
  secret: "SIGNED-SECRET-MUST-NOT-LEAK",
  chatAuditDatabaseUrl: "postgresql://unused-by-this-failure-test",
  userId: "seed-chat-probe-user",
  characterId: "lola-moonstruck",
  timeoutMs: 100,
};

function json(value: unknown, status: number) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUser.mockResolvedValue({
    id: "seed-chat-probe-user",
    dataClass: "audit",
    role: "user",
    status: "active",
    deletedAt: null,
  });
  mocks.preflightCleanup.mockResolvedValue({ ok: true });
  mocks.completedCleanup.mockResolvedValue({
    ok: true,
    sessionGone: true,
    relationshipsGone: true,
  });
  mocks.probeStream.mockResolvedValue({
    ok: true,
    sawStart: true,
    sawDelta: true,
    sawDone: true,
  });
  mocks.signedFetch.mockImplementation(async (request: { path: string; method: string }) => {
    if (request.path === "/api/v1/chat/sessions" && request.method === "POST") {
      return json({ id: "session-audit" }, 201);
    }
    if (request.path === "/api/v1/chat/sessions/session-audit/messages") {
      return json({ error: "provider prompt echo must remain private" }, 503);
    }
    throw new Error(`unexpected request ${request.method} ${request.path}`);
  });
});

describe("signed DSH image-tool probe orchestration", () => {
  it("uses the product projector receipt namespace", () => {
    expect(chatProjectionReceiptSourceService("chat")).toBe(
      "main.product_projection:chat",
    );
  });

  it("treats physical RecentChat deletion and redaction metadata as cleanup authority", () => {
    expect(classifyDshImageToolMainCleanup({
      recentStatus: null,
      expectedJobCount: 1,
      jobSourceMeta: [{
        sessionId: "deleted-session",
        privacyRedaction: { reason: "session_deleted" },
      }],
    })).toEqual({ recentChatDeleted: true, sourceTextRedacted: true });

    expect(classifyDshImageToolMainCleanup({
      recentStatus: "active",
      expectedJobCount: 1,
      jobSourceMeta: [{ privacyRedaction: { reason: "session_deleted" } }],
    })).toEqual({ recentChatDeleted: false, sourceTextRedacted: true });
  });

  it("issues one product write, does not retry it, cleans up, and returns content-free red evidence", async () => {
    const report = await runDshImageToolProbe(input);
    const messagePosts = mocks.signedFetch.mock.calls.filter(([request]) =>
      request.method === "POST" && request.path.endsWith("/messages")
    );

    expect(messagePosts).toHaveLength(1);
    expect(mocks.completedCleanup).toHaveBeenCalledOnce();
    expect(report).toMatchObject({
      ok: false,
      cleanup: {
        sessionGone: true,
        relationshipsGone: true,
        recentChatDeleted: false,
        sourceTextRedacted: false,
      },
      error: "DSH image tool E2E failed at generate_send_rejected_503",
    });
    expect(dshImageToolProbeExitCode(report)).toBe(1);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(input.secret);
    expect(serialized).not.toContain("provider prompt echo");
    expect(serialized).not.toContain("cobalt paper crane");
  });

  it("turns a cleanup exception into red cleanup evidence instead of throwing", async () => {
    mocks.completedCleanup.mockRejectedValueOnce(new Error("signed cleanup failed"));

    await expect(runDshImageToolProbe(input)).resolves.toMatchObject({
      ok: false,
      cleanup: {
        sessionGone: false,
        relationshipsGone: false,
      },
    });
  });

  it("reads the accepted assistant attempt instead of guessing it", async () => {
    mocks.signedFetch.mockImplementation(async (request: { path: string; method: string }) => {
      if (request.path === "/api/v1/chat/sessions" && request.method === "POST") {
        return json({ id: "session-audit" }, 201);
      }
      if (request.path.endsWith("/messages") && request.method === "POST") {
        return json({ assistantMessageId: "assistant-without-attempt" }, 202);
      }
      if (request.path === "/api/v1/chat/sessions/session-audit" && request.method === "GET") {
        return json({
          messages: [{
            id: "assistant-without-attempt",
            role: "assistant",
            status: "generating",
            attempt: 4,
          }],
        }, 200);
      }
      throw new Error(`unexpected request ${request.method} ${request.path}`);
    });

    await expect(runDshImageToolProbe(input)).resolves.toMatchObject({
      ok: false,
      error: "DSH image tool E2E failed at generate_turn_unsettled",
    });
    expect(mocks.probeStream).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantMessageId: "assistant-without-attempt",
        expectedAttempt: 4,
      }),
    );
  });

  it("does not retry the edit write after one successful generate leg", async () => {
    const generateIdentity = {
      attemptId: "assistant-generate:1",
      callId: "call-generate",
      name: "generate_image_async" as const,
    };
    mocks.signedFetch.mockImplementation(async (request: {
      path: string;
      method: string;
      idempotencyKey?: string;
    }) => {
      if (request.path === "/api/v1/chat/sessions" && request.method === "POST") {
        return json({ id: "session-audit" }, 201);
      }
      if (request.path.endsWith("/messages") && request.method === "POST") {
        return request.idempotencyKey?.includes(":generate:")
          ? json({ assistantMessageId: "assistant-generate", attempt: 1 }, 202)
          : json({ error: "private edit provider failure" }, 503);
      }
      if (request.path === "/api/v1/chat/sessions/session-audit" && request.method === "GET") {
        return json({
          messages: [{
            id: "assistant-generate",
            role: "assistant",
            status: "sent",
            attempt: 1,
            memoryExtractedAttempt: 1,
            runtimeTrace: {
              companionRuntime: { runtime: "dsh", memoryBackend: "igrep-dsh" },
              companionTool: {
                ...generateIdentity,
                arguments: {
                  prompt: "private generated image prompt",
                  orientation: "4:5",
                  outputCount: 1,
                },
              },
              companion: {
                execution: { steps: 2, toolCalls: 1 },
                toolResult: {
                  ...generateIdentity,
                  outcome: "succeeded",
                  output: {
                    status: "accepted_for_terminal_commit",
                    effectId: "assistant-generate:1:call-generate",
                  },
                },
              },
              primaryTelemetry: {
                terminalStatus: "sent",
                sseTerminal: "done",
                truncated: false,
                toolCalls: 1,
              },
            },
            attachments: [{
              id: "attachment-generate",
              kind: "generated_image",
              status: "completed",
              generationJobId: "request-generate",
              mediaAssetId: "asset-generate",
              metadata: {
                toolName: "generate_image_async",
                toolCallIdentity: {
                  attemptId: generateIdentity.attemptId,
                  callId: generateIdentity.callId,
                },
              },
            }],
          }],
        }, 200);
      }
      throw new Error(`unexpected request ${request.method} ${request.path}`);
    });

    const report = await runDshImageToolProbe(input);
    const messagePosts = mocks.signedFetch.mock.calls.filter(([request]) =>
      request.method === "POST" && request.path.endsWith("/messages")
    );
    expect(messagePosts).toHaveLength(2);
    expect(messagePosts.map(([request]) => request.idempotencyKey)).toEqual([
      expect.stringContaining(":generate:"),
      expect.stringContaining(":edit:"),
    ]);
    expect(report).toMatchObject({
      ok: false,
      error: "DSH image tool E2E failed at edit_send_rejected_503",
    });
    expect(JSON.stringify(report)).not.toContain("private edit provider failure");
    expect(JSON.stringify(report)).not.toContain("private generated image prompt");
  });
});
