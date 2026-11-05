import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { GENERATION_QUEUE_AHEAD_CAP } from "@/lib/generation-queue-copy";
import { videoSceneDispatchDeferredSql } from "@/server/modules/generation/video-sequence-dispatch";

// SPEC: 告诉排队中的用户前面还有多少任务、大约多久能完成。只是读投影，不参与任何调度决定。
//
// INTENT: 图片和视频共用一台设备（一把 flock），gen-video 并发为 1，所以等待时间由整机
// 排队决定。但图片可以越过排队中的视频：视频 worker 只有一个 active 槽，其余视频留在 Bull
// 里，不和图片抢租约。因此「前面」按模态不对称：
//   - 图片：所有运行中的 Attempt + 更早排队的图片。
//   - 视频：所有运行中的 Attempt + 更早排队的图片和视频。之后到达的图片仍可能插到它前面，
//     这个估计不可能知道，所以它偏乐观，文案必须说「大约」。
// 运行中的 Attempt 按整段时长计入，不扣已运行时间，这一项偏保守。两者都只求粗略，所以
// 宁可不显示 ETA，也不显示一个错的。
//
// INVARIANT: 这些路由每 1.2–3 秒轮询一次。没有排队任务时不发任何查询；计数走
// generation_attempts(status, createdAt) 且有上限；时长统计按进程缓存一分钟。

const DURATION_SAMPLE_WINDOW_DAYS = 14;
const DURATION_SAMPLES_PER_MODE = 100;
// Fewer than this and one slow run would decide what the whole queue is told.
export const GENERATION_MIN_DURATION_SAMPLES = 5;
const DURATION_CACHE_MS = 60_000;

export type GenerationQueueStanding = {
  readonly queueAhead: number;
  /** Until this request should finish, not start. Null when there's too little data. */
  readonly queueEtaSeconds: number | null;
};

type GenerationMode = "image" | "video";
type SecondsPerOutput = Readonly<Partial<Record<GenerationMode, number>>>;

/** Pure so the estimate's rules can be pinned without building a queue in Postgres. */
export function estimateGenerationQueueSeconds(input: {
  readonly mode: GenerationMode;
  readonly outputCount: number;
  readonly aheadImageOutputs: number;
  readonly aheadVideoOutputs: number;
  readonly capped: boolean;
  readonly secondsPerOutput: SecondsPerOutput;
}): number | null {
  // A capped count is a lower bound, which would make the estimate look reassuring.
  if (input.capped) return null;
  const image = input.secondsPerOutput.image;
  const video = input.secondsPerOutput.video;
  const own = input.mode === "image" ? image : video;
  if (own === undefined) return null;
  if (input.aheadImageOutputs > 0 && image === undefined) return null;
  if (input.aheadVideoOutputs > 0 && video === undefined) return null;
  return Math.round(
    input.aheadImageOutputs * (image ?? 0) +
    input.aheadVideoOutputs * (video ?? 0) +
    input.outputCount * own,
  );
}

let durationCache: { readonly at: number; readonly value: Promise<SecondsPerOutput> } | null = null;

/** Test seam: a cached figure from an earlier fixture must not decide the next one. */
export function resetGenerationDurationCache() {
  durationCache = null;
}

function readRecentSecondsPerOutput(): Promise<SecondsPerOutput> {
  const now = Date.now();
  if (durationCache && now - durationCache.at < DURATION_CACHE_MS) return durationCache.value;
  const value = queryRecentSecondsPerOutput();
  durationCache = { at: now, value };
  // A failed read must not be remembered for a minute as "no data".
  value.catch(() => { if (durationCache?.value === value) durationCache = null; });
  return value;
}

