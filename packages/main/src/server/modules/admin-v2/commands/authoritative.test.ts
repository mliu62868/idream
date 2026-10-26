import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_V2_API_OPERATIONS,
  ADMIN_V2_API_OPERATIONS_BY_ID,
  type AdminV2DurableOperationId,
} from "@idream/shared/admin";
import type { AcceptControlPlaneCommandInput } from "../shared/control-plane-command";
import { Errors } from "@/server/lib/errors";

type CommandReceipt = {
  id: string;
  scope: string;
  actorId: string;
  commandType: string;
  targetType: string;
  targetId: string;
  expectedVersion: number | undefined;
  approvalId: string | null;
  retryMode: string;
  requestHash: string;
  requestPayload: unknown;
  requestId: string;
  status: string;
};

const state = vi.hoisted(() => {
  const commands = new Map<string, CommandReceipt>();
  const actor = { id: "durable-operator", role: "admin" as const };
  const permission = vi.fn(async (..._args: unknown[]) => actor);
  const incident = { id: "incident-1", version: 4, status: "monitoring", verificationState: "passed" };
  const findCommand = vi.fn(async ({ where }: {
    where: { scope_idempotencyKey: { scope: string; idempotencyKey: string } };
  }) => commands.get(where.scope_idempotencyKey.idempotencyKey) ?? null);
  const findIncident = vi.fn(async () => ({ ...incident }));
  const findRun = vi.fn(async () => ({
    id: "run-1", version: 2, status: "completed",
    items: [{ id: "item-1", job: {
      id: "job-1", status: "failed", errorCode: null, deliveredOutputCount: 0,
      profileId: "profile-1", profileVersion: 1,
    } }],
  }));
  const execute = vi.fn(async () => {
    incident.status = "resolved";
    incident.version = 5;
  });
  return {
    commands, actor, permission, incident, findCommand, findIncident, findRun, execute,
    accepted: vi.fn<(input: AcceptControlPlaneCommandInput) => void>(),
    prisma: {
      controlPlaneCommand: {
        findUnique: findCommand,
        findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
          const command = [...commands.values()].find(({ id }) => id === where.id);
          if (!command) throw new Error("Expected accepted receipt");
          return command;
        },
      },
      opsIncident: { findUnique: findIncident },
      contentProductionBatch: { findUnique: findRun },
      dreamcoinLedger: { findMany: vi.fn(async () => []) },
      generationModelProfile: { findFirst: vi.fn(async () => ({ id: "profile-1" })) },
      generationAttempt: { findFirst: vi.fn(async () => ({ id: "attempt-1" })) },
    },
  };
});

vi.mock("@/server/lib/db", () => ({ prisma: state.prisma }));
vi.mock("../shared/authority", async (importOriginal) => ({
  ...await importOriginal<typeof import("../shared/authority")>(),
  actorWithPermission: (...args: unknown[]) => state.permission(...args),
}));
vi.mock("./executor", () => ({ executeAcceptedAdminCommand: state.execute }));
vi.mock("../characters/release-validation", () => ({ CHARACTER_RELEASE_POLICY_VERSION: "test-policy" }));
vi.mock("../creative/retry-executor", () => ({ generationProfileHealth: () => ({ healthy: true }) }));
vi.mock("@/server/modules/generation/generation-attempt-authority", () => ({
  resolveGenerationAttemptRetryAuthority: async () => ({ allowed: true }),
}));
vi.mock("../shared/control-plane-command", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/control-plane-command")>();
  return {
    ...actual,
    acceptControlPlaneCommand: async (_db: unknown, input: AcceptControlPlaneCommandInput) => {
      state.accepted(input);
      const requestHash = actual.canonicalRequestHash(input);
      const existing = state.commands.get(input.idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new actual.IdempotencyConflictError(existing.id, existing.requestHash, requestHash);
        }
        return { commandId: existing.id, status: existing.status, replayed: true };
      }
      const command: CommandReceipt = {
        id: `command-${state.commands.size + 1}`,
        scope: `${input.environment}:${input.actor.id}`,
        actorId: input.actor.id,
        commandType: input.commandType,
        targetType: input.target.type,
        targetId: input.target.id,
        expectedVersion: input.expectedVersion,
        approvalId: input.approvalId ?? null,
        retryMode: input.retryMode ?? "non_replayable",
        requestHash,
        requestPayload: structuredClone(input.payload),
        requestId: input.requestId,
        status: "accepted",
      };
      state.commands.set(input.idempotencyKey, command);
      return { commandId: command.id, status: command.status, replayed: false };
    },
  };
});

