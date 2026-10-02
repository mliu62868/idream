import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { api, createUser, expectError, expectOk, purgeTestData } from "@/server/test/helpers";

const prefix = "zt-draft-revision-";
const userId = `${prefix}owner`;
beforeAll(async () => { await purgeTestData(prefix); await createUser({ id: userId }); });
afterAll(() => purgeTestData(prefix));
async function draft(label: string) {
  return prisma.characterDraft.create({ data: {
    id: `${prefix}${label}`, ownerId: userId, name: "Original", gender: "female", style: "realistic",
    appearance: {}, hair: {}, body: {}, tags: [], advancedDetails: { age: 25, description: "Original persona" },
    updatedAt: new Date("2050-01-01T00:00:00.000Z"),
  } });
}

describe("character draft revision authority", () => {
  it.each(["PATCH", "tags"])("refuses an unversioned %s from an older page without overwriting newer saved inputs", async (action) => {
    const current = await draft(`legacy-${action}`);
    await prisma.characterDraft.update({ where: { id: current.id }, data: { name: "Newer saved name", tags: ["newer-tag"] } });
    const response = action === "PATCH"
      ? await api("PATCH", `character-drafts/${current.id}`, { userId, ageGate: true, body: { name: "Stale name", tags: ["stale-tag"] } })
      : await api("POST", `character-drafts/${current.id}/tags`, { userId, ageGate: true, body: { tags: ["stale-tag"] } });
    expect(await prisma.characterDraft.findUniqueOrThrow({ where: { id: current.id } })).toMatchObject({ name: "Newer saved name", tags: ["newer-tag"] });
    expectError(response, 409, "conflict");
    expect(response.error?.message).toContain("latest saved draft");
  });

  it("allows only one write from a shared snapshot and lets the losing tab resume the latest revision", async () => {
    const current = await draft("two-tabs");
    const expectedUpdatedAt = current.updatedAt.toISOString();
    const writes = await Promise.all(["First tab", "Second tab"].map(name => api("PATCH", `character-drafts/${current.id}`, {
      userId, ageGate: true, body: { expectedUpdatedAt, name, advancedDetails: { description: `${name} persona` } },
    })));
    expect(writes.map(result => result.status).sort()).toEqual([200, 409]);
    const winner = writes.find(result => result.status === 200)!;
    const persisted = await prisma.characterDraft.findUniqueOrThrow({ where: { id: current.id } });
    expect(persisted.name).toBe(winner.data.draft.name);
    expect(persisted.updatedAt.getTime()).toBeGreaterThan(current.updatedAt.getTime());
    const resumed = await api("GET", "character-drafts/current", { userId, ageGate: true });
    expectOk(resumed);
    expect(resumed.data.draft).toMatchObject({ id: current.id, name: persisted.name, updatedAt: persisted.updatedAt.toISOString() });
    const saved = await api("PATCH", `character-drafts/${current.id}`, { userId, ageGate: true, body: { expectedUpdatedAt: resumed.data.draft.updatedAt, name: "Resolved in latest draft" } });
    expectOk(saved);
    expect(saved.data.draft.name).toBe("Resolved in latest draft");
    expectError(await api("POST", `character-drafts/${current.id}/tags`, { userId, ageGate: true, body: { expectedUpdatedAt, tags: ["stale"] } }), 409, "conflict");
    expect((await prisma.characterDraft.findUniqueOrThrow({ where: { id: current.id } })).tags).toEqual([]);
  });

  it("returns the committed revision after removing a missing preview anchor during resume", async () => {
    const current = await draft("repaired-resume");
    await prisma.characterDraft.update({ where: { id: current.id }, data: { previewJobId: `${prefix}missing-preview`, updatedAt: new Date("2051-01-01T00:00:00.000Z") } });
    const resumed = await api("GET", "character-drafts/current", { userId, ageGate: true });
    expectOk(resumed);
    const persisted = await prisma.characterDraft.findUniqueOrThrow({ where: { id: current.id } });
    expect(resumed.data.draft).toMatchObject({ id: current.id, previewJobId: null, updatedAt: persisted.updatedAt.toISOString() });
    expectOk(await api("PATCH", `character-drafts/${current.id}`, { userId, ageGate: true, body: { expectedUpdatedAt: resumed.data.draft.updatedAt, name: "Saved after resume" } }));
  });
});
