import { z } from "zod";
import { Errors } from "@/server/lib/errors";
import { canonicalSha256 } from "./canonical-json";

const cursorSchema = z.object({
  version: z.literal(1),
  scope: z.string().min(1).max(120),
  queryHash: z.string().length(64),
  keys: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).min(1).max(6),
}).strict();

export function encodeAdminListCursor(scope: string, queryIdentity: unknown, keys: readonly (string | number | boolean | null)[]) {
  return Buffer.from(JSON.stringify({
    version: 1,
    scope,
    queryHash: canonicalSha256(queryIdentity),
    keys,
  }), "utf8").toString("base64url");
}

export function decodeAdminListCursor(value: string, scope: string, queryIdentity: unknown) {
  try {
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (cursor.scope !== scope || cursor.queryHash !== canonicalSha256(queryIdentity)) {
      throw new Error("cursor query mismatch");
    }
    return cursor.keys;
  } catch {
    throw Errors.badRequest(`${scope} cursor is invalid for the selected query`);
  }
}

export function parseIsoCursorKey(value: unknown, scope: string) {
  const date = new Date(z.string().min(1).parse(value));
  if (Number.isNaN(date.getTime())) throw Errors.badRequest(`${scope} cursor timestamp is invalid`);
  return date;
}
