// P0-1 acceptance: the chat_service DB boundary has teeth (design §2, PLAN P0-1).
// Positive: chat Prisma (as chat_service) reads the 4 views + CRUD chat.*.
// Negative: raw writes/reads of public.* and writes to the views are DB-rejected.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createChatPrisma } from "../src/db.js";

const prisma = createChatPrisma();
const pool = new Pool({ connectionString: process.env.CHAT_DATABASE_URL });

afterAll(async () => {
  await prisma.$disconnect();
  await pool.end();
});

describe("chat boundary (chat_service role)", () => {
  it("can read all 4 read-only views", async () => {
    await expect(prisma.chatUserView.findMany({ take: 1 })).resolves.toBeDefined();
    await expect(prisma.chatCharacterView.findMany({ take: 1 })).resolves.toBeDefined();
    await expect(prisma.chatEntitlementView.findMany({ take: 1 })).resolves.toBeDefined();
    await expect(prisma.chatUserEligibilityView.findMany({ take: 1 })).resolves.toBeDefined();
  });

  it("can CRUD chat.* authority tables", async () => {
    const id = "test_sess_boundary";
    await prisma.chatSession.create({
      data: { id, userId: "u_test", characterId: "c_test" },
    });
    const found = await prisma.chatSession.findUnique({ where: { id } });
    expect(found?.userId).toBe("u_test");
    await prisma.chatSession.delete({ where: { id } });
  });

  // Negative tests use raw pg so we bypass Prisma's view/model surface and hit the
  // DB grants directly — exactly what an attacker / a bug would attempt.
  // Rejection can be a grant denial ("permission denied") or, for the views, a
  // structural one ("cannot insert into view" — no auto-update rule). Both prove
  // the write never lands.
  async function mustReject(sql: string) {
    await expect(pool.query(sql)).rejects.toThrow(
      /permission denied|cannot insert into view|cannot update view|cannot.*view/i,
    );
  }

  it("CANNOT write core base tables", async () => {
    await mustReject("INSERT INTO public.users (id, email) VALUES ('x', 'x@x')");
    await mustReject("UPDATE public.users SET status = 'suspended'");
  });

  it("CANNOT read core base tables (only the views)", async () => {
    await mustReject("SELECT * FROM public.users LIMIT 1");
    await mustReject("SELECT * FROM public.entitlements LIMIT 1");
  });

  it("CANNOT write the read-only views", async () => {
    await mustReject("INSERT INTO core.chat_user_view (user_id) VALUES ('x')");
    await mustReject("UPDATE billing.chat_entitlement_view SET model_tier = 'deluxe'");
  });
});
