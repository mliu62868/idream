import { Prisma } from "@prisma/client";

// Sequential scenes use the ordinary dispatch outbox. Defer before claiming it:
// an untouched outbox proves a skipped scene never reached the paid provider.
export function videoSceneDispatchDeferredSql(requestId: Prisma.Sql): Prisma.Sql {
  // Candidate discovery and the pre-provider transport guard share this
  // predicate. Filtering before LIMIT prevents waiting scenes from hiding
  // another user's executable request without admitting scenes out of order.
  return Prisma.sql`EXISTS (
    SELECT 1 FROM generation_jobs video_job
    WHERE video_job.id = ${requestId} AND video_job."sourceType" = 'video_sequence_scene'
      AND NOT EXISTS (
        SELECT 1 FROM video_sequence_scenes scene
        JOIN video_sequences sequence ON sequence.id = scene."sequenceId"
        WHERE scene."generationJobId" = video_job.id AND sequence.status = 'generating'
          AND NOT EXISTS (
            SELECT 1 FROM video_sequence_scenes previous_scene
            JOIN generation_jobs previous_job ON previous_job.id = previous_scene."generationJobId"
            WHERE previous_scene."sequenceId" = sequence.id AND previous_scene.ordinal < scene.ordinal
              AND previous_job.status <> 'completed'
          )
      )
  )`;
}

export async function videoSceneDispatchDeferred(db: Pick<Prisma.TransactionClient, "$queryRaw">, requestId: string) {
  const rows = await db.$queryRaw<Array<{ deferred: boolean }>>(Prisma.sql`
    SELECT ${videoSceneDispatchDeferredSql(Prisma.sql`${requestId}`)} AS deferred
  `);
  return rows[0]!.deferred;
}
