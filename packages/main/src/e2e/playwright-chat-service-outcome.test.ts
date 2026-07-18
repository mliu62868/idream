import { describe, expect, it } from "vitest";
import {
  playwrightChatOutcomeFailure,
  resolvePlaywrightShutdownSignal,
} from "./playwright-chat-service-outcome";

describe("Playwright chat service teardown outcome", () => {
  it("accepts a process-group SIGTERM even when the child exit wins the event race", () => {
    const childOutcomeObservedBeforeWrapperSignalHandler = {
      code: null,
      signal: "SIGTERM" as const,
      error: null,
    };

    expect(
      playwrightChatOutcomeFailure(
        childOutcomeObservedBeforeWrapperSignalHandler,
        "SIGTERM",
      ),
    ).toBeNull();
  });

  it("waits for wrapper shutdown authority when the child continuation wins first", async () => {
    let observeWrapperSignal: ((signal: NodeJS.Signals) => void) | null = null;
    const wrapperSignalAuthority = new Promise<NodeJS.Signals>((resolve) => {
      observeWrapperSignal = resolve;
    });
    const outcome = {
      code: null,
      signal: "SIGTERM" as const,
      error: null,
    };

    const resolvedSignal = resolvePlaywrightShutdownSignal(
      outcome,
      null,
      wrapperSignalAuthority,
      100,
    );
    queueMicrotask(() => observeWrapperSignal?.("SIGTERM"));

    await expect(resolvedSignal).resolves.toBe("SIGTERM");
    expect(
      playwrightChatOutcomeFailure(outcome, await resolvedSignal),
    ).toBeNull();
  });

  it("waits for wrapper authority when the Chat SIGTERM handler exits cleanly first", async () => {
    let observeWrapperSignal: ((signal: NodeJS.Signals) => void) | null = null;
    const wrapperSignalAuthority = new Promise<NodeJS.Signals>((resolve) => {
      observeWrapperSignal = resolve;
    });
    const outcome = {
      code: 0,
      signal: null,
      error: null,
    };

    const resolvedSignal = resolvePlaywrightShutdownSignal(
      outcome,
      null,
      wrapperSignalAuthority,
      100,
    );
    queueMicrotask(() => observeWrapperSignal?.("SIGTERM"));

    await expect(resolvedSignal).resolves.toBe("SIGTERM");
    expect(
      playwrightChatOutcomeFailure(outcome, await resolvedSignal),
    ).toBeNull();
  });

  it("does not invent teardown authority for an individually terminated child", async () => {
    const neverObserved = new Promise<NodeJS.Signals>(() => undefined);
    await expect(
      resolvePlaywrightShutdownSignal(
        {
          code: null,
          signal: "SIGTERM",
          error: null,
        },
        null,
        neverObserved,
        1,
      ),
    ).resolves.toBeUndefined();
  });

  it("does not invent teardown authority for an independent clean child exit", async () => {
    const neverObserved = new Promise<NodeJS.Signals>(() => undefined);
    await expect(
      resolvePlaywrightShutdownSignal(
        {
          code: 0,
          signal: null,
          error: null,
        },
        null,
        neverObserved,
        1,
      ),
    ).resolves.toBeUndefined();
  });

  it("accepts a clean signal-handler exit and rejects unrelated termination", () => {
    expect(
      playwrightChatOutcomeFailure(
        { code: 0, signal: null, error: null },
        "SIGTERM",
      ),
    ).toBeNull();
    expect(
      playwrightChatOutcomeFailure(
        { code: null, signal: "SIGINT", error: null },
        "SIGTERM",
      ),
    ).toMatchObject({
      message: expect.stringContaining("unexpectedly during teardown"),
    });
  });

  it("still fails closed when the child exits before teardown authority exists", () => {
    expect(
      playwrightChatOutcomeFailure(
        { code: 0, signal: null, error: null },
        undefined,
      ),
    ).toMatchObject({
      message: expect.stringContaining("before Playwright teardown"),
    });
  });
});
