import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Prisma } from "@prisma/client";
import { prisma } from "./lib/db";
import { canonicalSha256 } from "./modules/admin-v2/shared/canonical-json";
import type {
  GenerationPersistenceProbeEvidence,
  ProbeReportOf,
} from "./readiness/evidence";
import {
  probeCliArg,
  probeReportPath,
  writeProbeReport,
} from "./readiness/probe-report";

type GenerationPersistenceReport =
  ProbeReportOf<GenerationPersistenceProbeEvidence>;

export type GenerationPersistenceSnapshot = {
  checkedAt: string;
  job: {
    id: string;
    mode: string;
    status: string;
    completedAt: Date | null;
    deliveredOutputCount: number;
  } | null;
  attempt: {
    id: string;
    attemptNo: number;
    status: string;
    provider: string | null;
    profileKey: string | null;
    profileVersion: number | null;
    workflowKey: string | null;
    workflowVersion: number | null;
    terminalRecordRef: string | null;
    finishedAt: Date | null;
  } | null;
  terminalEvent: {
    outcome: string | null;
    occurredAt: Date;
    payload: Prisma.JsonValue;
  } | null;
  ingestEvent: {
    payload: Prisma.JsonValue;
  } | null;
  receipt: {
    id: string;
    payloadHash: string;
    processingState: string;
  } | null;
  outbox: {
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    status: string;
  } | null;
  transports: Array<{
    transportAttemptNo: number;
    status: string;
    terminalRecordRef: string | null;
  }>;
  artifacts: Array<{
    id: string;
    terminalRecordChecksum: string;
    validationState: string;
    archiveState: string;
    assetId: string | null;
  }>;
  deliveries: Array<{ artifactId: string; status: string }>;
  mediaAssets: Array<{ id: string; type: string; deletedAt: Date | null }>;
};

function jsonRecord(value: Prisma.JsonValue | null | undefined) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : null;
}

function jsonText(
  value: Prisma.JsonValue | null | undefined,
  key: string,
) {
  const candidate = jsonRecord(value)?.[key];
  return typeof candidate === "string" ? candidate : null;
}

