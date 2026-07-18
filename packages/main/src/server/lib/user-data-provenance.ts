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
