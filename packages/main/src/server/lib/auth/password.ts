import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const passwordPrefix = "scrypt";

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${passwordPrefix}$${salt}$${hash}`;
}

// INVARIANT: only the exact format written above verifies. A malformed stored
// value is a rejected credential, never an exception on the login path.
export function verifyPassword(password: string, stored: string | null | undefined) {
  const match = stored ? /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(stored) : null;
  if (!match) return false;
  const expected = Buffer.from(match[2], "hex");
  return timingSafeEqual(expected, scryptSync(password, match[1], expected.length));
}