export function evaluateGenerationPersistenceSnapshot(
  snapshot: GenerationPersistenceSnapshot,
): GenerationPersistenceReport {
  const problems: string[] = [];
  const { job, attempt } = snapshot;
  if (!job) problems.push("generation job was not found");
  if (!attempt) problems.push("generation attempt was not found");

  const terminalChecksum = jsonText(
    snapshot.terminalEvent?.payload,
    "terminalRecordChecksum",
  );
  const ingestChecksum = jsonText(
    snapshot.ingestEvent?.payload,
    "terminalRecordChecksum",
  );
  const ingestRef = jsonText(
    snapshot.ingestEvent?.payload,
    "terminalRecordRef",
  );
  const terminalRef = attempt?.terminalRecordRef ?? null;

  if (job?.status !== "completed" || !job.completedAt) {
    problems.push("generation job is not completed");
  }
  if (attempt?.status !== "succeeded" || !attempt.finishedAt) {
    problems.push("generation attempt is not succeeded");
  }
  if (!terminalRef || !/^[a-f0-9]{64}$/.test(terminalChecksum ?? "")) {
    problems.push("terminal record reference or checksum is invalid");
  }
  if (
    snapshot.terminalEvent?.outcome !== "succeeded" ||
    ingestRef !== terminalRef ||
    ingestChecksum !== terminalChecksum
  ) {
    problems.push("terminal ingest and terminal outcome are not identical");
  }
  const expectedReceiptHash =
    terminalRef && terminalChecksum
      ? canonicalSha256({
          terminalRecordRef: terminalRef,
          terminalRecordChecksum: terminalChecksum,
        })
      : null;
  if (
    snapshot.receipt?.processingState !== "processed" ||
    snapshot.receipt.payloadHash !== expectedReceiptHash
  ) {
    problems.push("Gen inbound receipt is absent or not processed");
  }
  if (
    snapshot.outbox?.eventType !== "generation.terminal_record.accepted.v1" ||
    snapshot.outbox.aggregateType !== "generation_attempt" ||
    snapshot.outbox.aggregateId !== attempt?.id ||
    snapshot.outbox.status !== "delivered"
  ) {
    problems.push("Main terminal outbox is absent or not delivered");
  }

  const latestTransport = snapshot.transports.at(-1);
  if (
    snapshot.transports.length < 1 ||
    latestTransport?.status !== "succeeded" ||
    latestTransport.terminalRecordRef !== terminalRef
  ) {
    problems.push("transport execution lacks a succeeded terminal authority");
  }
  if (
    snapshot.artifacts.length < 1 ||
    snapshot.artifacts.some(
      (artifact) =>
        artifact.validationState !== "valid" ||
        artifact.archiveState !== "active" ||
        !artifact.assetId ||
        artifact.terminalRecordChecksum !== terminalChecksum,
    )
  ) {
    problems.push("artifacts are not valid active terminal projections");
  }
  const artifactIds = snapshot.artifacts.map((artifact) => artifact.id).sort();
  const deliveredArtifactIds = snapshot.deliveries
    .map((delivery) => delivery.artifactId)
    .sort();
  if (
    snapshot.deliveries.length !== snapshot.artifacts.length ||
    snapshot.deliveries.some((delivery) => delivery.status !== "delivered") ||
    artifactIds.some(
      (artifactId, index) => artifactId !== deliveredArtifactIds[index],
    )
  ) {
    problems.push("artifact deliveries are incomplete");
  }
  const artifactAssetIds = snapshot.artifacts
    .flatMap((artifact) => (artifact.assetId ? [artifact.assetId] : []))
    .sort();
  const projectedMediaAssetIds = snapshot.mediaAssets
    .map((asset) => asset.id)
    .sort();
  if (
    snapshot.mediaAssets.length !== snapshot.artifacts.length ||
    artifactAssetIds.length !== snapshot.artifacts.length ||
    artifactAssetIds.some(
      (assetId, index) => assetId !== projectedMediaAssetIds[index],
    ) ||
    snapshot.mediaAssets.some(
      (asset) => asset.type !== job?.mode || asset.deletedAt !== null,
    ) ||
    job?.deliveredOutputCount !== snapshot.artifacts.length
  ) {
    problems.push("MediaAsset projection does not match delivered artifacts");
  }

  const observedAt = job?.completedAt?.toISOString() ?? null;
  return {
    ok: problems.length === 0,
    checkedAt: snapshot.checkedAt,
    observedAt,
    mode: job?.mode ?? null,
    generationJobId: job?.id ?? null,
    attemptId: attempt?.id ?? null,
    attemptNo: attempt?.attemptNo ?? 0,
    jobStatus: job?.status ?? null,
    attemptStatus: attempt?.status ?? null,
    provider: attempt?.provider ?? null,
    profileKey: attempt?.profileKey ?? null,
    profileVersion: attempt?.profileVersion ?? null,
    workflowKey: attempt?.workflowKey ?? null,
    workflowVersion: attempt?.workflowVersion ?? null,
    terminal:
      attempt && terminalRef
        ? {
            ref: terminalRef,
            checksum: terminalChecksum,
            receiptId: snapshot.receipt?.id ?? null,
            receiptState: snapshot.receipt?.processingState ?? null,
            outboxState: snapshot.outbox?.status ?? null,
            transportCount: snapshot.transports.length,
            transportStatus: latestTransport?.status ?? null,
            artifactCount: snapshot.artifacts.length,
            deliveredCount: snapshot.deliveries.filter(
              (delivery) => delivery.status === "delivered",
            ).length,
            mediaAssetCount: snapshot.mediaAssets.length,
          }
        : null,
    error:
      problems.length === 0
        ? null
        : {
            code: "generation_persistence_authority_incomplete",
            message: problems.join("; "),
            retryable: false,
          },
  };
}

