import { describe, expect, it } from "vitest";
import {
  evaluateDshImageToolSnapshot,
  projectDshImageToolTrace,
  type DshImageToolAuditSnapshot,
  type DshImageToolLegSnapshot,
  type DshImageToolName,
} from "./dsh-image-tool-e2e-evidence";

const SOURCE_ASSET_ID = "asset-generate";

function identity(name: DshImageToolName) {
  const suffix = name === "generate_image_async" ? "generate" : "edit";
  return {
    assistantMessageId: `assistant-${suffix}`,
    attempt: 1,
    attemptId: `assistant-${suffix}:1`,
    callId: `call-${suffix}`,
    name,
  } as const;
}

function toolIdentity(name: DshImageToolName) {
  const value = identity(name);
  return {
    attemptId: value.attemptId,
    callId: value.callId,
    name: value.name,
  };
}

function completedTrace(name: DshImageToolName) {
  const value = identity(name);
  return {
    companionRuntime: { runtime: "dsh", memoryBackend: "igrep-dsh" },
    companionTool: {
      attemptId: value.attemptId,
      callId: value.callId,
      name,
      arguments: name === "generate_image_async"
        ? {
            prompt: "PRIVATE PROMPT MUST NEVER ENTER THE REPORT",
            caption: "PRIVATE CAPTION MUST NEVER ENTER THE REPORT",
            orientation: "4:5",
            outputCount: 1,
          }
        : {
            instruction: "PRIVATE EDIT INSTRUCTION MUST NEVER ENTER THE REPORT",
            caption: "PRIVATE EDIT CAPTION MUST NEVER ENTER THE REPORT",
          },
    },
    companion: {
      toolResult: {
        attemptId: value.attemptId,
        callId: value.callId,
        name,
        outcome: "succeeded",
        output: {
          status: "accepted_for_terminal_commit",
          effectId: `${value.attemptId}:${value.callId}`,
        },
      },
      execution: { steps: 2, toolCalls: 1 },
    },
    primaryTelemetry: {
      runtime: "dsh",
      terminalStatus: "sent",
      truncated: false,
      toolCalls: 1,
    },
  };
}

function completedAttachment(name: DshImageToolName) {
  const value = identity(name);
  const suffix = name === "generate_image_async" ? "generate" : "edit";
  return {
    id: `attachment-${suffix}`,
    kind: "generated_image",
    status: "completed",
    generationJobId: `request-${suffix}`,
    mediaAssetId: `asset-${suffix}`,
    metadata: {
      toolCallIdentity: {
        attemptId: value.attemptId,
        callId: value.callId,
      },
      toolName: name,
      ...(name === "edit_last_image" ? { editSourceAssetId: SOURCE_ASSET_ID } : {}),
      assistantCaption: "PRIVATE ATTACHMENT CAPTION MUST NEVER ENTER THE REPORT",
    },
  };
}

function projected(name: DshImageToolName) {
  const value = identity(name);
  return projectDshImageToolTrace(
    completedTrace(name),
    [completedAttachment(name)],
    {
      assistantMessageId: value.assistantMessageId,
      attempt: value.attempt,
      name,
      ...(name === "edit_last_image" ? { sourceAssetId: SOURCE_ASSET_ID } : {}),
    },
  );
}

