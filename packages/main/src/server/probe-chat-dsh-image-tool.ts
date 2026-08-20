import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import "dotenv/config";
import { Client } from "pg";
import {
  CHAT_TO_MAIN_EVENTS,
  MAIN_TO_CHAT_EVENTS,
} from "@idream/shared";
import { prisma } from "./lib/db";
import {
  assertDedicatedChatProbeActor,
  cleanupCompletedProbeState,
  cleanupExistingProbeState,
  probeStream,
  projectDshCompanionEvidence,
  signedFetch,
} from "./probe-chat-service";
import { inspectGenerationPersistence } from "./probe-generation-persistence";
import {
  evaluateDshImageToolSnapshot,
  projectDshImageToolTrace,
  type DshImageToolAuditReport,
  type DshImageToolAuditSnapshot,
  type DshImageToolLegSnapshot,
  type DshImageToolName,
  type DshImageToolTraceEvidence,
} from "./dsh-image-tool-e2e-evidence";
import {
  probeCliArg,
  writeProbeReport,
} from "./readiness/probe-report";

const AUDIT_USER_ID = "seed-chat-probe-user";
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

type PublicAttachment = {
  id?: unknown;
  kind?: unknown;
  status?: unknown;
  generationJobId?: unknown;
  mediaAssetId?: unknown;
  metadata?: unknown;
};

type PublicMessage = {
  id?: unknown;
  role?: unknown;
  status?: unknown;
  attempt?: unknown;
  memoryExtractedAttempt?: unknown;
  attachments?: PublicAttachment[];
};

type ChatAttemptAudit = {
  attempt: number;
  status: string;
  memoryExtractedAttempt: number;
  runtimeTrace: unknown;
};

type ProbeInput = {
  serviceUrl: string;
  secret: string;
  chatAuditDatabaseUrl: string;
  userId: string;
  characterId: string;
  timeoutMs?: number;
};

type CollectedTurn = {
  trace: DshImageToolTraceEvidence;
  companion: DshImageToolLegSnapshot["companion"];
};

class DshImageToolProbeError extends Error {
  constructor(readonly stage: string) {
    super(stage);
  }
}

type DbJobRow = Omit<
  DshImageToolLegSnapshot["jobs"][number],
  "createdAt" | "completedAt" | "sourceImageAssetId"
> & { controls: unknown; createdAt: Date; completedAt: Date | null };
type DbAttemptRow = Omit<
  DshImageToolLegSnapshot["attempts"][number],
  "startedAt" | "finishedAt"
> & { startedAt: Date | null; finishedAt: Date | null };
type DbTransportRow = Omit<
  DshImageToolLegSnapshot["transports"][number],
  "costMicros"
> & { costMicros: bigint | null };

/**
 * SPEC: one invocation creates one generate turn and one dependent edit turn.
 * Each signed product write happens once; failures return red evidence and are
 * never retried to make the probe green.
 */
