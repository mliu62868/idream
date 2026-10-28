import { prisma } from "@/server/lib/db";
import { GENERATION_SOURCE_CHUNK_BYTES, GENERATION_SOURCE_MAX_BYTES } from "@/server/modules/ourdream/generation-source-snapshot";

// Only the exact active Attempt of a job that pinned this snapshot can read it.
export async function readGenerationSourceSnapshot({ snapshotId, jobId, attemptId }: { snapshotId: string; jobId: string; attemptId: string }) {
  const [job, attempt, snapshot] = await Promise.all([
    prisma.generationJob.findUnique({ where: { id: jobId }, select: { userId: true, mode: true, status: true, controls: true, user: { select: { status: true, deletedAt: true } } } }),
    prisma.generationAttempt.findFirst({ where: { requestId: jobId }, orderBy: { attemptNo: "desc" }, select: { id: true, status: true } }),
    prisma.generationSourceSnapshot.findUnique({ where: { id: snapshotId }, select: { userId: true, sizeBytes: true, contentType: true, sha256: true } }),
  ]);
  const controls = job?.controls && typeof job.controls === "object" && !Array.isArray(job.controls) ? job.controls as Record<string, unknown> : {};
  const pin = controls.sourceSnapshot && typeof controls.sourceSnapshot === "object" && !Array.isArray(controls.sourceSnapshot) ? controls.sourceSnapshot as Record<string, unknown> : {};
  const referencePins = Array.isArray(controls.referenceSnapshots) ? controls.referenceSnapshots.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value))) : [];
  const matchingPin = snapshot && (referencePins.some(item => item.snapshotId === snapshotId && item.sha256 === snapshot.sha256 && item.contentType === snapshot.contentType && item.sizeBytes === snapshot.sizeBytes) || (job?.mode === "video" && pin.version === 1 && pin.sourceImageAssetId === controls.sourceImageAssetId && pin.snapshotId === snapshotId && pin.sha256 === snapshot.sha256 && pin.contentType === snapshot.contentType && pin.sizeBytes === snapshot.sizeBytes));
  if (!job || !["image", "video"].includes(job.mode) || job.user.status !== "active" || job.user.deletedAt || !["queued", "moderating_input", "running", "moderating_output"].includes(job.status) || !attempt || attempt.id !== attemptId || !["queued", "running"].includes(attempt.status) || !snapshot || snapshot.userId !== job.userId || !matchingPin || snapshot.sizeBytes <= 0 || snapshot.sizeBytes > GENERATION_SOURCE_MAX_BYTES) return null;
  let ordinal = 0, sent = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunks = await prisma.generationSourceSnapshotChunk.findMany({ where: { snapshotId, ordinal: { gte: ordinal } }, orderBy: { ordinal: "asc" }, take: 16, select: { ordinal: true, bytes: true } });
        if (!chunks.length) {
          if (sent !== snapshot.sizeBytes) throw new Error("Source snapshot truncated");
          controller.close(); return;
        }
        for (const chunk of chunks) {
          if (chunk.ordinal !== ordinal || !chunk.bytes.byteLength || chunk.bytes.byteLength > GENERATION_SOURCE_CHUNK_BYTES || sent + chunk.bytes.byteLength > snapshot.sizeBytes) throw new Error("Invalid source snapshot chunks");
          ordinal++; sent += chunk.bytes.byteLength; controller.enqueue(chunk.bytes);
        }
      } catch (error) { controller.error(error); }
    },
  });
  return { body, contentType: snapshot.contentType, sizeBytes: snapshot.sizeBytes };
}
