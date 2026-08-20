import {
  companionToolReservationSchema,
  companionToolResultSchema,
} from "@idream/shared";

export type DshImageToolName = "generate_image_async" | "edit_last_image";

type ToolIdentity = {
  attemptId: string;
  callId: string;
  name: DshImageToolName;
};

export type DshImageToolTraceEvidence = {
  ok: boolean;
  runtime?: "dsh";
  memoryBackend?: "igrep-dsh";
  intent?: ToolIdentity;
  result?: ToolIdentity & {
    outcome: "succeeded";
    status: "accepted_for_terminal_commit";
  };
  executionToolCalls?: number;
  attachment?: {
    id: string;
    status: string;
    generationJobId: string;
    mediaAssetId: string;
    sourceAssetId: string | null;
  };
  error: string | null;
};

type AuditAttachment = {
  id?: unknown;
  kind?: unknown;
  status?: unknown;
  generationJobId?: unknown;
  mediaAssetId?: unknown;
  metadata?: unknown;
};

type ExpectedToolTurn = {
  assistantMessageId: string;
  attempt: number;
  name: DshImageToolName;
  sourceAssetId?: string;
};

/**
 * INVARIANT: reports contain only identity and terminal facts. Raw arguments,
 * prompts, captions, answer bytes and sidecar trace never cross this boundary.
 */
export function projectDshImageToolTrace(
  value: unknown,
  attachments: readonly AuditAttachment[],
  expected: ExpectedToolTurn,
): DshImageToolTraceEvidence {
  const trace = record(value);
  const runtime = record(trace.companionRuntime);
  const companion = record(trace.companion);
  const execution = record(companion.execution);
  const primaryTelemetry = record(trace.primaryTelemetry);
  const intentResult = companionToolReservationSchema.safeParse(trace.companionTool);
  const toolResult = companionToolResultSchema.safeParse(companion.toolResult);
  const expectedAttemptId = `${expected.assistantMessageId}:${expected.attempt}`;
  const intent = intentResult.success &&
      intentResult.data.name === expected.name &&
      intentResult.data.attemptId === expectedAttemptId
    ? identity(intentResult.data)
    : null;
  const succeededResult = toolResult.success && toolResult.data.outcome === "succeeded"
    ? toolResult.data
    : null;
  const resultOutput = record(succeededResult?.output);
  const exactResultOutput = succeededResult !== null &&
    resultOutput.status === "accepted_for_terminal_commit" &&
    Object.keys(resultOutput).sort().join(",") === "effectId,status";
  const resultBindsIntent = intent !== null &&
    succeededResult !== null &&
    succeededResult.attemptId === intent.attemptId &&
    succeededResult.name === intent.name &&
    resultOutput.effectId === `${intent.attemptId}:${intent.callId}` &&
    exactResultOutput;
  const generated = attachments.filter((attachment) => attachment.kind === "generated_image");
  const attachment = generated.length === 1 ? generated[0]! : null;
  const attachmentMetadata = record(attachment?.metadata);
  const attachmentIdentity = record(attachmentMetadata.toolCallIdentity);
  const attachmentSource = text(attachmentMetadata.editSourceAssetId);
  const expectedSource = expected.sourceAssetId ?? null;
  const failures: string[] = [];
  const expect = (condition: boolean, name: string) => {
    if (!condition) failures.push(name);
  };

  expect(
    runtime.runtime === "dsh" && runtime.memoryBackend === "igrep-dsh",
    "runtime_authority",
  );
  expect(intent !== null, "tool_intent_attempt_identity");
  expect(
    resultBindsIntent,
    "tool_result",
  );
  expect(
    execution.toolCalls === 1 &&
      primaryTelemetry.toolCalls === 1 &&
      primaryTelemetry.terminalStatus === "sent" &&
      primaryTelemetry.truncated === false,
    "tool_result_execution",
  );
  expect(generated.length === 1, "single_generated_image_attachment");
  expect(
    attachment?.status === "completed" &&
      text(attachment.generationJobId) !== null &&
      text(attachment.mediaAssetId) !== null,
    "attachment_terminal_delivery",
  );
  expect(
    intent !== null &&
      attachmentIdentity.attemptId === intent.attemptId &&
      attachmentIdentity.callId === intent.callId &&
      attachmentMetadata.toolName === intent.name,
    "attachment_tool_identity",
  );
  expect(attachmentSource === expectedSource, "attachment_source_asset");

  const generationJobId = text(attachment?.generationJobId);
  const mediaAssetId = text(attachment?.mediaAssetId);
  const attachmentId = text(attachment?.id);
  const result = resultBindsIntent && intent
    ? {
        ...intent,
        outcome: "succeeded" as const,
        status: "accepted_for_terminal_commit" as const,
      }
    : null;
  return {
    ok: failures.length === 0,
    ...(runtime.runtime === "dsh" ? { runtime: "dsh" as const } : {}),
    ...(runtime.memoryBackend === "igrep-dsh" ? { memoryBackend: "igrep-dsh" as const } : {}),
    ...(intent ? { intent } : {}),
    ...(result ? { result } : {}),
    ...(typeof execution.toolCalls === "number"
      ? { executionToolCalls: execution.toolCalls }
      : {}),
    ...(attachmentId && generationJobId && mediaAssetId && typeof attachment?.status === "string"
      ? {
          attachment: {
            id: attachmentId,
            status: attachment.status,
            generationJobId,
            mediaAssetId,
            sourceAssetId: attachmentSource,
          },
        }
      : {}),
    error: failures.length === 0
      ? null
      : `DSH image tool trace failed: ${failures.join(", ")}`,
  };
}

