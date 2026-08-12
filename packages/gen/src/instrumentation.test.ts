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

import { captureGenerationRuntimeFailure } from "./instrumentation";

describe("generation Sentry boundaries", () => {
  beforeEach(() => sentry.captureException.mockClear());

  it.each([
    ["image", "source-recovery", undefined],
    ["image", "worker", "image-job-1"],
    ["video", "source-recovery", undefined],
    ["video", "worker", "video-job-1"],
  ] as const)("captures %s %s failures", (mode, boundary, jobId) => {
    const error = new Error(`${mode} ${boundary} failed`);

    expect(
      captureGenerationRuntimeFailure({ boundary, error, jobId, mode }),
    ).toBe("event-id");
    expect(sentry.captureException).toHaveBeenCalledWith(error, {
      tags: {
        boundary: `${mode}-${boundary}`,
        ...(jobId ? { jobId } : {}),
      },
    });
  });

  it("loads APP_ENV and SENTRY_DSN before initializing from a deployment env file", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "idream-gen-sentry-"));
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
