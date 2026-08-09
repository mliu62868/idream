import type { Prisma } from "@prisma/client";

export function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

// SPEC: 读 JSON 列时「不是我要的形状」一律降级成空值，不抛。
// INTENT: JSON 列没有 schema，历史行什么都可能是，投影代码要的是「读不到就当没有」。
// 这三行此前在每个读 JSON 列的文件里各写一份，本来就重了五遍；workspace.ts 拆开后
// 六个子域文件都要用，再复制六份只会让它们各自悄悄漂移。调用点仍写 record/strings/text
// （`import { jsonRecord as record }`），因为那是这些表达式在语句里的读法。
export function jsonRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function jsonStrings(value: Prisma.JsonValue | null | undefined): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function jsonText(value: unknown): string {
  return typeof value === "string" ? value : "";
}