export type DshImageToolLegSnapshot = {
  companion: {
    ok: boolean;
    runtime?: string;
    provider?: string;
    model?: string;
    profileDigest?: string;
    requestId?: string;
    sidecarInstanceId?: string;
  };
  trace: DshImageToolTraceEvidence;
  chatRequestOutboxes: Array<{
    id: string;
    status: string;
    attempts: number;
    createdAt: string;
    deliveredAt: string | null;
  }>;
  mainReceipt: {
    id: string;
    sourceEventId: string;
    processingState: string;
  } | null;
  jobs: Array<{
    id: string;
    sourceId: string | null;
    mode: string;
    status: string;
    outputCount: number;
    deliveredOutputCount: number;
    costDreamcoins: number;
    sourceImageAssetId: string | null;
    createdAt: string;
    completedAt: string | null;
  }>;
  attempts: Array<{
    id: string;
    requestId: string;
    attemptNo: number;
    status: string;
    provider: string | null;
    profileKey: string | null;
    profileVersion: number | null;
    workflowKey: string | null;
    workflowVersion: number | null;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
  transports: Array<{
    attemptId: string;
    transportAttemptNo: number;
    status: string;
    latencyMs: number | null;
    costMicros: string | null;
  }>;
  artifacts: Array<{
    id: string;
    attemptId: string;
    assetId: string | null;
    validationState: string;
    archiveState: string;
  }>;
  deliveries: Array<{
    requestId: string;
    artifactId: string;
    status: string;
    targetId: string;
  }>;
  mainCallbacks: Array<{
    id: string;
    eventType: string;
    aggregateId: string;
    status: string;
  }>;
  persistenceOk: boolean;
};

export type DshImageToolAuditSnapshot = {
  checkedAt: string;
  observedAt: string;
  actor: {
    userId: string;
    dataClass: "audit";
    signedBff: true;
  };
  legs: {
    generate: DshImageToolLegSnapshot;
    edit: DshImageToolLegSnapshot;
  };
  cleanup: {
    sessionGone: boolean;
    relationshipsGone: boolean;
    recentChatDeleted: boolean;
    sourceTextRedacted: boolean;
  };
};

type DshImageToolLegReport = {
  companion: DshImageToolLegSnapshot["companion"];
  tool: {
    intent: ToolIdentity | null;
    result: DshImageToolTraceEvidence["result"] | null;
    executionToolCalls: number | null;
  };
  chat: {
    attachmentId: string | null;
    sourceAssetId: string | null;
    requestOutboxId: string | null;
    requestOutboxStatus: string | null;
    requestOutboxDeliveryMs: number | null;
    mainReceiptId: string | null;
    mainReceiptState: string | null;
    completionCallbackId: string | null;
    completionCallbackStatus: string | null;
  };
  generation: {
    requestId: string | null;
    attemptId: string | null;
    attemptNo: number | null;
    attemptCount: number;
    artifactId: string | null;
    mediaAssetId: string | null;
    sourceImageAssetId: string | null;
    provider: string | null;
    profileKey: string | null;
    profileVersion: number | null;
    workflowKey: string | null;
    workflowVersion: number | null;
    requestDurationMs: number | null;
    attemptDurationMs: number | null;
    transportLatencyMs: number | null;
    costDreamcoins: number | null;
    transportCostMicros: string | null;
    costAuthority: "transport_and_dreamcoins" | "dreamcoins" | null;
  };
};

export type DshImageToolAuditReport = {
  ok: boolean;
  checkedAt: string;
  observedAt: string;
  durationMs: number | null;
  actor: DshImageToolAuditSnapshot["actor"];
  legs: {
    generate: DshImageToolLegReport | null;
    edit: DshImageToolLegReport | null;
  };
  cleanup: DshImageToolAuditSnapshot["cleanup"];
  error: string | null;
};

/** Decide both paid legs from immutable, content-free authority facts. */
export function evaluateDshImageToolSnapshot(
  snapshot: DshImageToolAuditSnapshot,
): DshImageToolAuditReport {
  const problems: string[] = [];
  if (
    snapshot.actor.userId !== "seed-chat-probe-user" ||
    snapshot.actor.dataClass !== "audit" ||
    snapshot.actor.signedBff !== true
  ) {
    problems.push("signed_audit_actor");
  }
  const generate = evaluateLeg(
    "generate_image_async",
    snapshot.legs.generate,
    snapshot.actor,
    problems,
  );
  const edit = evaluateLeg(
    "edit_last_image",
    snapshot.legs.edit,
    snapshot.actor,
    problems,
  );
  const generateAssetId = generate.generation.mediaAssetId;
  if (
    !generateAssetId ||
    edit.chat.sourceAssetId !== generateAssetId ||
    edit.generation.sourceImageAssetId !== generateAssetId
  ) {
    problems.push("edit_exact_source_artifact");
  }
  const crossLegIdentities = [
    [generate.tool.intent?.attemptId, edit.tool.intent?.attemptId],
    [generate.tool.intent?.callId, edit.tool.intent?.callId],
    [generate.chat.attachmentId, edit.chat.attachmentId],
    [generate.chat.requestOutboxId, edit.chat.requestOutboxId],
    [generate.chat.mainReceiptId, edit.chat.mainReceiptId],
    [generate.generation.requestId, edit.generation.requestId],
    [generate.generation.attemptId, edit.generation.attemptId],
    [generate.generation.artifactId, edit.generation.artifactId],
    [generate.generation.mediaAssetId, edit.generation.mediaAssetId],
  ];
  if (crossLegIdentities.some(([first, second]) => !first || first === second)) {
    problems.push("distinct_generate_edit_effects");
  }
  if (Object.values(snapshot.cleanup).some((value) => value !== true)) {
    problems.push("audit_cleanup");
  }
  const totalDurationMs = duration(snapshot.checkedAt, snapshot.observedAt);
  if (totalDurationMs === null) problems.push("probe_duration");

  return {
    ok: problems.length === 0,
    checkedAt: snapshot.checkedAt,
    observedAt: snapshot.observedAt,
    durationMs: totalDurationMs,
    actor: snapshot.actor,
    legs: { generate, edit },
    cleanup: snapshot.cleanup,
    error: problems.length === 0
      ? null
      : `DSH image tool E2E failed: ${[...new Set(problems)].join(", ")}`,
  };
}

function evaluateLeg(
  expectedName: DshImageToolName,
  snapshot: DshImageToolLegSnapshot,
  actor: DshImageToolAuditSnapshot["actor"],
  problems: string[],
): DshImageToolLegReport {
  const prefix = expectedName === "generate_image_async" ? "generate" : "edit";
  const trace = snapshot.trace;
  const attachment = trace.attachment;
  const requestOutbox = exactlyOne(snapshot.chatRequestOutboxes, problems, `${prefix}_chat_request_outbox`);
  const job = exactlyOne(snapshot.jobs, problems, `${prefix}_generation_request`);
  const attempt = exactlyOne(snapshot.attempts, problems, `${prefix}_attempt`);
  const transport = exactlyOne(snapshot.transports, problems, `${prefix}_transport`);
  const artifact = exactlyOne(snapshot.artifacts, problems, `${prefix}_artifact`);
  const delivery = exactlyOne(snapshot.deliveries, problems, `${prefix}_delivery`);
  const callback = exactlyOne(snapshot.mainCallbacks, problems, `${prefix}_callback`);

  if (!snapshot.companion.ok || snapshot.companion.runtime !== "dsh") {
    problems.push(`${prefix}_dsh_companion_authority`);
  }
  if (!trace.ok || trace.intent?.name !== expectedName) {
    problems.push(`${prefix}_tool_trace`);
  }
  if (!requestOutbox || requestOutbox.status !== "delivered" || !requestOutbox.deliveredAt) {
    problems.push(`${prefix}_chat_request_outbox_delivery`);
  }
  if (
    !snapshot.mainReceipt ||
    snapshot.mainReceipt.sourceEventId !== requestOutbox?.id ||
    snapshot.mainReceipt.processingState !== "processed"
  ) {
    problems.push(`${prefix}_main_request_receipt`);
  }
  const expectedSourceAssetId = expectedName === "edit_last_image"
    ? attachment?.sourceAssetId ?? null
    : null;
  if (
    !job ||
    job.id !== attachment?.generationJobId ||
    job.sourceId !== attachment?.id ||
    job.sourceImageAssetId !== expectedSourceAssetId ||
    job.mode !== "image" ||
    job.status !== "completed" ||
    job.outputCount !== 1 ||
    job.deliveredOutputCount !== 1 ||
    !job.completedAt
  ) {
    problems.push(`${prefix}_generation_request_terminal`);
  }
  if (
    !attempt ||
    attempt.status !== "succeeded" ||
    attempt.requestId !== job?.id ||
    !text(attempt.provider) ||
    !text(attempt.workflowKey) ||
    !positiveInteger(attempt.workflowVersion) ||
    !attempt.startedAt ||
    !attempt.finishedAt
  ) {
    problems.push(`${prefix}_generation_attempt_attribution`);
  }
  if (
    !transport ||
    transport.attemptId !== attempt?.id ||
    transport.status !== "succeeded" ||
    !nonNegativeInteger(transport.latencyMs)
  ) {
    problems.push(`${prefix}_generation_transport`);
  }
  if (
    !artifact ||
    artifact.attemptId !== attempt?.id ||
    artifact.assetId !== attachment?.mediaAssetId ||
    artifact.validationState !== "valid" ||
    artifact.archiveState !== "active"
  ) {
    problems.push(`${prefix}_single_valid_artifact`);
  }
  if (
    !delivery ||
    delivery.requestId !== job?.id ||
    delivery.artifactId !== artifact?.id ||
    delivery.status !== "delivered" ||
    delivery.targetId !== actor.userId
  ) {
    problems.push(`${prefix}_single_artifact_delivery`);
  }
  const expectedCallbackId = attachment && job
    ? `chat_image_completed_${attachment.id}_${job.id}_${attachment.mediaAssetId}`
    : null;
  if (
    !callback ||
    callback.id !== expectedCallbackId ||
    callback.eventType !== "chat.image.completed" ||
    callback.aggregateId !== attachment?.id ||
    callback.status !== "delivered"
  ) {
    problems.push(`${prefix}_chat_completion_delivery`);
  }
  if (!snapshot.persistenceOk) problems.push(`${prefix}_persistence_authority`);
  if (!nonNegativeInteger(job?.costDreamcoins)) problems.push(`${prefix}_cost_authority`);
  if (
    transport?.costMicros !== null &&
    transport?.costMicros !== undefined &&
    !/^\d+$/u.test(transport.costMicros)
  ) {
    problems.push(`${prefix}_transport_cost_authority`);
  }
  const requestDurationMs = duration(job?.createdAt, job?.completedAt);
  const attemptDurationMs = duration(attempt?.startedAt, attempt?.finishedAt);
  const requestOutboxDeliveryMs = duration(requestOutbox?.createdAt, requestOutbox?.deliveredAt);
  if (requestDurationMs === null || attemptDurationMs === null) problems.push(`${prefix}_duration`);

  return {
    companion: snapshot.companion,
    tool: {
      intent: trace.intent ?? null,
      result: trace.result ?? null,
      executionToolCalls: trace.executionToolCalls ?? null,
    },
    chat: {
      attachmentId: attachment?.id ?? null,
      sourceAssetId: attachment?.sourceAssetId ?? null,
      requestOutboxId: requestOutbox?.id ?? null,
      requestOutboxStatus: requestOutbox?.status ?? null,
      requestOutboxDeliveryMs,
      mainReceiptId: snapshot.mainReceipt?.id ?? null,
      mainReceiptState: snapshot.mainReceipt?.processingState ?? null,
      completionCallbackId: callback?.id ?? null,
      completionCallbackStatus: callback?.status ?? null,
    },
    generation: {
      requestId: job?.id ?? null,
      attemptId: attempt?.id ?? null,
      attemptNo: attempt?.attemptNo ?? null,
      attemptCount: snapshot.attempts.length,
      artifactId: artifact?.id ?? null,
      mediaAssetId: artifact?.assetId ?? null,
      sourceImageAssetId: job?.sourceImageAssetId ?? null,
      provider: attempt?.provider ?? null,
      profileKey: attempt?.profileKey ?? null,
      profileVersion: attempt?.profileVersion ?? null,
      workflowKey: attempt?.workflowKey ?? null,
      workflowVersion: attempt?.workflowVersion ?? null,
      requestDurationMs,
      attemptDurationMs,
      transportLatencyMs: transport?.latencyMs ?? null,
      costDreamcoins: job?.costDreamcoins ?? null,
      transportCostMicros: transport?.costMicros ?? null,
      costAuthority: job && nonNegativeInteger(job.costDreamcoins)
        ? transport?.costMicros === null || transport?.costMicros === undefined
          ? "dreamcoins"
          : "transport_and_dreamcoins"
        : null,
    },
  };
}

function identity(value: { attemptId: string; callId: string; name: DshImageToolName }): ToolIdentity {
  return { attemptId: value.attemptId, callId: value.callId, name: value.name };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function exactlyOne<T>(values: readonly T[], problems: string[], name: string): T | null {
  if (values.length === 1) return values[0]!;
  problems.push(`${name}_count_${values.length}`);
  return null;
}

function duration(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const value = Date.parse(to) - Date.parse(from);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
