import { Errors } from "@/server/lib/errors";

export function requireMatchingProjectVersion(request: Request, entityVersion: number) {
  const value = request.headers.get("if-match")?.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  if (!value || !/^\d+$/.test(value)) {
    throw Errors.badRequest("If-Match must contain the Character Project version");
  }
  const headerVersion = Number(value);
  if (headerVersion !== entityVersion) {
    throw Errors.badRequest("If-Match and entityVersion must identify the same Project revision");
  }
  return headerVersion;
}