function goodLeg(name: DshImageToolName): DshImageToolLegSnapshot {
  const suffix = name === "generate_image_async" ? "generate" : "edit";
  const startSecond = name === "generate_image_async" ? "05" : "25";
  const endSecond = name === "generate_image_async" ? "15" : "35";
  const sourceImageAssetId = name === "edit_last_image" ? SOURCE_ASSET_ID : null;
  return {
    companion: {
      ok: true,
      runtime: "dsh",
      provider: "local-openai",
      model: "qwen3.6-35b",
      profileDigest: suffix.repeat(8),
      requestId: `chatcmpl-${suffix}`,
      sidecarInstanceId: `${suffix}-sidecar`,
    },
    trace: projected(name),
    chatRequestOutboxes: [{
      id: `chat-outbox-${suffix}`,
      status: "delivered",
      attempts: 0,
      createdAt: `2026-08-20T12:00:${startSecond}.000Z`,
      deliveredAt: `2026-08-20T12:00:${Number(startSecond) + 1}.000Z`,
    }],
    mainReceipt: {
      id: `main-receipt-${suffix}`,
      sourceEventId: `chat-outbox-${suffix}`,
      processingState: "processed",
    },
    jobs: [{
      id: `request-${suffix}`,
      sourceId: `attachment-${suffix}`,
      mode: "image",
      status: "completed",
      outputCount: 1,
      deliveredOutputCount: 1,
      costDreamcoins: name === "generate_image_async" ? 7 : 9,
      sourceImageAssetId,
      createdAt: `2026-08-20T12:00:${startSecond}.000Z`,
      completedAt: `2026-08-20T12:00:${endSecond}.000Z`,
    }],
    attempts: [{
      id: `attempt-${suffix}`,
      requestId: `request-${suffix}`,
      attemptNo: 1,
      status: "succeeded",
      provider: "local-comfyui",
      profileKey: name === "generate_image_async" ? "chat-image" : "chat-image-edit",
      profileVersion: 3,
      workflowKey: name === "generate_image_async" ? "qwen-image" : "qwen-image-edit-img2img",
      workflowVersion: 9,
      startedAt: `2026-08-20T12:00:${startSecond}.000Z`,
      finishedAt: `2026-08-20T12:00:${endSecond}.000Z`,
    }],
    transports: [{
      attemptId: `attempt-${suffix}`,
      transportAttemptNo: 1,
      status: "succeeded",
      latencyMs: 10_000,
      costMicros: name === "generate_image_async" ? "24000" : null,
    }],
    artifacts: [{
      id: `artifact-${suffix}`,
      attemptId: `attempt-${suffix}`,
      assetId: `asset-${suffix}`,
      validationState: "valid",
      archiveState: "active",
    }],
    deliveries: [{
      requestId: `request-${suffix}`,
      artifactId: `artifact-${suffix}`,
      status: "delivered",
      targetId: "seed-chat-probe-user",
    }],
    mainCallbacks: [{
      id: `chat_image_completed_attachment-${suffix}_request-${suffix}_asset-${suffix}`,
      eventType: "chat.image.completed",
      aggregateId: `attachment-${suffix}`,
      status: "delivered",
    }],
    persistenceOk: true,
  };
}

function goodSnapshot(): DshImageToolAuditSnapshot {
  return {
    checkedAt: "2026-08-20T12:00:00.000Z",
    observedAt: "2026-08-20T12:01:00.000Z",
    actor: {
      userId: "seed-chat-probe-user",
      dataClass: "audit",
      signedBff: true,
    },
    legs: {
      generate: goodLeg("generate_image_async"),
      edit: goodLeg("edit_last_image"),
    },
    cleanup: {
      sessionGone: true,
      relationshipsGone: true,
      recentChatDeleted: true,
      sourceTextRedacted: true,
    },
  };
}

