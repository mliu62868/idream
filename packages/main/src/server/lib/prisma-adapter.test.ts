import { describe, expect, it } from "vitest";
import { prismaPgSchema, prismaPgSearchPath } from "./prisma-adapter";

describe("Prisma Postgres adapter schema authority", () => {
  it("keeps the runtime in the same isolated schema selected by Prisma CLI", () => {
    expect(
      prismaPgSchema(
        "postgresql://postgres:postgres@localhost:5433/idream_test?schema=codex_media_arch",
      ),
    ).toBe("codex_media_arch");
  });

  it("uses the database default when no schema is pinned", () => {
    expect(
      prismaPgSchema("postgresql://postgres:postgres@localhost:5433/idream"),
    ).toBeUndefined();
  });

  it("pins raw SQL to the same safe schema", () => {
    expect(prismaPgSearchPath("codex_media_arch_20260801")).toBe(
      "-c search_path=codex_media_arch_20260801",
    );
    expect(() => prismaPgSearchPath("public, attacker")).toThrow(
      "not a safe Postgres identifier",
    );
  });
});
