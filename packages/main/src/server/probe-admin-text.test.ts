import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAdminTextProbe } from "./probe-admin-text";

const assistData = {
  description: "A rain-loving painter who restores old portraits after dark.",
  nameIdeas: ["Mara Vale", "Elin Rowe", "Nora Voss"],
  advancedDetails: {
    personality: "observant, gentle, quietly witty",
    speakingStyle: "Measured, warm sentences with one sensory detail.",
    firstMessage: "You caught me watching the rain again.",
    visualBrief: "Dark wavy hair, paint-marked linen, amber light.",
  },
};

const directions = Array.from({ length: 4 }, (_, index) => ({
  title: `Direction ${index + 1}`,
  scenePrompt: `A distinct production scene number ${index + 1} preserving the locked identity.`,
  mood: "reflective",
  setting: "rainy studio",
  outfit: "linen workwear",
  camera: "85mm portrait",
  lighting: "amber window light",
}));

const serverRuntime = {
  provider: "pipeline",
  pipelineUrl: "https://pipeline.ourdream.internal/v1",
  model: "qwen-production",
  sourceRevision: "idream@main-revision-123",
} as const;

describe("Main Admin text launch probe", () => {
  it("loads package environment before validating the CLI contract", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "idream-admin-text-probe-"));
    const envFile = path.join(directory, ".env");
    writeFileSync(
      envFile,
      [
        "CHAT_PROVIDER=pipeline",
        "PIPELINE_API_URL=https://pipeline.ourdream.internal/v1",
        "PIPELINE_CHAT_MODEL_DEFAULT=qwen-production",
        "ADMIN_WEB_URL=https://admin.ourdream.ai",
        "ADMIN_TEXT_PROBE_CHARACTER_ID=reviewed-character-1",
        "ADMIN_TEXT_PROBE_COOKIE=idream_admin_session=redacted-session",
        "",
      ].join("\n"),
    );
    const {
      CHAT_PROVIDER: _provider,
      PIPELINE_API_URL: _pipelineUrl,
      PIPELINE_CHAT_MODEL_DEFAULT: _model,
      ADMIN_WEB_URL: _adminUrl,
      ADMIN_TEXT_PROBE_CHARACTER_ID: _characterId,
      ADMIN_TEXT_PROBE_COOKIE: _cookie,
      ...baseEnv
    } = process.env;
    try {
      const result = spawnSync(
        path.resolve("node_modules/.bin/tsx"),
        ["src/server/probe-admin-text.ts"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...baseEnv, DOTENV_CONFIG_PATH: envFile },
        },
      );

      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        provider: "pipeline",
        pipelineUrl: "https://pipeline.ourdream.internal/v1",
        model: "qwen-production",
        adminUrl: "https://admin.ourdream.ai",
        characterId: "reviewed-character-1",
        authMode: "cookie",
        error: {
          code: "admin_text_probe_configuration_invalid",
          message: expect.stringContaining("--allow-immutable-audit"),
        },
      });
      expect(result.stdout).not.toContain("redacted-session");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("does not send any request without explicit immutable-audit consent", async () => {
    const fetchImpl = vi.fn();

    const report = await runAdminTextProbe({
      adminUrl: "https://admin.ourdream.ai",
      characterId: "reviewed-character-1",
      cookie: "idream_admin_session=redacted-session",
      authorization: null,
      provider: "pipeline",
      pipelineUrl: "https://pipeline.ourdream.internal/v1",
      model: "qwen-production",
      allowImmutableAudit: false,
      fetchImpl,
      now: () => new Date("2026-08-12T18:00:00.000Z"),
    });

    expect(report).toMatchObject({
      ok: false,
      characterAssist: null,
      productionDirections: null,
      cleanup: {
        fixture: "not_created",
        immutableModerationAudit: "retained_by_authority",
      },
      error: { code: "admin_text_probe_configuration_invalid" },
    });
    expect(report.error?.message).toContain("--allow-immutable-audit");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports both authenticated preview routes through the configured Main pipeline adapter", async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit) => {
        const pathname = new URL(
          input instanceof Request ? input.url : input.toString(),
        ).pathname;
        if (pathname.endsWith("/character-assist")) {
          return Response.json(
            {
              ok: true,
              data: { ...assistData, runtime: serverRuntime },
            },
            { headers: { "x-idream-admin-source-revision": "idream@admin-revision-123" } },
          );
        }
        if (pathname.endsWith("/production/directions")) {
          return Response.json(
            {
              ok: true,
              data: { directions, source: "model", runtime: serverRuntime },
            },
            { headers: { "x-idream-admin-source-revision": "idream@admin-revision-123" } },
          );
        }
        return Response.json({ ok: false }, { status: 404 });
      },
    );

    const report = await runAdminTextProbe({
      adminUrl: "https://admin.ourdream.ai",
      characterId: "reviewed-character-1",
      cookie: "idream_admin_session=redacted-session",
      authorization: null,
      provider: "pipeline",
      pipelineUrl: "https://pipeline.ourdream.internal/v1",
      model: "qwen-production",
      allowImmutableAudit: true,
      correlationId: "admin-text-probe-correlation-123",
      fetchImpl,
      now: () => new Date("2026-08-12T18:00:00.000Z"),
    });

    expect(report).toMatchObject({
      ok: true,
      checkedAt: "2026-08-12T18:00:00.000Z",
      provider: "pipeline",
      pipelineUrl: "https://pipeline.ourdream.internal/v1",
      model: "qwen-production",
      adminSourceRevision: "idream@admin-revision-123",
      adminUrl: "https://admin.ourdream.ai",
      characterId: "reviewed-character-1",
      authMode: "cookie",
      correlationId: "admin-text-probe-correlation-123",
      requestIds: {
        characterAssist: "admin-text-probe-correlation-123-assist",
        productionDirections: "admin-text-probe-correlation-123-directions",
      },
      characterAssist: {
        ok: true,
        status: 200,
        nameIdeas: 3,
        descriptionCharacters: assistData.description.length,
        runtime: serverRuntime,
      },
      productionDirections: {
        ok: true,
        status: 200,
        directions: 4,
        source: "model",
        runtime: serverRuntime,
      },
      cleanup: {
        fixture: "not_created",
        immutableModerationAudit: "retained_by_authority",
      },
      error: null,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [index, [, init]] of fetchImpl.mock.calls.entries()) {
      expect(init).toMatchObject({
        method: "POST",
        headers: expect.objectContaining({
          cookie: "idream_admin_session=redacted-session",
          "x-request-id":
            index === 0
              ? "admin-text-probe-correlation-123-assist"
              : "admin-text-probe-correlation-123-directions",
        }),
      });
    }
  });

  it("records the runtime identity observed from Main instead of trusting the probe environment", async () => {
    const deployedRuntime = {
      provider: "pipeline",
      pipelineUrl: "https://deployed-pipeline.ourdream.internal/v1",
      model: "deployed-model-b",
      sourceRevision: "idream@main-revision-123",
    } as const;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(
        input instanceof Request ? input.url : input.toString(),
      ).pathname;
      return pathname.endsWith("/character-assist")
        ? Response.json(
            {
              ok: true,
              data: { ...assistData, runtime: deployedRuntime },
            },
            { headers: { "x-idream-admin-source-revision": "idream@admin-revision-123" } },
          )
        : Response.json(
            {
              ok: true,
              data: { directions, source: "model", runtime: deployedRuntime },
            },
            { headers: { "x-idream-admin-source-revision": "idream@admin-revision-123" } },
          );
    });

    const report = await runAdminTextProbe({
      adminUrl: "https://admin.ourdream.ai",
      characterId: "reviewed-character-1",
      cookie: "idream_admin_session=redacted-session",
      authorization: null,
      provider: "pipeline",
      pipelineUrl: "https://claimed-pipeline.ourdream.internal/v1",
      model: "claimed-model-a",
      allowImmutableAudit: true,
      fetchImpl,
      now: () => new Date("2026-08-12T18:00:00.000Z"),
    });

    expect(report).toMatchObject({
      ok: true,
      provider: "pipeline",
      pipelineUrl: deployedRuntime.pipelineUrl,
      model: deployedRuntime.model,
      characterAssist: { runtime: deployedRuntime },
      productionDirections: { runtime: deployedRuntime },
    });
  });

  it("fails when the two Main routes report different runtime identities", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(
        input instanceof Request ? input.url : input.toString(),
      ).pathname;
      return pathname.endsWith("/character-assist")
        ? Response.json(
            {
              ok: true,
              data: { ...assistData, runtime: serverRuntime },
            },
            { headers: { "x-idream-admin-source-revision": "idream@admin-revision-123" } },
          )
        : Response.json(
            {
              ok: true,
              data: {
                directions,
                source: "model",
                runtime: { ...serverRuntime, model: "different-model" },
              },
            },
            { headers: { "x-idream-admin-source-revision": "idream@admin-revision-123" } },
          );
    });

    const report = await runAdminTextProbe({
      adminUrl: "https://admin.ourdream.ai",
      characterId: "reviewed-character-1",
      cookie: "idream_admin_session=redacted-session",
      authorization: null,
      provider: "pipeline",
      pipelineUrl: serverRuntime.pipelineUrl,
      model: serverRuntime.model,
      allowImmutableAudit: true,
      fetchImpl,
      now: () => new Date("2026-08-12T18:00:00.000Z"),
    });

    expect(report.ok).toBe(false);
    expect(report.error).toMatchObject({
      code: "admin_text_probe_runtime_identity_mismatch",
    });
  });
});
