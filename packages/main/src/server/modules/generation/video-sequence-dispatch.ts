import type { Prisma } from "@prisma/client";

// Sequential scenes use the ordinary dispatch outbox. Defer before claiming it:
// an untouched outbox proves a skipped scene never reached the paid provider.
export async function videoSceneDispatchDeferred(db: Pick<Prisma.TransactionClient, "generationJob" | "videoSequenceScene">, requestId: string) {
  const job = await db.generationJob.findUnique({ where: { id: requestId }, select: { sourceType: true } });
  if (job?.sourceType !== "video_sequence_scene") return false;
  const scene = await db.videoSequenceScene.findUnique({ where: { generationJobId: requestId }, include: { sequence: { include: { scenes: { include: { generationJob: { select: { status: true } } } } } } } });
  if (!scene || scene.sequence.status !== "generating") return true;
  return scene.sequence.scenes.some(prior => prior.ordinal < scene.ordinal && prior.generationJob.status !== "completed");
}
