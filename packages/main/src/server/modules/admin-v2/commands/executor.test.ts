import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  claim: vi.fn().mockResolvedValue(null),
  character: vi.fn().mockResolvedValue({ status: "succeeded" }),
  creative: vi.fn().mockResolvedValue({ status: "verifying" }),
  incident: vi.fn().mockResolvedValue({ status: "verifying" }),
}));
vi.mock("../shared/control-plane-command", () => ({ claimControlPlaneCommand: mocks.claim }));
vi.mock("../characters/release-executor", () => ({ executeCharacterReleaseCommand: mocks.character }));
vi.mock("../creative/retry-executor", () => ({ executeCreativeRetryCommand: mocks.creative }));
vi.mock("../incidents/action-executor", () => ({ executeIncidentActionPlanCommand: mocks.incident }));
import { ADMIN_COMMAND_TYPES, executeAcceptedAdminCommand } from "./executor";

describe("shared Admin command dispatcher", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(["unknown.command", "constructor"])("rejects unregistered command type %s", async commandType => {
    const db = { controlPlaneCommand: { findUnique: vi.fn().mockResolvedValue({ id: "cmd-1", commandType, status: "accepted" }) } } as unknown as PrismaClient;
    await expect(executeAcceptedAdminCommand("cmd-1", { db, workerId: "worker" })).rejects.toMatchObject({ code: "bad_request" });
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it.each(["case.close", "incident.resolve", "chat.session_release.migrate"])("passes the caller DB and lease identity to %s", async commandType => {
    const row = { id: "cmd-1", commandType, status: "accepted" };
    const db = { controlPlaneCommand: { findUnique: vi.fn().mockResolvedValue(row), findUniqueOrThrow: vi.fn().mockResolvedValue(row) } } as unknown as PrismaClient;
    const now = new Date("2026-10-11T10:00:00Z");
    await executeAcceptedAdminCommand(row.id, { db, workerId: "background-worker", now, leaseMs: 123 });
    expect(mocks.claim).toHaveBeenCalledWith(db, { commandId: row.id, workerId: "background-worker", now, leaseMs: 123 });
  });

  it.each(ADMIN_COMMAND_TYPES.filter(type => type.startsWith("character.")))("uses the same Character dispatcher for %s", async commandType => {
    const db = { controlPlaneCommand: { findUnique: vi.fn().mockResolvedValue({ id: "cmd-1", commandType, status: "accepted" }) } } as unknown as PrismaClient;
    const context = { db, workerId: "worker", now: new Date(), afterClaim: vi.fn() };
    await executeAcceptedAdminCommand("cmd-1", context);
    expect(mocks.character).toHaveBeenCalledWith(db, expect.objectContaining({ commandId: "cmd-1", workerId: "worker", afterClaim: context.afterClaim }));
  });

  it.each(["creative.run.retry_failed", "incident.action_plan.execute"])("routes %s without replacing the worker context", async commandType => {
    const db = { controlPlaneCommand: { findUnique: vi.fn().mockResolvedValue({ id: "cmd-1", commandType, status: "accepted" }) } } as unknown as PrismaClient;
    await executeAcceptedAdminCommand("cmd-1", { db, workerId: "worker" });
    expect(commandType.startsWith("creative") ? mocks.creative : mocks.incident).toHaveBeenCalledWith(db, { commandId: "cmd-1", workerId: "worker" });
  });
});