export async function runDshImageToolProbe(
  input: ProbeInput,
): Promise<DshImageToolAuditReport> {
  const checkedAt = new Date().toISOString();
  const runId = randomUUID();
  const timeoutMs = positiveTimeout(input.timeoutMs);
  let sessionId: string | null = null;
  let generate: CollectedTurn | null = null;
  let edit: CollectedTurn | null = null;
  let stage = "actor_authority";
  let cleanup = emptyCleanup();

  try {
    const actor = await prisma.user.findUnique({
      where: { id: input.userId },
      select: {
        id: true,
        role: true,
        status: true,
        dataClass: true,
        deletedAt: true,
      },
    });
    assertDedicatedChatProbeActor(actor, input.userId);

    stage = "preflight_cleanup";
    const preflight = await cleanupExistingProbeState(input);
    if (!preflight.ok) throw new Error("preflight cleanup failed");

    stage = "session_create";
    const create = await signedFetch({
      ...input,
      method: "POST",
      path: "/api/v1/chat/sessions",
      body: JSON.stringify({ characterId: input.characterId }),
    });
    const created = await create.json().catch(() => ({})) as { id?: unknown };
    sessionId = text(created.id);
    if (create.status !== 201 || !sessionId) {
      throw new Error("session create failed");
    }

    stage = "generate_tool_turn";
    generate = await sendAndCollectToolTurn({
      ...input,
      sessionId,
      timeoutMs,
      name: "generate_image_async",
      content:
        "Use generate_image_async exactly once now. Create one 4:5 candid " +
        `rooftop-garden portrait with a small cobalt paper crane, audit nonce ${runId}.`,
      idempotencyKey: `chat-dsh-image-probe:generate:${runId}`,
    });
    if (!generate.trace.ok || !generate.trace.attachment) {
      throw new DshImageToolProbeError("generate_tool_trace_invalid");
    }

    stage = "edit_tool_turn";
    edit = await sendAndCollectToolTurn({
      ...input,
      sessionId,
      timeoutMs,
      name: "edit_last_image",
      sourceAssetId: generate.trace.attachment.mediaAssetId,
      content:
        "Use edit_last_image exactly once now. Edit the last generated image " +
        `by adding one subtle silver crescent hairpin, audit nonce ${runId}.`,
      idempotencyKey: `chat-dsh-image-probe:edit:${runId}`,
    });
    if (!edit.trace.ok || !edit.trace.attachment) {
      throw new DshImageToolProbeError("edit_tool_trace_invalid");
    }
  } catch (error) {
    if (error instanceof DshImageToolProbeError) stage = error.stage;
    // The stage name is an intentional content-free error taxonomy. Provider
    // payloads, prompt bytes and signed headers never reach stdout or reports.
  } finally {
    if (sessionId) {
      try {
        const chatCleanup = await cleanupCompletedProbeState({
          ...input,
          sessionId,
        });
        cleanup = {
          ...cleanup,
          sessionGone: chatCleanup.sessionGone === true,
          relationshipsGone: chatCleanup.relationshipsGone === true,
        };
      } catch {
        // A cleanup transport failure is itself red evidence; do not replace
        // the original stage or leak its signed request details.
      }
      const generationJobIds = [generate, edit]
        .flatMap((turn) => turn?.trace.attachment?.generationJobId ?? []);
      if (generationJobIds.length > 0) {
        try {
          cleanup = {
            ...cleanup,
            ...await waitForMainCleanup({
              sessionId,
              generationJobIds,
              timeoutMs: Math.min(timeoutMs, 120_000),
            }),
          };
        } catch {
          // Keep the two Main cleanup facts false and fail closed below.
        }
      }
    }
  }

  if (!generate?.trace.attachment || !edit?.trace.attachment) {
    return failedReport({
      checkedAt,
      observedAt: new Date().toISOString(),
      stage,
      cleanup,
    });
  }

  try {
    const snapshot = await collectAuditSnapshot({
      checkedAt,
      observedAt: new Date().toISOString(),
      generate,
      edit,
      cleanup,
      chatAuditDatabaseUrl: input.chatAuditDatabaseUrl,
    });
    return evaluateDshImageToolSnapshot(snapshot);
  } catch {
    return failedReport({
      checkedAt,
      observedAt: new Date().toISOString(),
      stage: "authority_snapshot",
      cleanup,
    });
  }
}

