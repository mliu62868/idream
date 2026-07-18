import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  isSerializableWriteConflict,
  isUniqueConstraintConflict,
} from "./prisma-transaction-conflict";

describe("Prisma transaction conflict classification", () => {
  it("recognizes Prisma and adapter-pg Serializable write conflicts", () => {
    const prismaConflict = new Prisma.PrismaClientKnownRequestError(
      "Transaction failed due to a write conflict",
      {
        clientVersion: Prisma.prismaVersion.client,
        code: "P2034",
      },
    );
    const adapterConflict = Object.assign(
      new Error("Transaction write conflict"),
      {
        name: "DriverAdapterError",
        cause: { kind: "TransactionWriteConflict" },
      },
    );

    expect(isSerializableWriteConflict(prismaConflict)).toBe(true);
    expect(isSerializableWriteConflict(adapterConflict)).toBe(true);
  });

  it("keeps unique and unrelated failures distinct", () => {
    const uniqueConflict = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      {
        clientVersion: Prisma.prismaVersion.client,
        code: "P2002",
      },
    );
    const unrelatedAdapterError = Object.assign(new Error("Connection lost"), {
      name: "DriverAdapterError",
      cause: { kind: "ConnectionClosed" },
    });

    expect(isUniqueConstraintConflict(uniqueConflict)).toBe(true);
    expect(isSerializableWriteConflict(uniqueConflict)).toBe(false);
    expect(isSerializableWriteConflict(unrelatedAdapterError)).toBe(false);
    expect(isSerializableWriteConflict(new Error("P2034"))).toBe(false);
  });
});
