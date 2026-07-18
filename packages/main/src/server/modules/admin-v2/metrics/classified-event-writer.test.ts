import { describe, expect, it, vi } from "vitest";
import { createClassifiedAnalyticsEvent } from "./classified-event-writer";

function dbForUser(dataClass: "customer" | "internal" | "fixture" | "audit") {
  const create = vi.fn(async (args: unknown) => args);
  return {
    db: {
      user: {
        findUnique: vi.fn(async () => ({
          id: "actor-1",
          email: dataClass === "fixture" ? "actor@example.test" : "actor@customer.invalid",
          role: "user",
          status: "active",
          deletedAt: null,
          dataClass,
        })),
      },
      analyticsEvent: { create },
    },
    create,
  };
}

describe("createClassifiedAnalyticsEvent", () => {
  it("persists customer actors as customer data", async () => {
    const { db, create } = dbForUser("customer");

    await createClassifiedAnalyticsEvent(db as never, {
      userId: "actor-1",
      name: "character_viewed",
      props: { characterId: "character-1" },
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        dataClass: "customer",
        actor: expect.objectContaining({ isInternal: false, userId: "actor-1" }),
      }),
    });
  });

  it("keeps fixture actors out of customer metrics", async () => {
    const { db, create } = dbForUser("fixture");

    await createClassifiedAnalyticsEvent(db as never, {
      userId: "actor-1",
      name: "feed_item_liked",
      props: { itemId: "character:1" },
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        dataClass: "fixture",
        actor: expect.objectContaining({ isInternal: true, userId: "actor-1" }),
      }),
    });
  });

  it("classifies anonymous traffic as customer and service traffic as operational", async () => {
    const anonymousCreate = vi.fn(async (args: unknown) => args);
    const anonymousDb = {
      user: { findUnique: vi.fn() },
      analyticsEvent: { create: anonymousCreate },
    };
    await createClassifiedAnalyticsEvent(anonymousDb as never, {
      anonymousId: "anon-1",
      name: "page_viewed",
      props: {},
    });
    expect(anonymousCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ dataClass: "customer" }),
    });

    const serviceCreate = vi.fn(async (args: unknown) => args);
    const serviceDb = {
      user: { findUnique: vi.fn() },
      analyticsEvent: { create: serviceCreate },
    };
    await createClassifiedAnalyticsEvent(serviceDb as never, {
      name: "generation_failed",
      props: {},
      sourceService: "main-worker",
    });
    expect(serviceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ dataClass: "operational" }),
    });
  });
});
