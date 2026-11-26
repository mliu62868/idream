// Small pure helpers shared by the Turn Ledger modules.
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";

export const BLOCKED_NOTICE = "I can’t help with that request.";
export const ACTIVE_ASSISTANT_STATES = ["pending", "generating"];

export function attachmentCost(metadata: Prisma.JsonValue): number | null {
  const value = jsonRecord(metadata).costDreamcoins;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function streamUrl(assistantMessageId: string, attempt: number) {
  return `/api/v1/messages/${encodeURIComponent(assistantMessageId)}/stream?attempt=${attempt}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function jsonRecord(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> {
  return isRecord(value) ? value as Record<string, Prisma.JsonValue> : {};
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
  );
}

export function firstMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return optionalText((value as Record<string, unknown>).firstMessage, 20_000);
}

export function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw Errors.badRequest(`${field} is required`);
  const text = value.trim();
  if (text.length > max) throw Errors.badRequest(`${field} exceeds ${max} characters`);
  return text;
}

export function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().slice(0, max);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function fail(message: string): never {
  throw new Error(message);
}

export function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
