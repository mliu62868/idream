import { afterEach, describe, expect, it, vi } from "vitest";
import { describeMediaFrames, embedMediaText, mediaLibraryModels, rerankMediaText } from "./media-models";

const endpoint = { url: "http://model.test/v1", model: "observed-model", apiKey: "test-only" };
const response = (body: unknown) => vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
afterEach(() => vi.restoreAllMocks());

describe("explicit media model contracts", () => {
  it("never inherits unrelated igrep or OpenAI credentials", () => {
    expect(mediaLibraryModels({ IGREP_EMBEDDING_URL: "http://other/v1", OPENAI_API_KEY: "irrelevant" }))
      .toEqual({ embedding: null, rerank: null, vision: null });
    expect(() => mediaLibraryModels({ MEDIA_LIBRARY_EMBEDDING_MODEL: "embed" })).toThrow(/Configure both/);
    expect(() => mediaLibraryModels({ MEDIA_LIBRARY_VISION_MODEL: "vision", MEDIA_LIBRARY_VISION_URL: "https://user:pass@model.test/v1" })).toThrow(/credential-free/);
  });

  it("binds each normalized vector to the returned model and exact dimensions", async () => {
    const config = { ...endpoint, dimensions: 2 };
    const fetcher = response({ model: endpoint.model, data: [{ index: 0, embedding: [3, 4] }] });
    expect(await embedMediaText("A red dress", config, fetcher)).toEqual({ model: endpoint.model, dimensions: 2, vector: [0.6, 0.8] });
    expect(fetcher).toHaveBeenCalledWith("http://model.test/v1/embeddings", expect.objectContaining({ redirect: "error" }));
    for (const bad of [
      { model: "another-model", data: [{ index: 0, embedding: [3, 4] }] },
      { model: endpoint.model, data: [{ index: 0, embedding: [1] }] },
      { model: endpoint.model, data: [{ index: 0, embedding: [0, 0] }] },
      { model: endpoint.model, data: [{ index: 1, embedding: [3, 4] }] },
    ]) await expect(embedMediaText("query", config, response(bad))).rejects.toThrow();
  });

  it("rejects duplicated rerank positions and never silently falls back after a configured outage", async () => {
    await expect(rerankMediaText("query", ["one", "two"], endpoint, response({ model: endpoint.model,
      results: [{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: 0.5 }] }))).rejects.toThrow(/incompatible/);
    await expect(rerankMediaText("query", ["one"], endpoint,
      vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 503 })))).rejects.toThrow();
    expect(await rerankMediaText("query", ["one"], null)).toBeNull();
  });

  it("the request timeout remains active after headers while consuming the body", async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(20));
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"model":'));
        options?.signal?.addEventListener("abort", () => controller.error(new Error("body timed out")), { once: true });
      },
    })));
    await expect(embedMediaText("query", { ...endpoint, dimensions: 2 }, fetcher)).rejects.toThrow(/did not complete/);
  });

  it("caps response bytes and rejects truncated observations", async () => {
    await expect(embedMediaText("query", { ...endpoint, dimensions: 2 },
      vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(2_000_001))))).rejects.toThrow();
    const input = { kind: "image" as const, frames: [{ dataUrl: "data:image/jpeg;base64,AAAA", atSeconds: null }], durationSeconds: null };
    await expect(describeMediaFrames(input, endpoint, response({ model: endpoint.model,
      choices: [{ finish_reason: "length", message: { content: '{}' } }] }))).rejects.toThrow(/complete observation/);
    const observed = { description: "An adult wearing a red dress on the beach.", facts: ["red dress", "beach"], absentFacts: [], nudity: "none" };
    expect(await describeMediaFrames(input, endpoint, response({ model: endpoint.model,
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(observed) } }] }))).toEqual({ ...observed, model: endpoint.model });
  });
});
