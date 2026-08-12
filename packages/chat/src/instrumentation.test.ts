import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const sentry = vi.hoisted(() => ({
  captureException: vi.fn(() => "event-id"),
  init: vi.fn(),
}));

vi.mock("@sentry/node", () => sentry);

import { captureChatRuntimeWarmupFailure } from "./instrumentation";

describe("chat Sentry boundary", () => {
  beforeEach(() => sentry.captureException.mockClear());

  it("captures runtime warm-up failures with the owning boundary tag", () => {
    const error = new Error("warm-up failed");

    expect(captureChatRuntimeWarmupFailure(error)).toBe("event-id");
    expect(sentry.captureException).toHaveBeenCalledWith(error, {
      tags: { boundary: "runtime-warmup" },
    });
  });

  it("loads APP_ENV and SENTRY_DSN before initializing from a deployment env file", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "idream-chat-sentry-"));
    const envFile = path.join(directory, ".env");
    writeFileSync(
      envFile,
      "APP_ENV=production\nSENTRY_DSN=https://public@sentry.invalid/1\n",
    );
    const { APP_ENV: _appEnv, SENTRY_DSN: _dsn, ...baseEnv } = process.env;
    try {
      const result = spawnSync(
        path.resolve("node_modules/.bin/tsx"),
        [
          "--eval",
          'import("./src/instrumentation.ts").then(() => import("@sentry/node")).then((Sentry) => process.stdout.write(Sentry.getClient() ? "ready" : "off"))',
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...baseEnv, DOTENV_CONFIG_PATH: envFile },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("ready");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
