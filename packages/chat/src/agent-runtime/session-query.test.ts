import { Context } from "@deepseek-ai/cordis";
import { Session, SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import { MessageId, freezeMessage } from "@deepseek-ai/dsh-llm";
import { describe, expect, it } from "vitest";
import { CompanionSessionQuery } from "./session-query";

describe("attempt-scoped recall history", () => {
  it("reads the immutable imported prefix plus append feed and rejects disposed or foreign sessions", async () => {
    const ctx = new Context();
    await ctx.plugin(SessionStore);
    await ctx.plugin(CompanionSessionQuery);
    const query = ctx.sessionQuery;
    try {
      const seedSession = Session.create(SessionId("seed"));
      const event = seedSession.append("user/message", freezeMessage({
        id: MessageId("past-user"), role: "user", source: { kind: "user" },
        content: [{ type: "text", text: "I named the boat Cedar Finch." }],
      }), { surfaceOp: "append" });
      const end = seedSession.append("session/end-seed", {});
      ctx.sessionQuery.registerSeed("attempt", [event, end]);
      await expect(ctx.sessionQuery.readSession("attempt")).rejects.toThrow("unavailable");
      const session = ctx.sessions.create(SessionId("attempt"), { seed: [event, end] });
      const first = await ctx.sessionQuery.readSession("attempt");
      const next = session.append("user/message", freezeMessage({
        id: MessageId("current-user"), role: "user", source: { kind: "user" },
        content: [{ type: "text", text: "What did I call it?" }],
      }), { surfaceOp: "append" });
      expect(first.events).toEqual([event, end]);
      expect((await ctx.sessionQuery.readSession("attempt")).events).toEqual([event, end, next]);
      ctx.sessions.create(SessionId("foreign"));
      await expect(ctx.sessionQuery.readSession("foreign")).rejects.toThrow("unavailable");
      await ctx.fiber.dispose();
      await expect(query.readSession("attempt")).rejects.toThrow("unavailable");
    } finally { await ctx.fiber.dispose(); }
  });
});
