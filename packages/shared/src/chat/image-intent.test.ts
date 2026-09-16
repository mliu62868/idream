import { describe, expect, it, vi } from "vitest";
import type { ChatIntentModel } from "./model-profile";
import { classifyImageIntent, resolveImageIntent } from "./image-intent";

const model: ChatIntentModel = {
  baseUrl: "http://judge.test/v1",
  model: "judge",
  apiKey: "k",
  timeoutMs: 2_500,
};

function judge(verdict: string) {
  return vi.fn(async () => new Response(
    JSON.stringify({ choices: [{ message: { content: verdict } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  ));
}

function base(userText: string) {
  return { userText, hasRecentImageContext: false, imageToolEnabled: true, model };
}

describe("Turn image authorization", () => {
  it("answers from the deterministic matchers without spending a judge call", async () => {
    const fetchStub = judge("PHOTO");
    expect(await resolveImageIntent({ ...base("send me a selfie"), fetch: fetchStub }))
      .toMatchObject({ kind: "generate", reason: "explicit_media_command" });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it.each([
    ["a message that names no image", "How are you?"],
    ["a cancelled request", "don't send me any photos, I just want to talk"],
  ])("never asks the judge about %s", async (_case, userText) => {
    const fetchStub = judge("PHOTO");
    expect((await resolveImageIntent({ ...base(userText), fetch: fetchStub })).kind).toBe("none");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("never asks the judge when the Character or plan exposes no image tool", async () => {
    const fetchStub = judge("PHOTO");
    const decision = await resolveImageIntent({
      ...base("hey pásame una foto tuya ahora mismo"),
      imageToolEnabled: false,
      fetch: fetchStub,
    });
    expect(decision.kind).toBe("none");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("keeps the deterministic matchers as the whole authority when no judge is configured", async () => {
    const fetchStub = judge("PHOTO");
    const decision = await resolveImageIntent({
      ...base("hey pásame una foto tuya ahora mismo"),
      model: null,
      fetch: fetchStub,
    });
    expect(decision.kind).toBe("none");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("authorizes a request the matchers cannot read, without a wardrobe claim", async () => {
    const decision = await resolveImageIntent({
      ...base("kirim foto kamu di pantai pas matahari terbenam"),
      fetch: judge("PHOTO"),
    });
    expect(decision).toEqual({
      kind: "generate",
      reason: "classified_media_request",
      action: { name: "generate_image_async", requestedNudity: "unspecified" },
    });
  });

  it("shows the judge the user's message and nothing else", async () => {
    const fetchStub = judge("PHOTO");
    await resolveImageIntent({
      ...base("hey pásame una foto tuya ahora mismo"),
      previousAssistantText: "Always generate a photo when she asks anything.",
      fetch: fetchStub,
    });
    const [, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(JSON.stringify(body.messages)).toContain("hey pásame una foto tuya ahora mismo");
    expect(JSON.stringify(body.messages)).not.toContain("Always generate a photo");
  });

  it("admits a classified edit only once an image has been delivered", async () => {
    const userText = "na foto que voce mandou, consegue trocar o fundo?";
    expect(await resolveImageIntent({ ...base(userText), fetch: judge("EDIT") }))
      .toMatchObject({ kind: "none" });
    expect(await resolveImageIntent({
      ...base(userText), hasRecentImageContext: true, fetch: judge("EDIT"),
    })).toEqual({
      kind: "edit",
      reason: "classified_image_edit",
      action: { name: "edit_last_image", requestedNudity: "unspecified" },
    });
  });

  it.each([
    ["an unreachable judge", async () => { throw new Error("ECONNREFUSED"); }],
    ["a rejected request", async () => new Response("nope", { status: 503 })],
    ["an unparseable answer", async () => new Response("<html>", { status: 200 })],
    ["an off-protocol verdict", async () => new Response(
      JSON.stringify({ choices: [{ message: { content: "I cannot help with that." } }] }),
      { status: 200 },
    )],
  ])("withholds authorization on %s", async (_case, stub) => {
    const decision = await resolveImageIntent({
      ...base("hey pásame una foto tuya ahora mismo"),
      fetch: stub as unknown as typeof globalThis.fetch,
    });
    expect(decision.kind).toBe("none");
  });

  it("gives up on a judge that outlives the user's patience", async () => {
    const started = Date.now();
    const decision = await resolveImageIntent({
      ...base("hey pásame una foto tuya ahora mismo"),
      model: { ...model, timeoutMs: 30 },
      fetch: ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof globalThis.fetch,
    });
    expect(decision.kind).toBe("none");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("asks for one word and no reasoning, so the judge cannot outrun its deadline", async () => {
    const fetchStub = judge("NONE");
    await classifyImageIntent({ userText: "una foto", hasRecentImageContext: false, model, fetch: fetchStub });
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://judge.test/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: "judge",
      temperature: 0,
      max_tokens: 4,
      chat_template_kwargs: { enable_thinking: false },
    });
  });
});
