import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  qualify: vi.fn(),
  monitor: vi.fn(),
  execute: vi.fn(),
  dispatch: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/server/lib/db", () => ({ prisma: {
  controlPlaneCommand: { findMany: async () => [
    { id: "first", commandType: "publish" },
    { id: "second", commandType: "publish" },
  ] },
} }));
vi.mock("@/server/lib/env", () => ({ env: { APP_ENV: "test" } }));
vi.mock("@/server/lib/logger", () => ({ logger: { info: vi.fn(), error: mocks.error } }));
vi.mock("@/server/modules/admin-v2/characters/release-validation", () => ({ CHARACTER_RELEASE_POLICY_VERSION: "test" }));
vi.mock("@/server/modules/admin-v2/characters/release-monitor", () => ({
  dispatchStaleReleaseRoutes: mocks.qualify,
  dispatchDueReleaseMonitors: mocks.monitor,
}));
vi.mock("@/server/modules/admin-v2/jobs/stale-unknown-dispatcher", () => ({ dispatchStaleUnknownGenerationRequests: vi.fn() }));
vi.mock("@/server/modules/admin-v2/commands/executor", () => ({ ADMIN_COMMAND_TYPES: ["publish"], executeAcceptedAdminCommand: mocks.execute }));
vi.mock("@/server/modules/admin-v2/shared/control-plane-command", () => ({ reconcileExpiredCommandLeases: vi.fn() }));
vi.mock("@/server/modules/admin-v2/creative/retry-executor", () => ({ verifyCreativeRetryCommands: vi.fn() }));
vi.mock("@/server/modules/generation/generation-attempt-authority", () => ({ dispatchGenerationAttemptOutbox: mocks.dispatch }));
vi.mock("@/server/modules/admin-v2/incidents/action-executor", () => ({ verifyIncidentActionPlanCommands: vi.fn() }));
vi.mock("@/server/modules/admin-v2/incidents/service", () => ({ dispatchGenerationIncidentCorrelation: vi.fn() }));
vi.mock("./process-entrypoint", () => ({ isProcessEntrypoint: () => true }));

const signals = new Map<string, () => void>();
let finishCommand: () => void;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  signals.clear();
  vi.spyOn(process, "on").mockImplementation((event, listener) => {
    if (event === "SIGTERM" || event === "SIGINT") signals.set(event, () => listener());
    return process;
  });
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  mocks.qualify.mockResolvedValue({ examined: 0, nextCursor: null });
  mocks.monitor.mockResolvedValue({ claimed: 0, failed: 0 });
  mocks.execute.mockImplementation(() => new Promise((resolve) => {
    finishCommand = () => resolve({ status: "succeeded" });
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("waits for the accepted command on SIGTERM and does not claim the next command", async () => {
  await import("./admin-command-worker");
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.execute).toHaveBeenCalledTimes(1);
  signals.get("SIGTERM")!();
  await vi.advanceTimersByTimeAsync(201);
  expect(process.exit).not.toHaveBeenCalled();
  finishCommand();
  await vi.advanceTimersByTimeAsync(0);
  expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  expect(mocks.execute).toHaveBeenCalledTimes(1);
  expect(mocks.dispatch).not.toHaveBeenCalled();
});

it("reports a timed out drain as failure even after repeated stop signals", async () => {
  await import("./admin-command-worker");
  await vi.advanceTimersByTimeAsync(0);
  signals.get("SIGTERM")!();
  signals.get("SIGINT")!();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(process.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(mocks.error).toHaveBeenCalledWith(
    expect.objectContaining({ error: expect.objectContaining({ message: "Admin command worker drain timed out" }) }),
    expect.stringContaining("unfinished work retains its lease"),
  );
  finishCommand();
  await vi.advanceTimersByTimeAsync(0);
  expect(process.exit).toHaveBeenCalledTimes(1);
});

it("does not start monitor or command claims after an in-flight qualification scan drains", async () => {
  let finishScan!: () => void;
  mocks.qualify.mockImplementation(() => new Promise((resolve) => {
    finishScan = () => resolve({ examined: 1, nextCursor: "release-a" });
  }));
  await import("./admin-command-worker");
  signals.get("SIGTERM")!();
  finishScan();
  await vi.advanceTimersByTimeAsync(0);
  expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  expect(mocks.monitor).not.toHaveBeenCalled();
  expect(mocks.execute).not.toHaveBeenCalled();
});
