// SPEC: AI 辅助生成回归。运行时注入用的是模块函数（Route Handler 无从注入 runtime），
//       权限 / 契约 / moderation 三条边界走真实 Route Handler。
// INVARIANTS: mock chat output must never become an operator-saveable creative draft.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { AppError } from "@/server/lib/errors";
import { adminV2 as adminV2Api } from "@/server/test/admin-v2-http";
import { createUser, purgeTestData } from "@/server/test/helpers";
import { generateCharacterDraft } from "./assist";
import type { AdminTextGenerationRuntime } from "./text-generation";

const P = "zt-assist-";
const ASSIST = "/api/v2/admin/content/character-assist";

type CallResult = {
  status: number;
  ok: boolean;
  data: Awaited<ReturnType<typeof generateCharacterDraft>> | undefined;
  errorCode: string | undefined;
};

function pipelineRuntime(
  outputForSystemPrompt: (systemPrompt: string) => string,
): AdminTextGenerationRuntime {
  return {
    provider: "pipeline",
    pipelineUrl: "https://pipeline.test.invalid/v1",
    model: "test-model",
    async *stream(input) {
      const systemPrompt =
        input.messages.find((message) => message.role === "system")?.content ?? "";
      const output = outputForSystemPrompt(systemPrompt);
      const splitAt = Math.max(1, Math.floor(output.length / 2));
      yield { delta: output.slice(0, splitAt), done: false };
      yield { delta: output.slice(splitAt), done: false };
      yield { delta: "", done: true };
    },
  };
}

async function withRuntime(
  body: Parameters<typeof generateCharacterDraft>[0],
  runtime?: AdminTextGenerationRuntime,
): Promise<CallResult> {
  try {
    return { status: 200, ok: true, data: await generateCharacterDraft(body, runtime), errorCode: undefined };
  } catch (error) {
    if (error instanceof AppError) {
      return { status: error.status, ok: false, data: undefined, errorCode: error.code };
    }
    throw error;
  }
}

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: `${P}admin`, role: "admin" });
  await createUser({ id: `${P}ops`, role: "ops" });
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("character AI assist", () => {
  it("fails closed instead of returning saveable fields from the mock chat provider", async () => {
    const result = await adminV2Api("POST", ASSIST, {
      userId: `${P}admin`,
      role: "admin",
      body: { seed: "shy bookish painter who loves rainy nights", gender: "female", style: "realistic" },
    });
    expect(result.status).toBe(503);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("unavailable");
    expect(result.data).toBeUndefined();
  });

  it("returns structured editable fields when a real model runtime responds", async () => {
    const runtime = pipelineRuntime((systemPrompt) => {
      if (systemPrompt.includes("background bio")) {
        return "Mara restores old paintings by day and sketches rain-soaked streets at night.";
      }
      if (systemPrompt.includes("personality traits")) {
        return "observant, gentle, quietly witty";
      }
      if (systemPrompt.includes("speaking style")) {
        return "She speaks in measured, warm sentences. She often notices one small sensory detail.";
      }
      if (systemPrompt.includes("first message")) {
        return "You caught me watching the rain again. Want to keep me company for a minute?";
      }
      if (systemPrompt.includes("visual art direction")) {
        return "Soft brown eyes, dark wavy hair, paint-marked linen, amber and slate palette.";
      }
      if (systemPrompt.includes("exactly 3 distinctive character names")) {
        return "Mara Vale\nElin Rowe\nNora Voss";
      }
      throw new Error("Unexpected system prompt");
    });

    const result = await withRuntime(
      {
        seed: "shy bookish painter who loves rainy nights",
        gender: "female",
        style: "realistic",
      },
      runtime,
    );

    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      description:
        "Mara restores old paintings by day and sketches rain-soaked streets at night.",
      nameIdeas: ["Mara Vale", "Elin Rowe", "Nora Voss"],
      advancedDetails: {
        personality: "observant, gentle, quietly witty",
        speakingStyle:
          "She speaks in measured, warm sentences. She often notices one small sensory detail.",
        firstMessage:
          "You caught me watching the rain again. Want to keep me company for a minute?",
        visualBrief:
          "Soft brown eyes, dark wavy hair, paint-marked linen, amber and slate palette.",
      },
      runtime: {
        provider: "pipeline",
        pipelineUrl: "https://pipeline.test.invalid/v1",
        model: "test-model",
      },
    });
  });

  it("does not overlap requests against a single-model runtime", async () => {
    let active = 0;
    let maxActive = 0;
    const responseFor = (systemPrompt: string) => {
      if (systemPrompt.includes("background bio")) return "A concise adult companion biography.";
      if (systemPrompt.includes("personality traits")) return "observant, warm, precise";
      if (systemPrompt.includes("speaking style")) return "Warm and measured. She notices details.";
      if (systemPrompt.includes("first message")) return "Come sit with me for a while.";
      if (systemPrompt.includes("visual art direction")) return "Dark hair, tailored coat, amber light.";
      if (systemPrompt.includes("exactly 3 distinctive character names")) return "Mara Vale\nElin Rowe\nNora Voss";
      throw new Error("Unexpected system prompt");
    };
    const runtime: AdminTextGenerationRuntime = {
      provider: "pipeline",
      pipelineUrl: "https://pipeline.test.invalid/v1",
      model: "single-model",
      async *stream(input) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (active > 1) throw new Error("single-model gateway received overlap");
          const systemPrompt =
            input.messages.find((message) => message.role === "system")?.content ?? "";
          yield { delta: responseFor(systemPrompt), done: false };
          yield { delta: "", done: true };
        } finally {
          active -= 1;
        }
      },
    };

    const result = await withRuntime(
      { seed: "a patient listener who hosts a late-night radio show" },
      runtime,
    );

    expect(result.status).toBe(200);
    expect(maxActive).toBe(1);
  });

  it("rejects a mock-shaped response even when the runtime is mislabeled as real", async () => {
    const result = await withRuntime(
      { seed: "a thoughtful astronomer who maps quiet constellations" },
      pipelineRuntime(() => "Mock character reply: synthetic draft"),
    );

    expect(result.status).toBe(503);
    expect(result.errorCode).toBe("unavailable");
    expect(result.data).toBeUndefined();
  });

  it("rejects roles without content.official.write (403)", async () => {
    const result = await adminV2Api("POST", ASSIST, {
      userId: `${P}ops`,
      role: "ops",
      body: { seed: "a cheerful barista" },
    });
    expect(result.status).toBe(403);
    expect(result.ok).toBe(false);
  });

  it("rejects a too-short seed (contract 400)", async () => {
    const result = await adminV2Api("POST", ASSIST, {
      userId: `${P}admin`,
      role: "admin",
      body: { seed: "x" },
    });
    expect(result.status).toBe(400);
  });

  it("blocks underage seeds via moderation (403)", async () => {
    const result = await adminV2Api("POST", ASSIST, {
      userId: `${P}admin`,
      role: "admin",
      body: { seed: "an underage minor character" },
    });
    expect(result.status).toBe(403);
    expect(result.ok).toBe(false);
  });
});