async function sendAndCollectToolTurn(input: ProbeInput & {
  sessionId: string;
  timeoutMs: number;
  name: DshImageToolName;
  sourceAssetId?: string;
  content: string;
  idempotencyKey: string;
}): Promise<CollectedTurn> {
  const leg = input.name === "generate_image_async" ? "generate" : "edit";
  // SPEC: one signed POST per leg. This function contains no retry path; any
  // uncertain or failed write aborts the probe before another paid effect.
  const send = await signedFetch({
    ...input,
    method: "POST",
    path: `/api/v1/chat/sessions/${input.sessionId}/messages`,
    body: JSON.stringify({ content: input.content }),
    idempotencyKey: input.idempotencyKey,
  }).catch(() => {
    throw new DshImageToolProbeError(`${leg}_send_transport`);
  });
  const accepted = await send.json().catch(() => ({})) as {
    assistantMessageId?: unknown;
    attempt?: unknown;
    status?: unknown;
  };
  const assistantMessageId = text(accepted.assistantMessageId);
  let attempt = integer(accepted.attempt);
  if (send.status !== 202) {
    throw new DshImageToolProbeError(`${leg}_send_rejected_${send.status}`);
  }
  if (
    !assistantMessageId ||
    accepted.status === "blocked"
  ) {
    throw new DshImageToolProbeError(`${leg}_acceptance_invalid`);
  }
  if (attempt === null) {
    const state = await signedFetch({
      ...input,
      method: "GET",
      path: `/api/v1/chat/sessions/${input.sessionId}`,
    }).catch(() => {
      throw new DshImageToolProbeError(`${leg}_acceptance_state_transport`);
    });
    if (state.status !== 200) {
      throw new DshImageToolProbeError(
        `${leg}_acceptance_state_rejected_${state.status}`,
      );
    }
    const snapshot = await state.json().catch(() => ({})) as {
      messages?: PublicMessage[];
    };
    attempt = integer(
      snapshot.messages?.find((message) => message.id === assistantMessageId)?.attempt,
    );
  }
  if (attempt === null || attempt < 1) {
    throw new DshImageToolProbeError(`${leg}_acceptance_invalid`);
  }
  const stream = await probeStream({
    ...input,
    assistantMessageId,
    expectedAttempt: attempt,
  }).catch(() => {
    throw new DshImageToolProbeError(`${leg}_stream_transport`);
  });
  if (!stream.ok || !stream.sawStart || !stream.sawDelta || !stream.sawDone) {
    throw new DshImageToolProbeError(`${leg}_stream_incomplete`);
  }
  return waitForCompletedImageTurn({
    ...input,
    assistantMessageId,
    attempt,
  });
}

async function waitForCompletedImageTurn(input: ProbeInput & {
  sessionId: string;
  assistantMessageId: string;
  attempt: number;
  timeoutMs: number;
  name: DshImageToolName;
  sourceAssetId?: string;
}): Promise<CollectedTurn> {
  const leg = input.name === "generate_image_async" ? "generate" : "edit";
  const deadline = Date.now() + input.timeoutMs;
  let lastMessage: PublicMessage | null = null;
  const auditClient = new Client({
    connectionString: input.chatAuditDatabaseUrl,
    application_name: "idream-dsh-image-tool-attempt-audit",
  });
  await auditClient.connect();
  try {
    while (Date.now() < deadline) {
    const response = await signedFetch({
      ...input,
      method: "GET",
      path: `/api/v1/chat/sessions/${input.sessionId}`,
    }).catch(() => {
      throw new DshImageToolProbeError(`${leg}_state_transport`);
    });
    const body = await response.json().catch(() => ({})) as {
      messages?: PublicMessage[];
    };
    lastMessage = body.messages?.find((message) =>
      message.id === input.assistantMessageId
    ) ?? null;
    const attachments = lastMessage?.attachments ?? [];
    const generated = attachments.filter((attachment) =>
      attachment.kind === "generated_image"
    );
    const terminalAttachment = generated.length !== 1 ||
      ["completed", "failed", "rejected", "refunded", "canceled"].includes(
        String(generated[0]?.status ?? ""),
      );
    const audit = await readChatAttemptAudit(auditClient, input.assistantMessageId);
    const attempt = integer(lastMessage?.attempt);
    const memorySettled = attempt !== null && audit !== null &&
      audit.memoryExtractedAttempt >= attempt;
    const primaryTelemetry = record(record(audit?.runtimeTrace).primaryTelemetry);
    const terminalMessage =
      primaryTelemetry.terminalStatus === "sent" &&
      primaryTelemetry.sseTerminal === "done";
    if (
      response.status === 200 &&
      lastMessage?.role === "assistant" &&
      lastMessage.status === "sent" &&
      attempt === input.attempt &&
      audit?.attempt === input.attempt &&
      audit.status === "sent" &&
      memorySettled &&
      terminalMessage &&
      (generated.length === 0 || terminalAttachment)
    ) {
      const companion = projectDshCompanionEvidence(
        audit.runtimeTrace,
        "normal",
      );
      return {
        companion: {
          ok: companion.ok,
          ...(companion.runtime ? { runtime: companion.runtime } : {}),
          ...(companion.provider ? { provider: companion.provider } : {}),
          ...(companion.model ? { model: companion.model } : {}),
          ...(companion.profileDigest
            ? { profileDigest: companion.profileDigest }
            : {}),
          ...(companion.requestId ? { requestId: companion.requestId } : {}),
          ...(companion.sidecarInstanceId
            ? { sidecarInstanceId: companion.sidecarInstanceId }
            : {}),
        },
        trace: projectDshImageToolTrace(
          audit.runtimeTrace,
          attachments,
          {
            assistantMessageId: input.assistantMessageId,
            attempt: input.attempt,
            name: input.name,
            ...(input.sourceAssetId ? { sourceAssetId: input.sourceAssetId } : {}),
          },
        ),
      };
    }
    await delay(250);
    }
  } finally {
    await auditClient.end();
  }
  throw new DshImageToolProbeError(
    lastMessage ? `${leg}_turn_unsettled` : `${leg}_assistant_missing`,
  );
}

