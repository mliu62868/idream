import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { AppError } from "@/server/lib/errors";
import { adminV2Api } from "@/server/test/admin-v2-api";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { generateProductionDirections } from "./production";
import type { AdminTextGenerationRuntime } from "./text-generation";

const DIRECTIONS = "/api/v2/admin/content/production/directions";

const P = "zt-production-directions-";

type CallResult = {
  status: number;
  ok: boolean;
  data:
    | {
        directions?: Array<Record<string, unknown>>;
        source?: string;
        runtime?: {
          provider: string;
          pipelineUrl: string | null;
          model: string | null;
        };
      }
    | undefined;
  errorCode: string | undefined;
};

/** Route-level call: authority, contract and moderation boundaries. */
async function route(role: string, userId: string, body: unknown): Promise<CallResult> {
  const response = await adminV2Api("POST", DIRECTIONS, { role, userId, body });
  return {
    status: response.status,
    ok: response.ok,
    data: response.data,
    errorCode: response.error?.code,
  };
}

/** Module-level call: the only door that can inject a text-generation runtime. */
async function withRuntime(
  body: Parameters<typeof generateProductionDirections>[0],
  runtime?: AdminTextGenerationRuntime,
): Promise<CallResult> {
  try {
    return {
      status: 200,
      ok: true,
      data: await generateProductionDirections(body, runtime),
      errorCode: undefined,
    };
  } catch (error) {
    if (error instanceof AppError) {
      return { status: error.status, ok: false, data: undefined, errorCode: error.code };
    }
    throw error;
  }
}

function pipelineRuntime(output: string): AdminTextGenerationRuntime {
  return {
    provider: "pipeline",
    pipelineUrl: "https://pipeline.test.invalid/v1",
    model: "test-model",
    async *stream() {
      yield { delta: output, done: false };
      yield { delta: "", done: true };
    },
  };
}

const validModelDirections = JSON.stringify([
  {
    title: "Close conversation",
    scenePrompt: "A close conversational pause beneath a rain-dark awning after work.",
    mood: "tender and reflective",
    setting: "rainy city awning",
    outfit: "dark trench coat",
    camera: "85mm close portrait",
    lighting: "soft neon edge light",
  },
  {
    title: "Crosswalk motion",
    scenePrompt: "She crosses a reflective avenue while turning back with a restrained smile.",
    mood: "quietly hopeful",
    setting: "wet city crosswalk",
    outfit: "dark trench coat",
    camera: "50mm candid frame",
    lighting: "streetlight and passing headlights",
  },
  {
    title: "Window reflection",
    scenePrompt: "Her reflection overlaps a late-night cafe window as she waits in thought.",
    mood: "introspective",
    setting: "closed cafe frontage",
    outfit: "dark trench coat",
    camera: "35mm layered composition",
    lighting: "warm practicals against cool rain",
  },
  {
    title: "Rooftop release",
    scenePrompt: "She reaches the rooftop and lets the rain soften the weight of the shift.",
    mood: "liberated and calm",
    setting: "city rooftop",
    outfit: "dark trench coat",
    camera: "wide environmental portrait",
    lighting: "blue-hour skyline glow",
  },
]);

const validBody = {
  characterId: `${P}character`,
  purpose: "character_chat",
  creativeBrief: "Rainy night after work",
  scenePrompt: "A quiet walk through wet city streets after a long shift",
  mood: "melancholic",
  setting: "urban night",
  outfit: "trench coat",
  camera: "50mm portrait",
  lighting: "neon and streetlight",
  consistencyMode: "balanced",
} as const;

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: `${P}admin`, role: "admin" });
  await createUser({ id: `${P}support`, role: "support" });
  await createCharacter({ id: validBody.characterId, name: "Direction Muse" });
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("production creative directions", () => {
  it("fails closed instead of returning deterministic fallback directions from the mock provider", async () => {
    const result = await route("admin", `${P}admin`, validBody);
    expect(result.status).toBe(503);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("unavailable");
    expect(result.data).toBeUndefined();
  });

  it("returns four editable directions from a valid real model response", async () => {
    const result = await withRuntime(validBody, pipelineRuntime(validModelDirections));
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.data?.directions).toHaveLength(4);
    expect(
      result.data?.directions?.every(
        (direction) => typeof direction.scenePrompt === "string",
      ),
    ).toBe(true);
    expect(result.data?.source).toBe("model");
    expect(result.data?.runtime).toEqual({
      provider: "pipeline",
      pipelineUrl: "https://pipeline.test.invalid/v1",
      model: "test-model",
    });
  });

  it("creates starter directions from the character when the operator leaves both prompt fields blank", async () => {
    const result = await withRuntime(
      { ...validBody, creativeBrief: "", scenePrompt: "" },
      pipelineRuntime(validModelDirections),
    );

    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.data?.directions).toHaveLength(4);
    expect(
      result.data?.directions?.every(
        (direction) =>
          typeof direction.scenePrompt === "string" && direction.scenePrompt.length > 12,
      ),
    ).toBe(true);
  });

  it("returns 503 without directions when the real provider throws", async () => {
    const failingRuntime: AdminTextGenerationRuntime = {
      provider: "pipeline",
      pipelineUrl: "https://pipeline.test.invalid/v1",
      model: "test-model",
      async *stream() {
        throw new Error("chat backend offline");
      },
    };
    const result = await withRuntime(validBody, failingRuntime);

    expect(result.status).toBe(503);
    expect(result.errorCode).toBe("unavailable");
    expect(result.data).toBeUndefined();
  });

  it("returns 503 without directions for invalid model output", async () => {
    const result = await withRuntime(validBody, pipelineRuntime("not valid direction JSON"));

    expect(result.status).toBe(503);
    expect(result.errorCode).toBe("unavailable");
    expect(result.data).toBeUndefined();
  });

  it("requires content.production.write", async () => {
    const result = await route("support", `${P}support`, validBody);
    expect(result.status).toBe(403);
  });

  it("validates the operator brief length before calling the model", async () => {
    const result = await route("admin", `${P}admin`, {
      ...validBody,
      creativeBrief: "x".repeat(241),
    });
    expect(result.status).toBe(400);
  });
});
