// SPEC: what a waiting user is told about their place in the shared rendering queue.
// INTENT: the estimate is coarse, so the wording has to be too. Rounding keeps a poll
// every couple of seconds from making the number jitter and implying precision.

/** The server stops counting here, so the figure means "at least this many". */
export const GENERATION_QUEUE_AHEAD_CAP = 200;

function roughWait(seconds: number) {
  const minutes = seconds / 60;
  if (minutes < 1.5) return "about a minute";
  if (minutes < 10) return `about ${Math.round(minutes)} minutes`;
  if (minutes < 50) return `about ${Math.round(minutes / 5) * 5} minutes`;
  if (minutes < 90) return "about an hour";
  return `about ${Math.round(minutes / 60)} hours`;
}

export function generationQueueCopy(input: {
  readonly mode: "image" | "video";
  readonly queueAhead?: number | null;
  readonly queueEtaSeconds?: number | null;
}): string | null {
  const { mode, queueAhead, queueEtaSeconds } = input;
  if (queueAhead === null || queueAhead === undefined) return null;
  const place = queueAhead === 0
    ? "Next in line"
    : queueAhead >= GENERATION_QUEUE_AHEAD_CAP
      ? `More than ${GENERATION_QUEUE_AHEAD_CAP} requests ahead of yours`
      : queueAhead === 1
        ? "1 request ahead of yours"
        : `${queueAhead} requests ahead of yours`;
  if (queueEtaSeconds === null || queueEtaSeconds === undefined) return place;
  const estimate = `${place} · ready in ${roughWait(queueEtaSeconds)}`;
  // New images can still go first, and no estimate can count requests not yet made.
  return mode === "video" ? `${estimate}. New image requests can go first, so it may take longer.` : estimate;
}
