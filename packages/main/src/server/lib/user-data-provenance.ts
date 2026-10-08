import type { Prisma } from "@prisma/client";

export type UserDataClass = "customer" | "internal" | "fixture" | "audit";

export function isReservedFixtureEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  const domain = normalized.split("@").at(-1) ?? "";
  return (
    domain === "test.local" ||
    domain.endsWith(".test") ||
    domain === "example.com"
  );
}

// SPEC: query form of isReservedFixtureEmail; keep the two in sync.
// INTENT: audit scripts insert accounts directly as dataClass=customer (Help Desk needs
// it), bypassing signup's classification. Public surfaces use this so a reserved test
// address never counts as a real customer, whatever the stored class says.
export const reservedFixtureEmailWhere = {
  OR: [
    { email: { endsWith: "@test.local", mode: "insensitive" } },
    { email: { endsWith: ".test", mode: "insensitive" } },
    { email: { endsWith: "@example.com", mode: "insensitive" } },
  ],
} as const satisfies Prisma.UserWhereInput;

export function isReservedInternalEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  const domain = normalized.split("@").at(-1) ?? "";
  return (
    domain === "idream.local" ||
    domain.endsWith(".idream.local") ||
    domain === "idream.internal" ||
    domain.endsWith(".idream.internal")
  );
}

export function registeredUserDataClass(
  email: string,
): "customer" | "internal" | "fixture" {
  if (isReservedFixtureEmail(email)) return "fixture";
  if (isReservedInternalEmail(email)) return "internal";
  return "customer";
}
