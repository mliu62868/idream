import { afterEach, describe, expect, it, vi } from "vitest";
import { PipelineChatModel } from "@/server/providers/chat/pipeline";
import {
  generateCharacterQuickStart,
  mapQuickStartOutput,
  parseQuickStartJson,
  type CharacterQuickStartRuntime,
} from "./character-quick-start";

afterEach(() => vi.useRealTimers());

function runtime(reply: string | Error, overrides: Partial<CharacterQuickStartRuntime> = {}) {
  return {
    available: true,
    stream: vi.fn(async function* (_input: Parameters<CharacterQuickStartRuntime["stream"]>[0]) {
      if (reply instanceof Error) throw reply;
      yield { delta: reply, done: false };
      yield { delta: "", done: true };
    }),
    moderate: vi.fn(async () => ({ status: "passed" })),
    ...overrides,
  } satisfies CharacterQuickStartRuntime;
}

describe("mapQuickStartOutput", () => {
  it("maps model JSON onto existing wizard fields in catalog spelling", () => {
    expect(mapQuickStartOutput({
      name: " Mira ", age: 24, gender: "Female", style: "anime",
      hair: "Short auburn curls", description: "A café illustrator.", firstMessage: "Back again?",
      personality: "tender beneath a guarded exterior", occupation: "illustrator", relationship: "Friend",
      backstory: "not a wizard field",
    })).toEqual({
      name: "Mira", age: 24, gender: "female", style: "anime",
      hair: "Short auburn curls", description: "A café illustrator.", firstMessage: "Back again?",
      personality: "Tender beneath a guarded exterior", occupation: "Illustrator", relationship: "Friend",
    });
  });

  it("drops invalid enumerated fields while retaining a custom occupation", () => {
    expect(mapQuickStartOutput({
      name: "", gender: "nonbinary", style: "watercolor", occupation: "Barista-illustrator",
      personality: 3, relationship: "Soulmate", description: "x".repeat(1_001), eyeColor: "Green",
    })).toEqual({ occupation: "Barista-illustrator", eyeColor: "Green" });
    for (const occupation of ["", " ", "x".repeat(161), 3, null]) {
      expect(mapQuickStartOutput({ occupation })).toEqual({});
    }
    expect(mapQuickStartOutput(["not", "an", "object"])).toEqual({});
    expect(mapQuickStartOutput(null)).toEqual({});
  });

  it("rounds and caps adult ages and ignores a non-numeric age", () => {
    expect(mapQuickStartOutput({ age: 24.6 }).age).toBe(25);
    expect(mapQuickStartOutput({ age: "31" }).age).toBe(31);
    expect(mapQuickStartOutput({ age: 400 }).age).toBe(120);
    expect(mapQuickStartOutput({ age: "mid-twenties" })).toEqual({});
  });

  it("preserves an accurately described occupation outside the suggestions", async () => {
    const deps = runtime('{"name":"Rowan","age":28,"occupation":" Garden teacher "}');
    await expect(generateCharacterQuickStart("A 28-year-old garden teacher", deps)).resolves.toEqual({
      name: "Rowan", age: 28, occupation: "Garden teacher",
    });
    expect(deps.moderate).toHaveBeenNthCalledWith(2, "Rowan\nGarden teacher", "output");
  });

  it("refuses an implied minor rather than raising the age to 18", () => {
    expect(() => mapQuickStartOutput({ name: "Kai", age: 16 })).toThrow(
      expect.objectContaining({ status: 403, message: expect.stringContaining("adults (18+)") }),
    );
    expect(() => mapQuickStartOutput({ age: "17.9" })).toThrow(expect.objectContaining({ status: 403 }));
  });
});

describe("parseQuickStartJson", () => {
  it("reads a fenced or prose-wrapped JSON object and rejects anything else", () => {
    expect(parseQuickStartJson('```json\n{"name":"Mira"}\n```')).toEqual({ name: "Mira" });
    expect(parseQuickStartJson('Here you go: {"name":"Mira"} enjoy')).toEqual({ name: "Mira" });
    expect(parseQuickStartJson("{not json}")).toBeNull();
    expect(parseQuickStartJson("no object")).toBeNull();
  });
});

describe("generateCharacterQuickStart", () => {
  it("finishes a progressing JSON draft beyond the initial wait while bounding model output", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        const encoder = new TextEncoder();
        signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
        for (const [delay, content] of [[200, '{"name":"Mira",'], [400, '"age":28}']] as const) {
          setTimeout(() => {
            if (!signal?.aborted) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
            }
          }, delay);
        }
        setTimeout(() => {
          if (!signal?.aborted) {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        }, 600);
      } }), { headers: { "content-type": "text/event-stream" } });
    });
    const model = new PipelineChatModel({ baseUrl: "http://model.test/v1", model: "local-model", timeoutMs: 250, fetchImpl });
    const deps = runtime("", { stream: model.stream.bind(model) });
    const result = generateCharacterQuickStart("Mira, a 28-year-old librarian", deps).then(
      draft => ({ draft }), error => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(await result).toEqual({ draft: { name: "Mira", age: 28 } });
    const request = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(request.max_tokens).toBeGreaterThan(0);
    expect(request.max_tokens).toBeLessThanOrEqual(2_048);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses a length-limited model reply even when its JSON can be parsed", async () => {
    const deps = runtime("", {
      stream: vi.fn(async function* () {
        yield { delta: '{"name":"Mira","age":28}', done: false };
        yield { delta: "", done: true, finishReason: "length" };
      }),
    });
    await expect(generateCharacterQuickStart("Mira, a 28-year-old librarian", deps)).rejects.toMatchObject({
      status: 503, details: { retryable: true },
    });
    expect(deps.moderate).toHaveBeenCalledTimes(1);
  });

  it("returns the mapped draft and moderates both the brief and the generated text", async () => {
    const deps = runtime('{"name":"Mira","age":24,"occupation":"Illustrator"}');
    await expect(generateCharacterQuickStart("A café illustrator", deps)).resolves.toEqual({
      name: "Mira", age: 24, occupation: "Illustrator",
    });
    expect(deps.moderate).toHaveBeenNthCalledWith(1, "A café illustrator", "input");
    expect(deps.moderate).toHaveBeenNthCalledWith(2, "Mira\nIllustrator", "output");
    expect(vi.mocked(deps.stream).mock.calls[0]![0].messages.at(-1)).toEqual({ role: "user", content: "A café illustrator" });
  });

  it("refuses a blocked brief before asking the model", async () => {
    const deps = runtime("{}", {
      moderate: vi.fn(async () => ({ status: "blocked", policyCode: "age_under_18" })),
    });
    await expect(generateCharacterQuickStart("an underage student", deps)).rejects.toMatchObject({
      status: 403, details: { policyCode: "age_under_18" },
    });
    expect(deps.stream).not.toHaveBeenCalled();
  });

  it("reports an unconfigured model as unavailable without calling it", async () => {
    const deps = runtime("{}", { available: false });
    await expect(generateCharacterQuickStart("A café illustrator", deps)).rejects.toMatchObject({ status: 503 });
    expect(deps.stream).not.toHaveBeenCalled();
  });

  it("maps model failures and unusable output to a retryable error", async () => {
    for (const reply of [new Error("aborted"), "Sure! Here is a character.", '{"gender":"robot"}']) {
      await expect(generateCharacterQuickStart("A café illustrator", runtime(reply))).rejects.toMatchObject({
        status: 503, details: { retryable: true },
      });
    }
  });
});