const { resolveIncident, retryFailedCreativeRun } = await import("./authoritative");
const { readDurableAdminCommand } = await import("../shared/durable-command-admission");

const resolveOperation = "POST /api/v2/admin/incidents/:id/commands/resolve";

function request(path: string, options: {
  key?: string | null;
  version?: number;
  requestId?: string;
  reason?: string;
  confirmation?: string;
  ifMatch?: string;
} = {}) {
  return new Request(`http://admin.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": options.requestId ?? "request-first",
      ...(options.key === null ? {} : { "idempotency-key": options.key ?? "key-1" }),
      ...(options.ifMatch ? { "if-match": options.ifMatch } : {}),
    },
    body: JSON.stringify({
      entityVersion: options.version ?? 4,
      reason: { code: "verified", summary: options.reason ?? "Operator checked the result" },
      confirmation: options.confirmation ?? "incident-1:resolve",
    }),
  });
}

describe("durable Admin command admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.commands.clear();
    state.incident.status = "monitoring";
    state.incident.version = 4;
  });
  afterEach(() => vi.restoreAllMocks());

  it("uses manifest command identity and retry policy when accepting a domain action", async () => {
    const response = await resolveIncident(request("/api/v2/admin/incidents/incident-1/commands/resolve"), "incident-1");
    expect(response.status).toBe(202);
    expect(state.accepted).toHaveBeenCalledWith(expect.objectContaining({
      commandType: "incident.resolve",
      retryMode: "non_replayable",
      approvalPermissionKey: "ops.incident.manage",
      target: { type: "ops_incident", id: "incident-1" },
    }));
    expect(state.permission).toHaveBeenCalledWith(expect.any(Request), "ops.incident.manage", undefined);
    expect(state.findIncident).toHaveBeenCalledOnce();
  });

  it("does not retain a second command definition when manifest metadata changes", async () => {
    const metadata = ADMIN_V2_API_OPERATIONS_BY_ID[resolveOperation].mutation;
    if (!metadata) throw new Error("Expected durable metadata");
    const original = metadata.commandType;
    try {
      Object.defineProperty(metadata, "commandType", { value: "incident.resolve.metadata-probe", configurable: true });
      const response = await resolveIncident(request("/api/v2/admin/incidents/incident-1/commands/resolve"), "incident-1");
      expect(response.status).toBe(202);
      expect(state.accepted).toHaveBeenCalledWith(expect.objectContaining({ commandType: "incident.resolve.metadata-probe" }));
    } finally {
      Object.defineProperty(metadata, "commandType", { value: original, configurable: true });
    }
  });

  it("replays the original receipt before a state-changing command rechecks mutable authority", async () => {
    const path = "/api/v2/admin/incidents/incident-1/commands/resolve";
    const first = await resolveIncident(request(path), "incident-1");
    expect(state.incident).toMatchObject({ version: 5, status: "resolved" });
    const replay = await resolveIncident(request(path, { requestId: "request-retry" }), "incident-1");
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(await first.json());
    expect(state.findIncident).toHaveBeenCalledOnce();
    expect(state.commands.size).toBe(1);
    expect(state.execute).toHaveBeenCalledTimes(2);
  });

  it("rejects an exact replay with changed client facts before mutable preflight", async () => {
    const path = "/api/v2/admin/incidents/incident-1/commands/resolve";
    await resolveIncident(request(path), "incident-1");
    const changed = await resolveIncident(request(path, { reason: "Changed reason" }), "incident-1");
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
    expect(state.findIncident).toHaveBeenCalledOnce();
    expect(state.accepted).toHaveBeenCalledOnce();
  });

  it("restores frozen Creative retry eligibility without reading the changed run again", async () => {
    const path = "/api/v2/admin/creative/runs/run-1/commands/retry-failed";
    const input = { version: 2, confirmation: "run-1:retry-failed" };
    const first = await retryFailedCreativeRun(request(path, input), "run-1");
    expect(first.status).toBe(202);
    expect(state.commands.get("key-1")?.requestPayload).toMatchObject({ failedItemIds: ["item-1"] });
    state.findRun.mockRejectedValueOnce(new Error("Mutable run is no longer eligible"));
    const replay = await retryFailedCreativeRun(request(path, { ...input, requestId: "request-retry" }), "run-1");
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(await first.json());
    expect(state.findRun).toHaveBeenCalledOnce();
    expect(state.accepted.mock.calls[1]?.[0].payload).toMatchObject({ failedItemIds: ["item-1"] });
    state.findRun.mockReset().mockResolvedValue({
      id: "run-1", version: 2, status: "completed",
      items: [{ id: "item-1", job: {
        id: "job-1", status: "failed", errorCode: null, deliveredOutputCount: 0,
        profileId: "profile-1", profileVersion: 1,
      } }],
    });
  });

  it("rejects changed client facts on a frozen-payload replay", async () => {
    const path = "/api/v2/admin/creative/runs/run-1/commands/retry-failed";
    const input = { version: 2, confirmation: "run-1:retry-failed" };
    await retryFailedCreativeRun(request(path, input), "run-1");
    const response = await retryFailedCreativeRun(request(path, { ...input, reason: "Different purpose" }), "run-1");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
    expect(state.findRun).toHaveBeenCalledOnce();
  });

  it("authorizes before consuming malformed input", async () => {
    const input = new Request("http://admin.test/api/v2/admin/incidents/incident-1/commands/resolve", {
      method: "POST", body: "{not-json",
    });
    const read = vi.spyOn(input, "text");
    state.permission.mockRejectedValueOnce(Errors.forbidden("No incident permission"));
    const response = await resolveIncident(input, "incident-1");
    expect(response.status).toBe(403);
    expect(read).not.toHaveBeenCalled();
    expect(state.findCommand).not.toHaveBeenCalled();
  });

  it.each([
    { key: null },
    { ifMatch: '"99"' },
    { confirmation: "another-incident:resolve" },
  ])("rejects invalid command input before receipt lookup: %j", async (options) => {
    const response = await resolveIncident(request("/api/v2/admin/incidents/incident-1/commands/resolve", options), "incident-1");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(state.findCommand).not.toHaveBeenCalled();
    expect(state.accepted).not.toHaveBeenCalled();
  });

  it("rejects a command handler paired with a different declared HTTP operation", async () => {
    const response = await resolveIncident(request("/api/v2/admin/cases/case-1/commands/close"), "incident-1");
    expect(response.status).toBe(500);
    expect(state.permission).not.toHaveBeenCalled();
    expect(state.accepted).not.toHaveBeenCalled();
  });

  it("admits all twelve durable operations through the same transport contract", async () => {
    const operations = ADMIN_V2_API_OPERATIONS.filter((operation) => operation.contract.response === "adminCommandAcceptedSchema");
    expect(operations).toHaveLength(12);
    for (const operation of operations) {
      const actionPlan = operation.route.includes("/action-plans/");
      const migration = operation.route.includes("/migrate-release");
      const body = {
        entityVersion: 3,
        confirmation: "verified",
        ...(actionPlan ? {} : { reason: { code: "verified", summary: "Operator checked the result" } }),
        ...(migration ? {
          characterId: "character-1", fromCharacterContentVersionId: null, fromCharacterReleaseId: null,
          toCharacterContentVersionId: "content-1", toCharacterReleaseId: "release-1",
          compatibilityCheck: { status: "passed", policyVersion: "policy-1" },
        } : {}),
      };
      const input = new Request(`http://admin.test${operation.route.replace(/:[^/]+/g, "target")}`, {
        method: "POST",
        headers: { "idempotency-key": "read-key", "if-match": '"3"', "x-request-id": "read-request" },
        body: JSON.stringify(body),
      });
      const admitted = await readDurableAdminCommand(input, operation.id as AdminV2DurableOperationId);
      expect(admitted.body).toEqual(body);
      expect(admitted.definition.commandType).toBe(operation.mutation?.commandType);
      expect(admitted).toMatchObject({ idempotencyKey: "read-key", requestId: "read-request" });
    }
  });
});