async function readChatAttemptAudit(
  client: Client,
  messageId: string,
): Promise<ChatAttemptAudit | null> {
  const result = await client.query<ChatAttemptAudit>({
    text: `
      SELECT
        m.attempt,
        m.status,
        m.memory_extracted_attempt AS "memoryExtractedAttempt",
        m.runtime_trace AS "runtimeTrace"
      FROM chat.messages m
      JOIN chat.message_versions mv
        ON mv.message_id = m.id
       AND mv.attempt = m.attempt
       AND mv.selected = true
       AND mv.runtime_trace = m.runtime_trace
      WHERE m.id = $1
        AND m.deleted_at IS NULL
      LIMIT 1
    `,
    values: [messageId],
  });
  return result.rows[0] ?? null;
}

async function collectAuditSnapshot(input: {
  checkedAt: string;
  observedAt: string;
  generate: CollectedTurn;
  edit: CollectedTurn;
  cleanup: DshImageToolAuditSnapshot["cleanup"];
  chatAuditDatabaseUrl: string;
}): Promise<DshImageToolAuditSnapshot> {
  const generate = await collectLegSnapshot({
    ...input.generate,
    chatAuditDatabaseUrl: input.chatAuditDatabaseUrl,
  });
  const edit = await collectLegSnapshot({
    ...input.edit,
    chatAuditDatabaseUrl: input.chatAuditDatabaseUrl,
  });
  return {
    checkedAt: input.checkedAt,
    observedAt: input.observedAt,
    actor: {
      userId: AUDIT_USER_ID,
      dataClass: "audit",
      signedBff: true,
    },
    legs: { generate, edit },
    cleanup: input.cleanup,
  };
}

