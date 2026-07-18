export type PlaywrightChatChildOutcome = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error: Error | null;
};

/**
 * Playwright 1.61 terminates a webServer process group. The chat child can
 * therefore report the same shutdown signal before the wrapper's signal
 * handler observes its exit. Matching signal outcomes and clean exits are
 * teardown success regardless of that event ordering.
 */
export function playwrightChatOutcomeFailure(
  outcome: PlaywrightChatChildOutcome | null,
  shutdownSignal: NodeJS.Signals | undefined,
) {
  if (!outcome) return null;
  if (outcome.error) return outcome.error;
  if (!shutdownSignal) {
    return new Error(
      `Chat service exited before Playwright teardown (${outcome.code ?? outcome.signal ?? "unknown"})`,
    );
  }
  const exitedCleanly = outcome.code === 0 && outcome.signal === null;
  const exitedForShutdown =
    outcome.code === null && outcome.signal === shutdownSignal;
  if (!exitedCleanly && !exitedForShutdown) {
    return new Error(
      `Chat service exited unexpectedly during teardown (${outcome.code ?? outcome.signal ?? "unknown"})`,
    );
  }
  return null;
}

export async function resolvePlaywrightShutdownSignal(
  outcome: PlaywrightChatChildOutcome,
  currentSignal: NodeJS.Signals | null,
  signalAuthority: Promise<NodeJS.Signals>,
  waitMilliseconds = 1_000,
): Promise<NodeJS.Signals | undefined> {
  if (currentSignal) return currentSignal;
  const cleanExit = outcome.code === 0 && outcome.signal === null;
  const shutdownSignalExit =
    outcome.signal === "SIGTERM" || outcome.signal === "SIGINT";
  if (!cleanExit && !shutdownSignalExit) {
    return undefined;
  }

  // A process-group signal can resolve the child exit promise before Node
  // dispatches the wrapper's own signal listener. The Chat service also handles
  // SIGTERM itself and can therefore report a clean code-0 exit first. Wait for
  // explicit wrapper authority in both cases instead of freezing finalization
  // with signal=undefined.
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      signalAuthority,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), waitMilliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
