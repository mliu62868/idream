import { isRecord } from "@/server/lib/request-json";

// SPEC: 读 JSON 列 / 未知输入的取值原语 —— 拿不到想要的形状就降级成空值，不抛。
//
// INTENT: 这些原语原本是 service.ts 的私有函数。业务动作被拆成独立模块之后，模块要么
// 反向 import service（ourdream 明令禁止，见 architecture-boundaries.test.ts 的台账），
// 要么各抄一份然后悄悄漂移 —— 所以它们必须先有自己的家。这里只搬家，不改语义。

export function jsonRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function jsonNonBlankString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

export function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function stringFromRecord(value: Record<string, unknown>, key: string) {
  const child = value[key];
  return typeof child === "string" && child.trim() ? child.trim() : undefined;
}

export function numberFromRecord(value: Record<string, unknown>, key: string) {
  const child = value[key];
  return typeof child === "number" && Number.isFinite(child) ? child : undefined;
}

export function booleanFromRecord(
  value: Record<string, unknown>,
  key: string,
  fallback: boolean,
) {
  const child = value[key];
  return typeof child === "boolean" ? child : fallback;
}

export function pruneUndefined(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}
