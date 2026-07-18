import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { api, createUser } from "@/server/test/helpers";

describe("admin billing customer data boundary", () => {
  const token = `billing-customer-${randomUUID()}`;
  const actorId = `${token}-admin`;
  const customerId = `${token}-customer`;
  const fixtureId = `${token}-fixture`;
  const internalId = `${token}-internal`;
  const planId = `${token}-plan`;

  beforeAll(async () => {
    await createUser({ id: actorId, role: "admin", dataClass: "internal" });
    await createUser({ id: customerId, dataClass: "customer" });
    await createUser({ id: fixtureId, dataClass: "fixture" });
    await createUser({ id: internalId, dataClass: "internal" });
    await prisma.plan.create({
      data: {
        id: planId,
        slug: token,
        name: token,
        billingPeriod: "monthly",
        priceCents: 100,
        features: {},
      },
    });
    await prisma.dreamcoinLedger.createMany({
      data: [
        { id: `${token}-ledger-customer`, userId: customerId, delta: 10, balanceAfter: 10, reason: "signup_bonus" },
        { id: `${token}-ledger-fixture`, userId: fixtureId, delta: 20, balanceAfter: 20, reason: "signup_bonus" },
        { id: `${token}-ledger-internal`, userId: internalId, delta: 30, balanceAfter: 30, reason: "admin_adjust" },
      ],
    });
    await prisma.subscription.createMany({
      data: [
        {
          id: `${token}-subscription-customer`,
          userId: customerId,
          planId,
          provider: "mock",
          providerSubscriptionId: `${token}-provider-customer`,
          status: "active",
        },
        {
          id: `${token}-subscription-fixture`,
          userId: fixtureId,
          planId,
          provider: "mock",
          providerSubscriptionId: `${token}-provider-fixture`,
          status: "active",
        },
        {
          id: `${token}-subscription-internal`,
          userId: internalId,
          planId,
          provider: "mock",
          providerSubscriptionId: `${token}-provider-internal`,
          status: "active",
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.subscription.deleteMany({ where: { id: { startsWith: token } } });
    await prisma.dreamcoinLedger.deleteMany({ where: { id: { startsWith: token } } });
    await prisma.plan.deleteMany({ where: { id: planId } });
    await prisma.user.deleteMany({
      where: { id: { in: [actorId, customerId, fixtureId, internalId] } },
    });
    await prisma.$disconnect();
  });

  it("lists only customer ledger entries and declares the customer scope", async () => {
    const result = await api("GET", "admin/billing/ledger", {
      userId: actorId,
      role: "admin",
      query: { search: token },
    });

    expect(result.status, JSON.stringify(result.json)).toBe(200);
    expect(result.data.dataScope).toMatchObject({
      kind: "customer",
      includedDataClasses: ["customer"],
    });
    expect(result.data.items).toEqual([
      expect.objectContaining({
        id: `${token}-ledger-customer`,
        userId: customerId,
      }),
    ]);
  });

  it("lists only customer subscriptions and declares the customer scope", async () => {
    const result = await api("GET", "admin/billing/subscriptions", {
      userId: actorId,
      role: "admin",
      query: { search: token },
    });

    expect(result.status, JSON.stringify(result.json)).toBe(200);
    expect(result.data.dataScope).toMatchObject({
      kind: "customer",
      includedDataClasses: ["customer"],
    });
    expect(result.data.items).toEqual([
      expect.objectContaining({
        id: `${token}-subscription-customer`,
        userId: customerId,
      }),
    ]);
  });
});
