import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { api, createUser, expectError, expectOk, purgeTestData } from "@/server/test/helpers";

const prefix = "zt-draft-viewer-";
const a = `${prefix}a`;
const b = `${prefix}b`;
beforeAll(async () => {
  await purgeTestData(prefix);
  await createUser({ id: a });
  await createUser({ id: b });
});
afterAll(async () => { await purgeTestData(prefix); });

describe("retained character draft account authority", () => {
  it.each([[a, b], [b, a]])("rejects unsaved input from %s under %s before creating a draft", async (original, current) => {
    const before = await prisma.characterDraft.count({ where: { ownerId: { in: [a, b] } } });
    const response = await api("POST", "character-drafts", {
      userId: current, ageGate: true,
      headers: { "x-idream-viewer-scope": `user:${original}` },
      body: { name: "Original private input", age: 28, gender: "female", style: "realistic" },
    });
    expectError(response, 409);
    expect(response.error?.message).toContain("Your account changed");
    expect(await prisma.characterDraft.count({ where: { ownerId: { in: [a, b] } } })).toBe(before);
  });

  it.each([
    ["GET", "character-drafts/current"],
    ["PATCH", `character-drafts/${prefix}draft`],
    ["POST", `character-drafts/${prefix}draft/preview`],
    ["GET", `character-drafts/${prefix}draft/preview`],
    ["POST", `character-drafts/${prefix}draft/preview-anchor`],
    ["POST", `character-drafts/${prefix}draft/submit`],
    ["POST", `character-drafts/${prefix}draft/tags`],
    ["POST", "character-voices/preview"],
  ])("binds %s %s before reading private data or dispatching work", async (method, path) => {
    const jobs = await prisma.generationJob.count({ where: { userId: { in: [a, b] } } });
    const response = await api(method, path, {
      userId: b, ageGate: true, headers: { "x-idream-viewer-scope": `user:${a}` },
      ...(method === "GET" ? {} : { body: {} }),
    });
    expectError(response, 409);
    expect(await prisma.generationJob.count({ where: { userId: { in: [a, b] } } })).toBe(jobs);
  });

  it("does not authenticate with the expected scope and preserves current-account API callers", async () => {
    expectError(await api("POST", "character-drafts", {
      ageGate: true, headers: { "x-idream-viewer-scope": `user:${a}` }, body: {},
    }), 401);
    for (const headers of [{ "x-idream-viewer-scope": `user:${a}` }, undefined]) {
      const response = await api("POST", "character-drafts", {
        userId: a, ageGate: true, headers,
        body: { name: "My own input", age: 28, gender: "female", style: "realistic" },
      });
      expectOk(response);
      expect((await prisma.characterDraft.findUniqueOrThrow({ where: { id: response.data.draft.id } })).ownerId).toBe(a);
    }
  });
});
