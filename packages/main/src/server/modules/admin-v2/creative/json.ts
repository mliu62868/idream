// JSON 列上的两个取值收窄。这里没有领域判断，只是避免拆开之后六个文件各抄一份。
export function jsonRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** 空串与非字符串一律丢弃 —— 参考图 id、朝向这类列表里，空串不是一个取值。 */
export function nonEmptyStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}