describe("DSH image-tool E2E evidence", () => {
  it.each(["generate_image_async", "edit_last_image"] as const)(
    "projects a real, current-attempt %s result without content bytes",
    (name) => {
      const evidence = projected(name);
      expect(evidence).toMatchObject({
        ok: true,
        runtime: "dsh",
        memoryBackend: "igrep-dsh",
        intent: toolIdentity(name),
        result: {
          ...toolIdentity(name),
          outcome: "succeeded",
          status: "accepted_for_terminal_commit",
        },
        executionToolCalls: 1,
        attachment: {
          sourceAssetId: name === "edit_last_image" ? SOURCE_ASSET_ID : null,
        },
        error: null,
      });
      const serialized = JSON.stringify(evidence);
      expect(serialized).not.toContain("PRIVATE");
      expect(serialized).not.toContain("instruction");
      expect(serialized).not.toContain("caption");
    },
  );

  it("fails closed on stale attempt, bad result identity/name/output, and duplicate attachment", () => {
    const value = identity("generate_image_async");
    expect(projectDshImageToolTrace(completedTrace(value.name), [completedAttachment(value.name)], {
      assistantMessageId: "different-assistant",
      attempt: 1,
      name: value.name,
    })).toMatchObject({ ok: false, error: expect.stringContaining("tool_intent_attempt_identity") });
    expect(projectDshImageToolTrace(completedTrace(value.name), [completedAttachment(value.name)], {
      assistantMessageId: value.assistantMessageId,
      attempt: 2,
      name: value.name,
    })).toMatchObject({ ok: false, error: expect.stringContaining("tool_intent_attempt_identity") });

    for (const mutate of [
      (trace: ReturnType<typeof completedTrace>) => {
        (trace.companion.toolResult as { callId: string }).callId = "wrong-call";
      },
      (trace: ReturnType<typeof completedTrace>) => {
        (trace.companion.toolResult as { name: string }).name = "edit_last_image";
      },
      (trace: ReturnType<typeof completedTrace>) => {
        (trace.companion.toolResult.output as Record<string, unknown>).private = "must fail";
      },
    ]) {
      const trace = completedTrace(value.name);
      mutate(trace);
      expect(projectDshImageToolTrace(trace, [completedAttachment(value.name)], {
        assistantMessageId: value.assistantMessageId,
        attempt: value.attempt,
        name: value.name,
      })).toMatchObject({ ok: false, error: expect.stringContaining("tool_result") });
    }

    expect(projectDshImageToolTrace(
      completedTrace(value.name),
      [completedAttachment(value.name), { ...completedAttachment(value.name), id: "duplicate" }],
      { assistantMessageId: value.assistantMessageId, attempt: value.attempt, name: value.name },
    )).toMatchObject({
      ok: false,
      error: expect.stringContaining("single_generated_image_attachment"),
    });
  });

  it("accepts exactly one attributable generation followed by one exact-source edit", () => {
    const report = evaluateDshImageToolSnapshot(goodSnapshot());
    expect(report).toMatchObject({
      ok: true,
      legs: {
        generate: {
          tool: { intent: { name: "generate_image_async" }, result: { outcome: "succeeded" } },
          generation: {
            requestId: "request-generate",
            attemptId: "attempt-generate",
            artifactId: "artifact-generate",
            mediaAssetId: SOURCE_ASSET_ID,
            sourceImageAssetId: null,
            provider: "local-comfyui",
            workflowKey: "qwen-image",
            costAuthority: "transport_and_dreamcoins",
          },
        },
        edit: {
          tool: { intent: { name: "edit_last_image" }, result: { outcome: "succeeded" } },
          chat: { sourceAssetId: SOURCE_ASSET_ID },
          generation: {
            requestId: "request-edit",
            attemptId: "attempt-edit",
            artifactId: "artifact-edit",
            mediaAssetId: "asset-edit",
            sourceImageAssetId: SOURCE_ASSET_ID,
            workflowKey: "qwen-image-edit-img2img",
            costAuthority: "dreamcoins",
          },
        },
      },
      cleanup: { sessionGone: true, sourceTextRedacted: true },
      error: null,
    });
  });

  it.each([
    ["duplicate generate request", (snapshot: DshImageToolAuditSnapshot) => {
      snapshot.legs.generate.jobs.push({ ...snapshot.legs.generate.jobs[0]!, id: "duplicate" });
    }],
    ["duplicate edit attempt", (snapshot: DshImageToolAuditSnapshot) => {
      snapshot.legs.edit.attempts.push({ ...snapshot.legs.edit.attempts[0]!, id: "duplicate" });
    }],
    ["duplicate artifact", (snapshot: DshImageToolAuditSnapshot) => {
      snapshot.legs.generate.artifacts.push({
        ...snapshot.legs.generate.artifacts[0]!,
        id: "artifact-duplicate",
      });
    }],
    ["failed callback alongside completion", (snapshot: DshImageToolAuditSnapshot) => {
      snapshot.legs.edit.mainCallbacks.push({
        ...snapshot.legs.edit.mainCallbacks[0]!,
        id: "chat_image_failed_attachment-edit",
        eventType: "chat.image.failed",
        status: "delivered",
      });
    }],
    ["wrong edit source", (snapshot: DshImageToolAuditSnapshot) => {
      snapshot.legs.edit.jobs[0]!.sourceImageAssetId = "wrong-source";
    }],
    ["reused artifact identity", (snapshot: DshImageToolAuditSnapshot) => {
      snapshot.legs.edit.artifacts[0]!.id = "artifact-generate";
    }],
    ["missing cleanup", (snapshot: DshImageToolAuditSnapshot) => {
      snapshot.cleanup.sourceTextRedacted = false;
    }],
  ] as const)("fails closed on %s", (_label, mutate) => {
    const snapshot = goodSnapshot();
    mutate(snapshot);
    const report = evaluateDshImageToolSnapshot(snapshot);
    expect(report.ok).toBe(false);
    expect(report.error).not.toBeNull();
  });
});
