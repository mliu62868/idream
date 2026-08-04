export function shouldApplyFeedResponse(input: {
  requestSerial: number;
  currentSerial: number;
  aborted: boolean;
}) {
  return !input.aborted && input.requestSerial === input.currentSerial;
}

export function feedLoadFailure(input: {
  message: string;
  loadingMore: boolean;
  hasSnapshot: boolean;
}) {
  if (input.loadingMore) {
    return {
      snapshotStale: false,
      status: "Could not load more dreams. Showing the loaded results.",
    } as const;
  }
  if (input.hasSnapshot) {
    return {
      snapshotStale: true,
      status: `${input.message} Showing the last loaded results.`,
    } as const;
  }
  return { snapshotStale: false, status: input.message } as const;
}
