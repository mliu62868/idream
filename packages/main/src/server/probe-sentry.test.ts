import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runSentryCanary } from "./probe-sentry";

describe("Sentry canary", () => {
  it("loads its production DSN from the package env before validating operator credentials", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "idream-sentry-probe-"));
    const envFile = path.join(directory, ".env");
    writeFileSync(
      envFile,
      "APP_ENV=production\nSENTRY_DSN=https://public@sentry.invalid/1\nSENTRY_ORG=idream\n",
    );
    const {
      APP_ENV: _appEnv,
      SENTRY_DSN: _dsn,
      SENTRY_ORG: _org,
      SENTRY_CANARY_AUTH_TOKEN: _token,
      ...baseEnv
    } = process.env;
    try {
      const result = spawnSync(
        path.resolve("node_modules/.bin/tsx"),
        ["src/server/probe-sentry.ts"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...baseEnv, DOTENV_CONFIG_PATH: envFile },
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("SENTRY_CANARY_AUTH_TOKEN is required");
      expect(result.stderr).not.toContain("APP_ENV is required");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it.each(["main", "admin", "chat", "gen"] as const)(
    "captures and resolves one correlation-tagged %s production event",
    async (service) => {
      const correlationId = `sentry-canary-${service}`;
      const captureException = vi.fn(
        (_error: unknown, scope: { tags?: Record<string, string> }) => {
      expect(scope.tags).toEqual({
        "idream.canary": "true",
        "idream.correlation_id": correlationId,
        "idream.probe_emitter":
          service === "main"
            ? "main-nextjs"
            : service === "admin"
              ? "admin-nextjs"
              : service === "chat"
                ? "chat-node"
                : "gen-node",
        "idream.release": "idream@test-release",
        service,
      });
          return "0123456789abcdef0123456789abcdef";
        },
      );
      const fetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            event: {
              eventID: "0123456789abcdef0123456789abcdef",
              projectID: "1",
              tags: [
                { key: "idream.correlation_id", value: correlationId },
                {
                  key: "idream.probe_emitter",
                  value:
                    service === "main"
                      ? "main-nextjs"
                      : service === "admin"
                        ? "admin-nextjs"
                        : service === "chat"
                          ? "chat-node"
                          : "gen-node",
                },
                { key: "idream.release", value: "idream@test-release" },
                { key: "service", value: service },
              ],
            },
          }),
          { status: 200 },
        ),
      );

      const report = await runSentryCanary(
        {
          apiBaseUrl: "https://sentry.io",
          appEnv: "production",
          authToken: "secret-token",
          correlationId,
          dsn: "https://public@sentry.invalid/1",
          emitter:
            service === "main"
              ? "main-nextjs"
              : service === "admin"
                ? "admin-nextjs"
                : service === "chat"
                  ? "chat-node"
                  : "gen-node",
          organization: "idream",
          release: "idream@test-release",
          service,
        },
        {
          captureException,
          fetch,
          flush: vi.fn(async () => true),
          init: vi.fn(),
          now: () => new Date("2026-08-11T20:00:00.000Z"),
          sleep: vi.fn(async () => undefined),
        },
      );

      expect(report).toMatchObject({
        checkedAt: "2026-08-11T20:00:00.000Z",
        correlationId,
        eventId: "0123456789abcdef0123456789abcdef",
        ok: true,
        provider: "sentry",
        projectId: "1",
        service,
        verified: true,
      });
      expect(JSON.stringify(report)).not.toContain("secret-token");
      expect(fetch).toHaveBeenCalledWith(
        "https://sentry.io/api/0/organizations/idream/eventids/0123456789abcdef0123456789abcdef/",
        expect.objectContaining({
          headers: { Authorization: "Bearer secret-token" },
        }),
      );
    },
  );
});