async function collectLegSnapshot(input: CollectedTurn & {
  chatAuditDatabaseUrl: string;
}): Promise<DshImageToolLegSnapshot> {
  const attachment = input.trace.attachment!;
  const chatRequestOutboxes = await readChatRequestOutboxes(
    input.chatAuditDatabaseUrl,
    attachment.id,
  );
  const outboxId = chatRequestOutboxes.length === 1
    ? chatRequestOutboxes[0]!.id
    : null;
  const mainReceipt = outboxId
    ? await prisma.inboundEventReceipt.findUnique({
        where: {
          sourceService_sourceEventId: {
            sourceService: chatProjectionReceiptSourceService("chat"),
            sourceEventId: outboxId,
          },
        },
        select: { id: true, sourceEventId: true, processingState: true },
      })
    : null;
  const jobs: DbJobRow[] = await prisma.generationJob.findMany({
    where: { sourceType: "chat_image", sourceId: attachment.id },
    select: {
      id: true,
      sourceId: true,
      mode: true,
      status: true,
      outputCount: true,
      deliveredOutputCount: true,
      costDreamcoins: true,
      controls: true,
      createdAt: true,
      completedAt: true,
    },
  });
  const jobIds = jobs.map((job) => job.id);
  const attempts: DbAttemptRow[] = jobIds.length > 0
    ? await prisma.generationAttempt.findMany({
        where: { requestId: { in: jobIds } },
        orderBy: [{ requestId: "asc" }, { attemptNo: "asc" }],
        select: {
          id: true,
          requestId: true,
          attemptNo: true,
          status: true,
          provider: true,
          profileKey: true,
          profileVersion: true,
          workflowKey: true,
          workflowVersion: true,
          startedAt: true,
          finishedAt: true,
        },
      })
    : [];
  const attemptIds = attempts.map((attempt) => attempt.id);
  const [transports, artifacts, deliveries, mainCallbacks]: [
    DbTransportRow[],
    DshImageToolLegSnapshot["artifacts"],
    DshImageToolLegSnapshot["deliveries"],
    DshImageToolLegSnapshot["mainCallbacks"],
  ] = await Promise.all([
    attemptIds.length > 0
      ? prisma.generationTransportExecution.findMany({
          where: { attemptId: { in: attemptIds } },
          orderBy: [{ attemptId: "asc" }, { transportAttemptNo: "asc" }],
          select: {
            attemptId: true,
            transportAttemptNo: true,
            status: true,
            latencyMs: true,
            costMicros: true,
          },
        })
      : [],
    attemptIds.length > 0
      ? prisma.generationArtifact.findMany({
          where: { attemptId: { in: attemptIds } },
          orderBy: [{ attemptId: "asc" }, { ordinal: "asc" }],
          select: {
            id: true,
            attemptId: true,
            assetId: true,
            validationState: true,
            archiveState: true,
          },
        })
      : [],
    jobIds.length > 0
      ? prisma.generationDelivery.findMany({
          where: { requestId: { in: jobIds } },
          select: {
            requestId: true,
            artifactId: true,
            status: true,
            targetId: true,
          },
        })
      : [],
    prisma.mainOutboxEvent.findMany({
      where: {
        eventType: {
          in: [
            MAIN_TO_CHAT_EVENTS.chatImageCompleted,
            MAIN_TO_CHAT_EVENTS.chatImageFailed,
          ],
        },
        aggregateId: attachment.id,
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        eventType: true,
        aggregateId: true,
        status: true,
      },
    }),
  ]);
  const persistence = jobs.length === 1
    ? await inspectGenerationPersistence(jobs[0]!.id)
    : null;

  return {
    companion: input.companion,
    trace: input.trace,
    chatRequestOutboxes: chatRequestOutboxes.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
    })),
    mainReceipt,
    jobs: jobs.map((job) => {
      const { controls, ...fields } = job;
      return {
        ...fields,
        sourceImageAssetId: text(record(controls).sourceImageAssetId),
        createdAt: job.createdAt.toISOString(),
        completedAt: job.completedAt?.toISOString() ?? null,
      };
    }),
    attempts: attempts.map((attempt) => ({
      ...attempt,
      startedAt: attempt.startedAt?.toISOString() ?? null,
      finishedAt: attempt.finishedAt?.toISOString() ?? null,
    })),
    transports: transports.map((transport) => ({
      ...transport,
      costMicros: transport.costMicros?.toString() ?? null,
    })),
    artifacts,
    deliveries,
    mainCallbacks,
    persistenceOk: persistence?.ok === true,
  };
}

export function chatProjectionReceiptSourceService(sourceService: string): string {
  return `main.product_projection:${sourceService.trim() || "chat"}`;
}

async function readChatRequestOutboxes(
  databaseUrl: string,
  attachmentId: string,
) {
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "idream-dsh-image-tool-probe",
  });
  await client.connect();
  try {
    const result = await client.query<{
      id: string;
      status: string;
      attempts: number;
      createdAt: Date;
      deliveredAt: Date | null;
    }>({
      text: `
        SELECT
          id,
          status,
          attempts,
          created_at AS "createdAt",
          delivered_at AS "deliveredAt"
        FROM chat.chat_outbox_events
        WHERE event_type = $1
          AND aggregate_type = 'message_attachment'
          AND aggregate_id = $2
        ORDER BY created_at ASC
      `,
      values: [CHAT_TO_MAIN_EVENTS.imageRequested, attachmentId],
    });
    return result.rows;
  } finally {
    await client.end();
  }
}

