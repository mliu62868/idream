import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { createUser } from "./helpers";

describe("server test helpers", () => {
  const userId = `helper-fixture-${randomUUID()}`;

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("marks helper-created users as fixtures even when a caller supplies another email", async () => {
    const user = await createUser({
      id: userId,
      email: `${userId}@custom.invalid`,
    });

    expect(user.dataClass).toBe("fixture");
  });
});
