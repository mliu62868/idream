import { describe, expect, it, vi } from "vitest";
import {
  generateCharacterQuickStart,
  mapQuickStartOutput,
  parseQuickStartJson,
  type CharacterQuickStartRuntime,
} from "./character-quick-start";

function runtime(reply: string | Error, overrides: Partial<CharacterQuickStartRuntime> = {}) {
  return {
    available: true,
    stream: vi.fn(async function* () {
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

  it("drops values outside the catalogs and malformed fields instead of failing", () => {
    expect(mapQuickStartOutput({
      name: "", gender: "nonbinary", style: "watercolor", occupation: "Barista-illustrator",
      personality: 3, relationship: "Soulmate", description: "x".repeat(1_001), eyeColor: "Green",
    })).toEqual({ eyeColor: "Green" });
    expect(mapQuickStartOutput(["not", "an", "object"])).toEqual({});
    expect(mapQuickStartOutput(null)).toEqual({});
  });

  it("rounds and caps adult ages and ignores a non-numeric age", () => {
    expect(mapQuickStartOutput({ age: 24.6 }).age).toBe(25);
    expect(mapQuickStartOutput({ age: "31" }).age).toBe(31);
    expect(mapQuickStartOutput({ age: 400 }).age).toBe(120);
    expect(mapQuickStartOutput({ age: "mid-twenties" })).toEqual({});
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
