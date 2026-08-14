import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { prisma } from "@/server/lib/db";
import { AppError } from "@/server/lib/errors";
import type { AdminTextGenerationRuntime } from "@/server/modules/admin/shared/admin-text-generation";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { generateProductionDirections } from "./production-directions";

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

function request(role: string, userId: string, body: unknown) {
  return new Request("http://localhost/api/v1/admin/content/production/directions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-idream-user-id": userId,
      "x-idream-role": role,
    },
    body: JSON.stringify(body),
  });
}

async function call(handler: Promise<Response>): Promise<CallResult> {
  try {
    const response = await handler;
    const json = (await response.json()) as { ok?: boolean; data?: CallResult["data"] };
    return {
      status: response.status,
      ok: Boolean(json.ok),
      data: json.data,
      errorCode: undefined,
    };
  } catch (error) {
    if (error instanceof AppError) {
      return {
        status: error.status,
        ok: false,
        data: undefined,
        errorCode: error.code,
      };
    }
    if (error instanceof ZodError) {
      return {
        status: 400,
        ok: false,
        data: undefined,
        errorCode: "bad_request",
      };
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
    const result = await call(
      generateProductionDirections(request("admin", `${P}admin`, validBody)),
    );
    expect(result.status).toBe(503);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("unavailable");
    expect(result.data).toBeUndefined();
  });

  it("returns four editable directions from a valid real model response", async () => {
    const result = await call(
      generateProductionDirections(
        request("admin", `${P}admin`, validBody),
        pipelineRuntime(validModelDirections),
      ),
    );
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
    const result = await call(
      generateProductionDirections(
        request("admin", `${P}admin`, {
          ...validBody,
          creativeBrief: "",
          scenePrompt: "",
        }),
        pipelineRuntime(validModelDirections),
      ),
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
    const result = await call(
      generateProductionDirections(
        request("admin", `${P}admin`, validBody),
        failingRuntime,
      ),
    );

    expect(result.status).toBe(503);
    expect(result.errorCode).toBe("unavailable");
    expect(result.data).toBeUndefined();
  });

  it("returns 503 without directions for invalid model output", async () => {
    const result = await call(
      generateProductionDirections(
        request("admin", `${P}admin`, validBody),
        pipelineRuntime("not valid direction JSON"),
      ),
    );

    expect(result.status).toBe(503);
    expect(result.errorCode).toBe("unavailable");
    expect(result.data).toBeUndefined();
  });

  it("requires content.production.write", async () => {
    const result = await call(
      generateProductionDirections(request("support", `${P}support`, validBody)),
    );
    expect(result.status).toBe(403);
  });

  it("validates the operator brief length before calling the model", async () => {
    const result = await call(
      generateProductionDirections(
        request("admin", `${P}admin`, { ...validBody, creativeBrief: "x".repeat(241) }),
      ),
    );
    expect(result.status).toBe(400);
  });
});