async function waitForMainCleanup(input: {
  sessionId: string;
  generationJobIds: string[];
  timeoutMs: number;
}) {
  const deadline = Date.now() + input.timeoutMs;
  const generationJobIds = [...new Set(input.generationJobIds)];
  let observed = { recentChatDeleted: false, sourceTextRedacted: false };
  while (Date.now() < deadline) {
    const [recent, jobs] = await Promise.all([
      prisma.recentChat.findUnique({
        where: { sessionId: input.sessionId },
        select: { status: true },
      }),
      prisma.generationJob.findMany({
        where: { id: { in: generationJobIds } },
        select: { sourceMeta: true },
      }),
    ]);
    observed = classifyDshImageToolMainCleanup({
      recentStatus: recent?.status ?? null,
      expectedJobCount: generationJobIds.length,
      jobSourceMeta: jobs.map((job) => job.sourceMeta),
    });
    const { recentChatDeleted, sourceTextRedacted } = observed;
    if (recentChatDeleted && sourceTextRedacted) {
      return { recentChatDeleted, sourceTextRedacted };
    }
    await delay(250);
  }
  return observed;
}

export function classifyDshImageToolMainCleanup(input: {
  recentStatus: string | null;
  expectedJobCount: number;
  jobSourceMeta: readonly unknown[];
}): { recentChatDeleted: boolean; sourceTextRedacted: boolean } {
  return {
    // INVARIANT: physical projection deletion is stronger evidence than a
    // retained tombstone. Both mean Main no longer serves the recent chat.
    recentChatDeleted: input.recentStatus === null || input.recentStatus === "deleted",
    sourceTextRedacted: input.jobSourceMeta.length === input.expectedJobCount &&
      input.jobSourceMeta.every((value) => {
        const sourceMeta = record(value);
        const redaction = record(sourceMeta.privacyRedaction);
        return sourceMeta.promptHint == null &&
          sourceMeta.conversationContext == null &&
          redaction.reason === "session_deleted";
      }),
  };
}

function failedReport(input: {
  checkedAt: string;
  observedAt: string;
  stage: string;
  cleanup: DshImageToolAuditSnapshot["cleanup"];
}): DshImageToolAuditReport {
  return {
    ok: false,
    checkedAt: input.checkedAt,
    observedAt: input.observedAt,
    durationMs: elapsed(input.checkedAt, input.observedAt),
    actor: {
      userId: AUDIT_USER_ID,
      dataClass: "audit",
      signedBff: true,
    },
    legs: { generate: null, edit: null },
    cleanup: input.cleanup,
    error: `DSH image tool E2E failed at ${input.stage}`,
  };
}

function emptyCleanup(): DshImageToolAuditSnapshot["cleanup"] {
  return {
    sessionGone: false,
    relationshipsGone: false,
    recentChatDeleted: false,
    sourceTextRedacted: false,
  };
}

function positiveTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_TIMEOUT_MS;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function elapsed(from: string, to: string): number | null {
  const value = Date.parse(to) - Date.parse(from);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function dshImageToolProbeExitCode(
  report: Pick<DshImageToolAuditReport, "ok">,
): 0 | 1 {
  return report.ok ? 0 : 1;
}

async function main() {
  const serviceUrl = probeCliArg("service-url") ?? process.env.CHAT_SERVICE_URL;
  const characterId = probeCliArg("character-id") ??
    process.env.CHAT_SERVICE_PROBE_CHARACTER_ID;
  const userId = probeCliArg("user-id") ??
    process.env.CHAT_SERVICE_PROBE_USER_ID ??
    AUDIT_USER_ID;
  const secret = process.env.CHAT_BFF_SIGNING_SECRET;
  const chatAuditDatabaseUrl = process.env.CHAT_PROJECTOR_DATABASE_URL;
  const timeoutArg = probeCliArg("timeout-ms");
  if (!serviceUrl?.trim()) throw new Error("--service-url is required");
  if (!characterId?.trim()) throw new Error("--character-id is required");
  if (!secret?.trim()) throw new Error("CHAT_BFF_SIGNING_SECRET is required");
  if (!chatAuditDatabaseUrl?.trim()) {
    throw new Error("CHAT_PROJECTOR_DATABASE_URL is required");
  }
  const report = await runDshImageToolProbe({
    serviceUrl,
    secret,
    chatAuditDatabaseUrl,
    userId,
    characterId,
    ...(timeoutArg ? { timeoutMs: Number.parseInt(timeoutArg, 10) } : {}),
  });
  const reportPath = probeCliArg("report");
  if (reportPath) await writeProbeReport(reportPath, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = dshImageToolProbeExitCode(report);
}

const entryPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (entryPath === import.meta.url) {
  main()
    .catch(() => {
      process.stderr.write("DSH image tool probe configuration failed\n");
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
