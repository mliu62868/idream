import { describe, expect, it } from "vitest";
import { AppError } from "@/server/lib/errors";
import {
  generateAdminText,
  type AdminTextGenerationRuntime,
} from "./text-generation";

function runtime(
  stream: AdminTextGenerationRuntime["stream"],
  provider: AdminTextGenerationRuntime["provider"] = "pipeline",
): AdminTextGenerationRuntime {
  return {
    provider,
    pipelineUrl:
      provider === "pipeline" ? "https://pipeline.test.invalid/v1" : null,
    model: provider === "pipeline" ? "test-model" : null,
    stream,
  };
}

async function unavailableCode(
  generation: Promise<string>,
): Promise<string | undefined> {
  try {
    await generation;
    return undefined;
  } catch (error) {
    if (error instanceof AppError) {
      expect(error.status).toBe(503);
      return error.code;
    }
    throw error;
  }
}

const input = {
  messages: [
    { role: "system" as const, content: "Return a concise operator draft." },
    { role: "user" as const, content: "A thoughtful astronomer." },
  ],
};

describe("admin text generation runtime", () => {
  it("rejects the configured mock provider before streaming", async () => {
    let streamed = false;
    const result = unavailableCode(
      generateAdminText(
        input,
        runtime(async function* stream() {
          streamed = true;
          yield { delta: "synthetic", done: false };
        }, "mock"),
      ),
    );

    await expect(result).resolves.toBe("unavailable");
    expect(streamed).toBe(false);
  });

  it("rejects empty real-provider output", async () => {
    const result = unavailableCode(
      generateAdminText(
        input,
        runtime(async function* stream() {
          yield { delta: "   ", done: false };
          yield { delta: "", done: true };
        }),
      ),
    );

    await expect(result).resolves.toBe("unavailable");
  });

  it("rejects a mock signature from a mislabeled provider", async () => {
    const result = unavailableCode(
      generateAdminText(
        input,
        runtime(async function* stream() {
          yield {
            delta: "Mock character reply: A thoughtful astronomer.",
            done: false,
          };
        }),
      ),
    );

    await expect(result).resolves.toBe("unavailable");
  });

  it("converts provider failures to an unavailable error", async () => {
    const result = unavailableCode(
      generateAdminText(
        input,
        runtime(async function* stream() {
          throw new Error("backend offline");
        }),
      ),
    );

    await expect(result).resolves.toBe("unavailable");
  });

  it("returns aggregated text from a real provider", async () => {
    const result = generateAdminText(
      input,
      runtime(async function* stream() {
        yield { delta: "Real ", done: false };
        yield { delta: "operator draft", done: false };
        yield { delta: "", done: true };
      }),
    );

    await expect(result).resolves.toBe("Real operator draft");
  });
});