async function queryRecentSecondsPerOutput(): Promise<SecondsPerOutput> {
  const since = new Date(Date.now() - DURATION_SAMPLE_WINDOW_DAYS * 86_400_000);
  // startedAt is written once the worker holds the device, so these are render times
  // that exclude queueing. The median keeps a run stretched by a sleeping host from
  // setting the figure.
  const rows = await prisma.$queryRaw<Array<{ mode: string; samples: number; seconds: number | null }>>(Prisma.sql`
    SELECT mode.mode, count(*)::int AS samples,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY recent.seconds)::float8 AS seconds
    FROM (VALUES ('image'), ('video')) AS mode(mode)
    CROSS JOIN LATERAL (
      SELECT EXTRACT(EPOCH FROM (attempt."finishedAt" - attempt."startedAt")) / GREATEST(job."outputCount", 1) AS seconds
      FROM generation_attempts attempt
      JOIN generation_jobs job ON job.id = attempt."requestId"
      WHERE attempt.status = 'succeeded' AND attempt."createdAt" >= ${since}
        AND attempt."startedAt" IS NOT NULL AND attempt."finishedAt" > attempt."startedAt"
        AND job.mode = mode.mode AND job.provider IS DISTINCT FROM 'local-image'
      ORDER BY attempt."createdAt" DESC
      LIMIT ${DURATION_SAMPLES_PER_MODE}
    ) recent
    GROUP BY mode.mode
  `);
  return secondsPerOutputFromSamples(rows);
}

export function secondsPerOutputFromSamples(
  rows: ReadonlyArray<{ readonly mode: string; readonly samples: number; readonly seconds: number | null }>,
): SecondsPerOutput {
  const estimates: Partial<Record<GenerationMode, number>> = {};
  for (const row of rows) {
    if ((row.mode === "image" || row.mode === "video") && row.samples >= GENERATION_MIN_DURATION_SAMPLES && row.seconds !== null) {
      estimates[row.mode] = row.seconds;
    }
  }
  return estimates;
}

/**
 * Standing for the given requests, all owned by the caller. A request gets an entry
 * only while it is really waiting on the device: not once it has started, not while
 * it is a sequence scene waiting on its previous scene, and not on the CPU-only
 * recolor route, which skips the device queue.
 */
export async function readGenerationQueueStandings(
  requestIds: readonly string[],
): Promise<ReadonlyMap<string, GenerationQueueStanding>> {
  if (requestIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{
    requestId: string; mode: GenerationMode; outputCount: number;
    ahead: number; aheadImageOutputs: number; aheadVideoOutputs: number;
  }>>(Prisma.sql`
    SELECT mine."requestId", job.mode, job."outputCount",
      counted.ahead, counted.image_outputs AS "aheadImageOutputs", counted.video_outputs AS "aheadVideoOutputs"
    FROM generation_attempts mine
    JOIN generation_jobs job ON job.id = mine."requestId"
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS ahead,
        coalesce(sum(other_job."outputCount") FILTER (WHERE other_job.mode = 'image'), 0)::int AS image_outputs,
        coalesce(sum(other_job."outputCount") FILTER (WHERE other_job.mode = 'video'), 0)::int AS video_outputs
      FROM (
        SELECT other."requestId" FROM generation_attempts other
        JOIN generation_jobs candidate ON candidate.id = other."requestId"
        WHERE (other.status = 'running' OR (other.status = 'queued' AND other."createdAt" < mine."createdAt"))
          AND candidate.provider IS DISTINCT FROM 'local-image'
          AND (other.status = 'running' OR job.mode = 'video' OR candidate.mode = 'image')
          AND (candidate."sourceType" <> 'video_sequence_scene' OR NOT ${videoSceneDispatchDeferredSql(Prisma.sql`candidate.id`)})
        LIMIT ${GENERATION_QUEUE_AHEAD_CAP}
      ) ahead_of_mine
      JOIN generation_jobs other_job ON other_job.id = ahead_of_mine."requestId"
    ) counted
    WHERE mine."requestId" IN (${Prisma.join([...requestIds])})
      AND mine.status = 'queued' AND mine."startedAt" IS NULL
      AND job.status = 'queued' AND job.provider IS DISTINCT FROM 'local-image'
      AND (job."sourceType" <> 'video_sequence_scene' OR NOT ${videoSceneDispatchDeferredSql(Prisma.sql`job.id`)})
  `);
  if (rows.length === 0) return new Map();
  const secondsPerOutput = await readRecentSecondsPerOutput();
  return new Map(rows.map(row => [row.requestId, {
    queueAhead: row.ahead,
    queueEtaSeconds: estimateGenerationQueueSeconds({
      mode: row.mode,
      outputCount: row.outputCount,
      aheadImageOutputs: row.aheadImageOutputs,
      aheadVideoOutputs: row.aheadVideoOutputs,
      capped: row.ahead >= GENERATION_QUEUE_AHEAD_CAP,
      secondsPerOutput,
    }),
  }]));
}
