import { beforeEach, describe, expect, it, vi } from "vitest";
import { contentTagQuerySchema } from "@idream/shared/admin";
import { listAdminTags } from "./tags";

const db = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/server/lib/db", () => ({ prisma: { tag: { findMany: db.findMany } } }));
vi.mock("../characters/creation", () => ({ tagSlug: vi.fn() }));
vi.mock("./audit", () => ({ writeContentAudit: vi.fn() }));

const vocabulary = Array.from({ length: 501 }, (_, index) => ({
  id: `tag-${String(index).padStart(3, "0")}`,
  slug: `tag-${String(index).padStart(3, "0")}`,
  label: `Tag ${index}`,
  category: index === 500 ? "last-category" : "common",
  isSensitive: false,
  isMutedByDefault: false,
  _count: { characters: index },
}));

describe("admin complete tag vocabulary", () => {
  beforeEach(() => {
    // Model Prisma's result limit so the test exercises the real query contract
    // and service together, without a PostgreSQL connection.
    db.findMany.mockImplementation(async ({ take }: { take?: number }) =>
      vocabulary.slice(0, take),
    );
  });

  it("returns the last tag after both former 200 and 500 row cutoffs", async () => {
    const result = await listAdminTags(contentTagQuerySchema.parse({}));

    expect(result.items).toHaveLength(501);
    expect(result.items.at(-1)).toMatchObject({
      id: "tag-500",
      category: "last-category",
      characterCount: 500,
    });
  });
});
