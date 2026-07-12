import { describe, expect, it, vi } from "vitest";
import { runAdminCanary, type AdminCanaryFetch } from "./admin-canary-runner";

describe("Admin production canary runner", () => {
  it("executes bounded read samples and emits release-gate-compatible evidence", async () => {
    const request = vi.fn<AdminCanaryFetch>(async () => new Response("{}", { status: 200 }));
    const report = await runAdminCanary({
      schemaVersion: 1,
      environment: "production",
      mode: "read",
      baseUrl: "https://admin.example.test",
      iterations: 3,
      requests: [{ name: "today", method: "GET", path: "/api/v2/admin/today", expectedStatuses: [200] }],
    }, {
      fetch: request,
      cookie: "secret-session-cookie",
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });

    expect(request).toHaveBeenCalledTimes(3);
    expect(new Headers(request.mock.calls[0]![1]?.headers).get("cookie")).toBe("secret-session-cookie");
    expect(report).toMatchObject({
      status: "pass",
      observedAt: "2026-07-11T00:00:00.000Z",
      sampleSize: 3,
      failures: 0,
      availability: 1,
      evidenceRefs: [expect.stringMatching(/^canary:\/\/read\//)],
    });
    expect(JSON.stringify(report)).not.toContain("secret-session-cookie");
  });

  it("requires an explicit production-write confirmation and unique idempotency keys", async () => {
    const request = vi.fn<AdminCanaryFetch>(async () => new Response("{}", { status: 202 }));
    const plan = {
      schemaVersion: 1 as const,
      environment: "production" as const,
      mode: "write" as const,
      baseUrl: "https://admin.example.test",
      iterations: 2,
      requests: [{
        name: "close rehearsal case",
        method: "POST" as const,
        path: "/api/v2/admin/cases/rehearsal/commands/close",
        expectedStatuses: [202],
        idempotencyKeyPrefix: "release-canary",
        body: { entityVersion: 1 },
      }, {
        name: "assign rehearsal case",
        method: "POST" as const,
        path: "/api/v2/admin/cases/rehearsal/assignment",
        expectedStatuses: [200],
        idempotencyKeyPrefix: "release-canary",
        body: { ownerId: "ops-rehearsal" },
      }],
    };

    await expect(runAdminCanary(plan, { fetch: request })).rejects.toThrow("production write confirmation");
    await runAdminCanary(plan, {
      fetch: request,
      writeConfirmation: "I_UNDERSTAND_THIS_MUTATES_PRODUCTION",
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });
    const keys = request.mock.calls.map((call) => new Headers(call[1]?.headers).get("idempotency-key"));
    expect(new Set(keys).size).toBe(4);
    expect(keys.every((key) => key?.startsWith("release-canary:"))).toBe(true);
  });

  it("rejects insecure production targets, method/mode mismatches, and unbounded writes", async () => {
    const fetch = vi.fn<AdminCanaryFetch>(async () => new Response("{}", { status: 200 }));
    await expect(runAdminCanary({
      schemaVersion: 1,
      environment: "production",
      mode: "read",
      baseUrl: "http://admin.example.test",
      iterations: 1,
      requests: [{ name: "today", method: "GET", path: "/api/v2/admin/today", expectedStatuses: [200] }],
    }, { fetch })).rejects.toThrow("HTTPS");
    await expect(runAdminCanary({
      schemaVersion: 1,
      environment: "production",
      mode: "write",
      baseUrl: "https://admin.example.test",
      iterations: 11,
      requests: [{ name: "unsafe", method: "POST", path: "/api/v2/admin/cases/x/commands/close", expectedStatuses: [202], idempotencyKeyPrefix: "x", body: {} }],
    }, { fetch, writeConfirmation: "I_UNDERSTAND_THIS_MUTATES_PRODUCTION" })).rejects.toThrow();
    await expect(runAdminCanary({
      schemaVersion: 1,
      environment: "production",
      mode: "read",
      baseUrl: "https://[::1]",
      iterations: 1,
      requests: [{ name: "loopback", method: "GET", path: "/api/v2/admin/today", expectedStatuses: [200] }],
    }, { fetch })).rejects.toThrow("non-local");
    await expect(runAdminCanary({
      schemaVersion: 1,
      environment: "production",
      mode: "read",
      baseUrl: "https://admin.example.test",
      iterations: 1,
      requests: [{ name: "false success", method: "GET", path: "/api/v2/admin/today", expectedStatuses: [500] }],
    }, { fetch })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never forwards production credentials to a path that URL parsing resolves off-origin", async () => {
    const fetch = vi.fn<AdminCanaryFetch>(async () => new Response("{}", { status: 200 }));
    await expect(runAdminCanary({
      schemaVersion: 1,
      environment: "production",
      mode: "read",
      baseUrl: "https://admin.example.test",
      iterations: 1,
      requests: [{
        name: "credential exfiltration attempt",
        method: "GET",
        path: "/\\evil.example.test/collect",
        expectedStatuses: [200],
      }],
    }, {
      fetch,
      cookie: "production-session",
      authorization: "Bearer production-secret",
    })).rejects.toThrow(/origin-relative|same origin/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects paths that can escape the production Admin v2 origin", async () => {
    const fetch = vi.fn<AdminCanaryFetch>(async () => new Response("{}", { status: 200 }));
    const base = {
      schemaVersion: 1,
      environment: "production",
      mode: "read",
      baseUrl: "https://admin.example.test",
      iterations: 1,
    } as const;

    await expect(runAdminCanary({
      ...base,
      requests: [{ name: "origin escape", method: "GET", path: "/\\evil.example.test/steal", expectedStatuses: [200] }],
    }, { fetch })).rejects.toThrow();
    await expect(runAdminCanary({
      ...base,
      requests: [{ name: "non-admin endpoint", method: "GET", path: "/api/internal/metrics", expectedStatuses: [200] }],
    }, { fetch })).rejects.toThrow();
    await expect(runAdminCanary({
      ...base,
      requests: [{ name: "fake success", method: "GET", path: "/api/v2/admin/today", expectedStatuses: [500] }],
    }, { fetch })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails the canary when any response is unexpected or unavailable", async () => {
    const request = vi.fn<AdminCanaryFetch>(async () => new Response("{}"))
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockRejectedValueOnce(new Error("network unavailable"));
    const report = await runAdminCanary({
      schemaVersion: 1,
      environment: "production",
      mode: "read",
      baseUrl: "https://admin.example.test",
      iterations: 2,
      requests: [{ name: "today", method: "GET", path: "/api/v2/admin/today", expectedStatuses: [200] }],
    }, { fetch: request });
    expect(report).toMatchObject({ status: "fail", sampleSize: 2, failures: 2, availability: 0 });
  });
});
