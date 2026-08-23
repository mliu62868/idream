import { Prisma } from "@prisma/client";

export function isSerializableWriteConflict(cause: unknown) {
  if (
    cause &&
    typeof cause === "object" &&
    "name" in cause &&
    cause.name === "PrismaClientKnownRequestError" &&
    (("code" in cause &&
      (cause.code === "P2034" ||
        (cause.code === "P2010" && isPostgresSerializationMeta(cause)))) ||
      ("message" in cause &&
        typeof cause.message === "string" &&
        cause.message.includes("Code: `40001`")))
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

function isPostgresSerializationMeta(cause: object) {
  if (!("meta" in cause) || !cause.meta || typeof cause.meta !== "object") {
    return false;
  }
  if ("code" in cause.meta && cause.meta.code === "40001") return true;
  return (
    "message" in cause.meta &&
    typeof cause.meta.message === "string" &&
    cause.meta.message.includes("40001")
  );
}

export function isUniqueConstraintConflict(
  cause: unknown,
): cause is Prisma.PrismaClientKnownRequestError {
  return (
    cause instanceof Prisma.PrismaClientKnownRequestError &&
    cause.code === "P2002"
  );
}
