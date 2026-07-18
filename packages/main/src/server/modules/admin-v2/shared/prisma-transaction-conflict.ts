import { Prisma } from "@prisma/client";

export function isSerializableWriteConflict(cause: unknown) {
  if (
    cause instanceof Prisma.PrismaClientKnownRequestError &&
    cause.code === "P2034"
  ) {
    return true;
  }
  if (
    !cause ||
    typeof cause !== "object" ||
    !("name" in cause) ||
    cause.name !== "DriverAdapterError" ||
    !("cause" in cause) ||
    !cause.cause ||
    typeof cause.cause !== "object" ||
    !("kind" in cause.cause)
  ) {
    return false;
  }
  return cause.cause.kind === "TransactionWriteConflict";
}

export function isUniqueConstraintConflict(
  cause: unknown,
): cause is Prisma.PrismaClientKnownRequestError {
  return (
    cause instanceof Prisma.PrismaClientKnownRequestError &&
    cause.code === "P2002"
  );
}
