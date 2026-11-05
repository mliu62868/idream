import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { logger } from "@/server/lib/logger";
import { executeCharacterReleaseCommand } from "../characters/release-executor";
import { executeAcceptedAdminCommand } from "../commands/executor";
import { getControlPlaneCommand } from "../commands/query";
import { executeCreativeRetryCommand } from "../creative/retry-executor";
import { executeIncidentActionPlanCommand } from "../incidents/action-executor";
import { acceptControlPlaneCommand } from "./control-plane-command";

/**
 * SPEC: a command failure that is not an AppError is persisted as a generic code and message.
 * INTENT: the command row is read back through `GET /commands/:id`, so a Prisma message stored
 * there is a Prisma message published to operators.
 */
describe("persisted command failures", () => {
  const suffix = randomUUID();
  const adminId = `safe-failure-admin-${suffix}`;
  const rawText = `Invalid \`tx.adminCase.update()\` invocation: RAW_QUERY_TEXT_${suffix}`;

  // The executors claim first (transaction 1), then do their work (transaction 2).
  function failingWorkTransaction(): PrismaClient {
    let transactions = 0;
    return new Proxy(prisma, {
      get(target, property) {
        if (property === "$transaction") {
          return (...args: Parameters<typeof prisma.$transaction>) => {
            transactions += 1;
            return transactions === 2
              ? Promise.reject(new Error(rawText))
              : (target.$transaction as (...input: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, property);
      },
    }) as PrismaClient;
  }

  async function accept(commandType: string, targetType: string) {
    const accepted = await acceptControlPlaneCommand(prisma, {
      environment: "test",
      actor: { id: adminId, role: "admin" },
      idempotencyKey: randomUUID(),
      commandType,
      target: { type: targetType, id: `safe-failure-target-${randomUUID()}` },
      expectedVersion: 1,
      payload: { reason: "fault injection" },
      retryMode: "idempotent",
      reason: "fault injection",
      requestId: randomUUID(),
    });
    return accepted.commandId;
  }

  async function storedError(commandId: string) {
    const command = await prisma.controlPlaneCommand.findUniqueOrThrow({ where: { id: commandId } });
    expect(command.status).toBe("failed");
    expect(JSON.stringify(command.error)).not.toContain("RAW_QUERY_TEXT");
    return command.error;
  }

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: adminId, email: `${adminId}@example.test`, role: "admin", status: "active" },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId: adminId } });
    await prisma.user.deleteMany({ where: { id: adminId } });
    await prisma.$disconnect();
  });

  it("stores a generic failure from the shared dispatcher, logs the original, and returns neither raw", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const commandId = await accept("case.close", "admin_case");

    await expect(executeAcceptedAdminCommand(commandId, {
      db: failingWorkTransaction(),
      workerId: `worker-${suffix}`,
    })).rejects.toThrow(rawText);

    await expect(storedError(commandId)).resolves.toEqual({
      code: "command_execution_failed",
      message: "Command execution failed",
    });
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ message: rawText }), commandId }),
      "Command execution failed",
    );
    const response = await getControlPlaneCommand(
      new Request("http://localhost/api/v2/admin/commands/command", {
        headers: { "x-idream-user-id": adminId, "x-idream-role": "admin" },
      }),
      commandId,
    );
    expect(await response.text()).not.toContain("RAW_QUERY_TEXT");
  });

  it("keeps the message of an AppError, which was written for the operator", async () => {
    const commandId = await accept("case.close", "admin_case");

    await expect(executeAcceptedAdminCommand(commandId, {
      db: prisma,
      workerId: `worker-${suffix}`,
    })).rejects.toMatchObject({ code: "not_found" });

    await expect(storedError(commandId)).resolves.toEqual({
      code: "domain_invariant_failed",
      message: "Case not found during command execution",
    });
  });

  it("stores a generic Creative retry failure", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const commandId = await accept("creative.run.retry_failed", "creative_run");

    await expect(executeCreativeRetryCommand(failingWorkTransaction(), {
      commandId,
      workerId: `worker-${suffix}`,
    })).rejects.toThrow(rawText);

    await expect(storedError(commandId)).resolves.toEqual({
      code: "creative_retry_execution_failed",
      message: "Creative retry execution failed",
    });
  });

  it("stores a generic Incident action failure", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const commandId = await accept("incident.action_plan.execute", "incident_action_plan");

    await expect(executeIncidentActionPlanCommand(failingWorkTransaction(), {
      commandId,
      workerId: `worker-${suffix}`,
    })).rejects.toThrow(rawText);

    await expect(storedError(commandId)).resolves.toEqual({
      code: "incident_action_execution_failed",
      message: "Incident action execution failed",
    });
  });

  it("stores a generic Release transaction failure", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const commandId = await accept("character.release.withdraw", "character_release");

    await expect(executeCharacterReleaseCommand(failingWorkTransaction(), {
      commandId,
      workerId: `worker-${suffix}`,
    })).resolves.toMatchObject({ status: "failed", errorCode: "release_executor_transaction_failed" });

    await expect(storedError(commandId)).resolves.toMatchObject({
      code: "release_executor_transaction_failed",
      message: "Release command transaction failed",
    });
  });
});
