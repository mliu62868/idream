// SPEC: AI 辅助生成服务层回归（§8 增强）。直接调用 handler（dispatch 由编排者接线）。
//       覆盖：mock provider fail-closed、权限 403、seed 过短 zod 拒、moderation blocked→403。
// INVARIANTS: mock chat output must never become an operator-saveable creative draft.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { prisma } from "@/server/lib/db";
import { AppError } from "@/server/lib/errors";
import { createUser, purgeTestData } from "@/server/test/helpers";
import type { AdminTextGenerationRuntime } from "@/server/modules/admin/shared/admin-text-generation";
import { generateCharacterDraft } from "./assist";

const P = "zt-assist-";

type CallResult = {
  status: number;
  ok: boolean;
  data: {
    description?: string;
    nameIdeas?: string[];
    advancedDetails?: {
      personality?: string;
      speakingStyle?: string;
      firstMessage?: string;
      visualBrief?: string;
    };
  } | undefined;
  errorCode: string | undefined;
};

function makeRequest(opts: { userId: string; role: string; body: unknown }): Request {
  return new Request("http://localhost/api/v1/admin/content/character-assist", {
    method: "POST",
    headers: {
      "x-idream-user-id": opts.userId,
      "x-idream-role": opts.role,
      "content-type": "application/json",
    },
    body: JSON.stringify(opts.body),
  });
}

function pipelineRuntime(
  outputForSystemPrompt: (systemPrompt: string) => string,
): AdminTextGenerationRuntime {
  return {
    provider: "pipeline",
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

async function call(handler: Promise<Response>): Promise<CallResult> {
  try {
    const res = await handler;
    const text = await res.text();
    const json = text ? (JSON.parse(text) as { ok?: boolean; data?: CallResult["data"] }) : null;
    return { status: res.status, ok: Boolean(json?.ok), data: json?.data, errorCode: undefined };
  } catch (error) {
    if (error instanceof AppError) {
      return { status: error.status, ok: false, data: undefined, errorCode: error.code };
    }
    if (error instanceof ZodError) {
      return { status: 400, ok: false, data: undefined, errorCode: "bad_request" };
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
    const result = await call(
      generateCharacterDraft(
        makeRequest({
          userId: `${P}admin`,
          role: "admin",
          body: { seed: "shy bookish painter who loves rainy nights", gender: "female", style: "realistic" },
        }),
      ),
    );
    expect(result.status).toBe(503);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("unavailable");
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

    const result = await call(
      generateCharacterDraft(
        makeRequest({
          userId: `${P}admin`,
          role: "admin",
          body: {
            seed: "shy bookish painter who loves rainy nights",
            gender: "female",
            style: "realistic",
          },
        }),
        runtime,
      ),
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
    });
  });

  it("rejects a mock-shaped response even when the runtime is mislabeled as real", async () => {
    const result = await call(
      generateCharacterDraft(
        makeRequest({
          userId: `${P}admin`,
          role: "admin",
          body: { seed: "a thoughtful astronomer who maps quiet constellations" },
        }),
        pipelineRuntime(() => "Mock character reply: synthetic draft"),
      ),
    );

    expect(result.status).toBe(503);
    expect(result.errorCode).toBe("unavailable");
    expect(result.data).toBeUndefined();
  });

  it("rejects roles without content.official.write (403)", async () => {
    const result = await call(
      generateCharacterDraft(
        makeRequest({ userId: `${P}ops`, role: "ops", body: { seed: "a cheerful barista" } }),
      ),
    );
    expect(result.status).toBe(403);
    expect(result.ok).toBe(false);
  });

  it("rejects a too-short seed (zod 400)", async () => {
    const result = await call(
      generateCharacterDraft(makeRequest({ userId: `${P}admin`, role: "admin", body: { seed: "x" } })),
    );
    expect(result.status).toBe(400);
  });

  it("blocks underage seeds via moderation (403)", async () => {
    const result = await call(
      generateCharacterDraft(
        makeRequest({ userId: `${P}admin`, role: "admin", body: { seed: "an underage minor character" } }),
      ),
    );
    expect(result.status).toBe(403);
    expect(result.ok).toBe(false);
  });
});
