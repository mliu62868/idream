// SPEC: runs video composition beside the 1 Hz sequence sweep instead of inside it.
// INTENT: TTS plus ffmpeg can take minutes. Awaited inside the sweep, that stalled every
// other sequence's failure settlement and next-scene dispatch, and the sweep's own
// guard kept any other sequence from even being looked at. Only the compositions that
// actually compete for this host's CPU wait for one another now.
// No new PM2 process: ffmpeg already runs as a child process, and composition holds
// scene bytes on disk rather than on the heap, so isolating it further would buy a
// process to supervise and no CPU or memory that this lane has not already freed.
// INVARIANTS:
//   - the caller claims composition ownership before `run`, so account erasure's
//     activeCompositionOwners check sees the job from before its first Blob or TTS call
//   - `drain` is what graceful shutdown awaits, so a stop never abandons a held owner
export type VideoCompositionLane = {
  hasCapacity(): boolean;
  run(job: () => Promise<void>): void;
  drain(): Promise<void>;
};

export function createVideoCompositionLane(input: {
  readonly concurrency?: number;
  readonly onError: (error: unknown) => void;
}): VideoCompositionLane {
  const concurrency = input.concurrency ?? 1;
  const running = new Set<Promise<void>>();
  return {
    hasCapacity: () => running.size < concurrency,
    run(job) {
      const task: Promise<void> = job()
        .catch(input.onError)
        .finally(() => { running.delete(task); });
      running.add(task);
    },
    async drain() {
      while (running.size > 0) await Promise.allSettled(running);
    },
  };
}