export async function inspectGenerationPersistence(
  generationJobId: string,
): Promise<GenerationPersistenceReport> {
  const checkedAt = new Date().toISOString();
  const snapshot = await prisma.$transaction(
    async (tx): Promise<GenerationPersistenceSnapshot> => {
      const job = await tx.generationJob.findUnique({
        where: { id: generationJobId },
        select: {
          id: true,
          mode: true,
          status: true,
          completedAt: true,
          deliveredOutputCount: true,
        },
      });
      const attempt = await tx.generationAttempt.findFirst({
        where: { requestId: generationJobId },
        orderBy: [{ attemptNo: "desc" }, { createdAt: "desc" }],
        select: {
          id: true,
          attemptNo: true,
          status: true,
          provider: true,
          profileKey: true,
          profileVersion: true,
          workflowKey: true,
          workflowVersion: true,
          terminalRecordRef: true,
          finishedAt: true,
        },
      });
      const terminalEvent = attempt
        ? await tx.generationAttemptEvent.findUnique({
            where: { id: `${attempt.id}:terminal` },
            select: { outcome: true, occurredAt: true, payload: true },
          })
        : null;
      const ingestEvent = attempt
        ? await tx.generationAttemptEvent.findUnique({
            where: { id: `${attempt.id}:terminal-record-ingested` },
            select: { payload: true },
          })
        : null;
      const receipt = attempt
        ? await tx.inboundEventReceipt.findUnique({
            where: {
              sourceService_sourceEventId: {
                sourceService: "gen",
                sourceEventId: attempt.id,
              },
            },
            select: {
              id: true,
              payloadHash: true,
              processingState: true,
            },
          })
        : null;
      const outbox = attempt
        ? await tx.mainOutboxEvent.findUnique({
            where: { id: `generation_terminal_record_${attempt.id}` },
            select: {
              eventType: true,
              aggregateType: true,
              aggregateId: true,
              status: true,
            },
          })
        : null;
      const transports = attempt
        ? await tx.generationTransportExecution.findMany({
            where: { attemptId: attempt.id },
            orderBy: { transportAttemptNo: "asc" },
            select: {
              transportAttemptNo: true,
              status: true,
              terminalRecordRef: true,
            },
          })
        : [];
      const artifacts = attempt
        ? await tx.generationArtifact.findMany({
            where: { attemptId: attempt.id },
            orderBy: { ordinal: "asc" },
            select: {
              id: true,
              terminalRecordChecksum: true,
              validationState: true,
              archiveState: true,
              assetId: true,
            },
          })
        : [];
      const deliveries = attempt
        ? await tx.generationDelivery.findMany({
            where: { requestId: generationJobId },
            select: { artifactId: true, status: true },
          })
        : [];
      const mediaAssets = await tx.mediaAsset.findMany({
        where: { sourceJobId: generationJobId },
        select: { id: true, type: true, deletedAt: true },
      });
      return {
        checkedAt,
        job,
        attempt,
        terminalEvent,
        ingestEvent,
        receipt,
        outbox,
        transports,
        artifacts,
        deliveries,
        mediaAssets,
      };
    },
    { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 30_000 },
  );
  return evaluateGenerationPersistenceSnapshot(snapshot);
}

async function main() {
  const generationJobId =
    probeCliArg("job-id") ??
    process.env.GENERATION_PERSISTENCE_PROBE_JOB_ID ??
    null;
  if (!generationJobId?.trim()) {
    throw new Error(
      "--job-id (or GENERATION_PERSISTENCE_PROBE_JOB_ID) is required",
    );
  }
  const report = await inspectGenerationPersistence(generationJobId);
  const probeName =
    report.mode === "video"
      ? "videoGenerationPersistenceProbe"
      : "imageGenerationPersistenceProbe";
  const reportPath = probeReportPath(probeName);
  if (reportPath) await writeProbeReport(reportPath, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

const entryPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (entryPath === import.meta.url) {
  main()
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
