import { describe, expect, it, vi } from "vitest";
import {
  runAdminCanary,
  type AdminCanaryAuthorityVerifier,
  type AdminCanaryFetch,
} from "./admin-canary-runner";

const readPlan = () => ({
  schemaVersion: 2 as const,
  environment: "production" as const,
  mode: "read" as const,
  baseUrl: "https://admin.example.test",
  iterations: 2,
  requests: [
    { scenarioId: "read.today" as const, method: "GET" as const, path: "/api/v2/admin/today" },
    { scenarioId: "read.list" as const, method: "GET" as const, path: "/api/v2/admin/cases?limit=10" },
    { scenarioId: "read.detail" as const, method: "GET" as const, path: "/api/v2/admin/cases/case-canary" },
    { scenarioId: "read.search" as const, method: "GET" as const, path: "/api/v2/admin/search?q=canary" },
  ],
});

const commandBody = {
  entityVersion: 3,
  reason: { code: "canary", summary: "Production canary rehearsal" },
  confirmation: "case-canary:close",
};

const writePlan = () => ({
  schemaVersion: 2 as const,
  environment: "production" as const,
  mode: "write" as const,
  baseUrl: "https://admin.example.test",
  iterations: 1,
  idempotencyKeyPrefix: "release-canary",
  requests: [
    { scenarioId: "write.command.accept" as const, method: "POST" as const, path: "/api/v2/admin/cases/case-canary/commands/close", body: commandBody },
    { scenarioId: "write.command.replay" as const, method: "POST" as const, path: "/api/v2/admin/cases/case-canary/commands/close", body: commandBody },
    { scenarioId: "write.command.collision" as const, method: "POST" as const, path: "/api/v2/admin/cases/case-canary/commands/close", body: { ...commandBody, reason: { code: "canary", summary: "Changed payload collision" } } },
    { scenarioId: "write.command.readback" as const, method: "GET" as const, path: "/api/v2/admin/commands/{{commandId}}" },
    { scenarioId: "write.state.readback" as const, method: "GET" as const, path: "/api/v2/admin/cases/case-canary" },
  ],
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify({ ok: status < 400, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function passingWriteFetch() {
  return vi.fn<AdminCanaryFetch>(async (input) => {
    const url = new URL(input.toString());
    if (url.pathname.endsWith("/commands/close")) {
      return json({ status: "accepted", commandId: "command-canary", requestId: "request-canary", verificationDeepLink: "/admin/system/audit" }, 202);
    }
    if (url.pathname === "/api/v2/admin/commands/command-canary") {
      return json({ commandId: "command-canary", status: "succeeded" });
    }
    return json({ case: { id: "case-canary", status: "closed", version: 4 } });
  }).mockResolvedValueOnce(json({ status: "accepted", commandId: "command-canary", requestId: "request-canary", verificationDeepLink: "/admin/system/audit" }, 202))
    .mockResolvedValueOnce(json({ status: "accepted", commandId: "command-canary", requestId: "request-canary", verificationDeepLink: "/admin/system/audit" }, 202))
    .mockResolvedValueOnce(json({ code: "IDEMPOTENCY_CONFLICT" }, 409));
}

const passingAuthorityVerifier = vi.fn<AdminCanaryAuthorityVerifier>(async ({ commands }) => ({
  status: "pass",
  checks: commands.map((command) => ({
    iteration: command.iteration,
    commandId: command.commandId,
    commandStatus: "succeeded",
    auditRecordId: "audit-canary",
    outboxEventId: "outbox-canary",
    outcome: "pass" as const,
  })),
}));

describe("Admin production canary runner", () => {
  it("executes the fixed Today/list/detail/search read matrix and redacts credentials", async () => {
    const request = vi.fn<AdminCanaryFetch>(async () => json({ items: [] }));
    const report = await runAdminCanary(readPlan(), {
      fetch: request,
      cookie: "secret-session-cookie",
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });

    expect(request).toHaveBeenCalledTimes(8);
    expect(report.samples.map((sample) => sample.scenarioId)).toEqual([
      "read.today", "read.list", "read.detail", "read.search",
      "read.today", "read.list", "read.detail", "read.search",
    ]);
    expect(report).toMatchObject({ status: "pass", sampleSize: 8, failures: 0, availability: 1, authorityProbe: null });
    expect(new Headers(request.mock.calls[0]![1]?.headers).get("cookie")).toBe("secret-session-cookie");
    expect(JSON.stringify(report)).not.toContain("secret-session-cookie");
  });

  it("proves command accept, replay, collision, readbacks, and Audit/Outbox authority", async () => {
    const request = passingWriteFetch();
    const report = await runAdminCanary(writePlan(), {
      fetch: request,
      verifyAuthority: passingAuthorityVerifier,
      writeConfirmation: "I_UNDERSTAND_THIS_MUTATES_PRODUCTION",
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });

    expect(report).toMatchObject({
      status: "pass",
      sampleSize: 5,
      failures: 0,
      authorityProbe: { status: "pass", checks: [{ commandId: "command-canary", outcome: "pass" }] },
    });
    expect(report.samples.map((sample) => [sample.scenarioId, sample.status, sample.outcome])).toEqual([
      ["write.command.accept", 202, "pass"],
      ["write.command.replay", 202, "pass"],
      ["write.command.collision", 409, "pass"],
      ["write.command.readback", 200, "pass"],
      ["write.state.readback", 200, "pass"],
    ]);
    const keys = request.mock.calls.map((call) => new Headers(call[1]?.headers).get("idempotency-key"));
    expect(new Set(keys.slice(0, 3))).toEqual(new Set([expect.stringMatching(/^release-canary:/)]));
    expect(keys.slice(3)).toEqual([null, null]);
    expect(new URL(request.mock.calls[3]![0].toString()).pathname).toBe("/api/v2/admin/commands/command-canary");
  });

  it("fails closed for a missing scenario, duplicate scenario, or trivial single request", async () => {
    const fetch = vi.fn<AdminCanaryFetch>(async () => json({}));
    const missing = readPlan();
    missing.requests = missing.requests.slice(0, 3);
    await expect(runAdminCanary(missing, { fetch })).rejects.toThrow(/scenario/i);

    const duplicate = readPlan();
    duplicate.requests[3] = { ...duplicate.requests[0]! };
    await expect(runAdminCanary(duplicate, { fetch })).rejects.toThrow(/scenario/i);

    await expect(runAdminCanary({
      ...readPlan(),
      requests: [{ scenarioId: "read.today", method: "GET", path: "/api/v2/admin/today" }],
    }, { fetch })).rejects.toThrow(/scenario/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects write plans that do not prove identical replay and changed-payload collision", async () => {
    const fetch = vi.fn<AdminCanaryFetch>(async () => json({}));
    const replayChanged = writePlan();
    replayChanged.requests[1] = {
      scenarioId: "write.command.replay",
      method: "POST",
      path: "/api/v2/admin/cases/case-canary/commands/close",
      body: { ...commandBody, entityVersion: 4 },
    };
    await expect(runAdminCanary(replayChanged, {
      fetch,
      verifyAuthority: passingAuthorityVerifier,
      writeConfirmation: "I_UNDERSTAND_THIS_MUTATES_PRODUCTION",
    })).rejects.toThrow(/replay/i);

    const collisionSame = writePlan();
    collisionSame.requests[2] = {
      scenarioId: "write.command.collision",
      method: "POST",
      path: "/api/v2/admin/cases/case-canary/commands/close",
      body: commandBody,
    };
    await expect(runAdminCanary(collisionSame, {
      fetch,
      verifyAuthority: passingAuthorityVerifier,
      writeConfirmation: "I_UNDERSTAND_THIS_MUTATES_PRODUCTION",
    })).rejects.toThrow(/collision/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails write evidence when response linkage or the authority verifier is missing", async () => {
    await expect(runAdminCanary(writePlan(), {
      fetch: passingWriteFetch(),
      writeConfirmation: "I_UNDERSTAND_THIS_MUTATES_PRODUCTION",
    })).rejects.toThrow(/authority verifier/i);

    const wrongReplay = passingWriteFetch();
    wrongReplay.mockReset()
      .mockResolvedValueOnce(json({ commandId: "command-a" }, 202))
      .mockResolvedValueOnce(json({ commandId: "command-b" }, 202))
      .mockResolvedValueOnce(json({ code: "IDEMPOTENCY_CONFLICT" }, 409))
      .mockResolvedValue(json({}));
    const report = await runAdminCanary(writePlan(), {
      fetch: wrongReplay,
      verifyAuthority: passingAuthorityVerifier,
      writeConfirmation: "I_UNDERSTAND_THIS_MUTATES_PRODUCTION",
    });
    expect(report.status).toBe("fail");
    expect(report.samples.find((sample) => sample.scenarioId === "write.command.replay")?.outcome).toBe("invalid_response");
  });

  it("retains HTTPS, same-origin, bounded-write, and credential safety", async () => {
    const fetch = vi.fn<AdminCanaryFetch>(async () => json({}));
    await expect(runAdminCanary({ ...readPlan(), baseUrl: "http://admin.example.test" }, { fetch })).rejects.toThrow("HTTPS");
    await expect(runAdminCanary({ ...writePlan(), iterations: 11 }, {
      fetch,
      verifyAuthority: passingAuthorityVerifier,
      writeConfirmation: "I_UNDERSTAND_THIS_MUTATES_PRODUCTION",
    })).rejects.toThrow();
    const escaped = readPlan();
    escaped.requests[0] = { ...escaped.requests[0]!, path: "/\\evil.example.test/collect" };
    await expect(runAdminCanary(escaped, {
      fetch,
      cookie: "production-session",
      authorization: "Bearer production-secret",
    })).rejects.toThrow(/origin/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});
