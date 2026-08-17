import { describe, expect, it, vi } from "vitest";

import { OpenAICompatibleChatModel, type ChatChunk } from "./openai-compatible-model";
import { resolveChatModelProfile, type ChatModelProfile } from "./model-profile";

const PROFILE: ChatModelProfile = {
  ...resolveChatModelProfile({ CHAT_MODEL_PROVIDER: "openai" }),
  baseUrl: "http://model.test/v1",
  model: "test-model",
  firstTokenTimeoutMs: 5_000,
  idleTimeoutMs: 5_000,
  completionTimeoutMs: 5_000,
};

/** Frames each event the way an OpenAI-compatible server frames SSE. */
function sseResponse(events: string[]): Response {
  return new Response(events.map((event) => `data: ${event}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function drain(
  events: string[],
  profile: ChatModelProfile = PROFILE,
): Promise<{ chunks: ChatChunk[]; body: Record<string, unknown> }> {
  let body: Record<string, unknown> = {};
  const model = new OpenAICompatibleChatModel(
    profile,
    vi.fn(async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse(events);
    }),
  );
  const chunks: ChatChunk[] = [];
  for await (const chunk of model.stream({ messages: [{ role: "user", content: "hi" }] })) {
    chunks.push(chunk);
  }
  return { chunks, body };
}

describe("openai-compatible chat model", () => {
  it("sends the profile's sampling knobs instead of relying on the model server's defaults", async () => {
    const { body } = await drain(["[DONE]"]);

    expect(body).toMatchObject({
      temperature: 0.9,
      top_p: 0.95,
      repetition_penalty: 1.05,
      stream_options: { include_usage: true },
    });
  });

  it("uses the structured temperature for completions, not the in-character one", async () => {
    let body: Record<string, unknown> = {};
    const model = new OpenAICompatibleChatModel(
      PROFILE,
      vi.fn(async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ choices: [{ finish_reason: "stop", message: { content: "{}" } }] });
      }),
    );

    await model.complete({ messages: [{ role: "user", content: "{}" }] });

    expect(body.temperature).toBe(PROFILE.structuredTemperature);
    expect(body.temperature).not.toBe(PROFILE.temperature);
  });

  it("carries the provider's real token counts on the final chunk", async () => {
    const { chunks } = await drain([
      '{"choices":[{"delta":{"content":"你好"}}]}',
      '{"choices":[],"usage":{"prompt_tokens":123,"completion_tokens":45,"total_tokens":168}}',
      "[DONE]",
    ]);

    expect(chunks).toEqual([
      { delta: "你好", done: false },
      { delta: "", done: true, toolCalls: [], usage: { promptTokens: 123, completionTokens: 45 } },
    ]);
  });

  it("still reports usage when the stream ends without a [DONE] sentinel", async () => {
    const { chunks } = await drain([
      '{"choices":[{"delta":{"content":"hi"}}]}',
      '{"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}',
    ]);

    expect(chunks.at(-1)).toEqual({
      delta: "",
      done: true,
      toolCalls: [],
      usage: { promptTokens: 7, completionTokens: 2 },
    });
  });

  it("leaves usage undefined when the provider reports none", async () => {
    const { chunks } = await drain(['{"choices":[{"delta":{"content":"hi"}}]}', "[DONE]"]);

    expect(chunks.at(-1)?.usage).toBeUndefined();
  });
});
