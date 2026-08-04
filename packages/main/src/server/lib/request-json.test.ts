import { describe, expect, it } from "vitest";
import {
  bodyText,
  isRecord,
  jsonBody,
  parseJsonText,
  toInputJson,
} from "./request-json";

describe("request JSON primitives", () => {
  it.each(["GET", "DELETE"])("does not consume a %s request body", async (method) => {
    const request = new Request("http://localhost/test", { method });

    await expect(bodyText(request)).resolves.toBe("");
    await expect(jsonBody(request)).resolves.toEqual({});
  });

  it("reads and parses mutation request bodies", async () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      body: JSON.stringify({ enabled: true }),
    });

    await expect(jsonBody(request)).resolves.toEqual({ enabled: true });
  });

  it("parses an empty body as an empty object and rejects malformed JSON", () => {
    expect(parseJsonText("")).toEqual({});
    expect(() => parseJsonText("{")).toThrow(SyntaxError);
  });

  it("recognizes records without accepting arrays or null", () => {
    expect(isRecord({ key: "value" })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });

  it("keeps Prisma input JSON as the same runtime value", () => {
    const value = { nested: [1, true, null] };

    expect(toInputJson(value)).toBe(value);
  });
});
