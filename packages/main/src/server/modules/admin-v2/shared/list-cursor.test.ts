import { describe, expect, it } from "vitest";
import {
  type AdminKeysetKey,
  decodeAdminListCursor,
  encodeAdminListCursor,
  paginateAdminKeyset,
  parseIsoCursorKey,
} from "./list-cursor";

describe("Admin list cursor", () => {
  it("round trips compound keys only for the exact query identity", () => {
    const cursor = encodeAdminListCursor("assets", { search: "portrait", status: "approved" }, [
      "2026-07-11T12:00:00.000Z",
      "asset-1",
    ]);
    expect(decodeAdminListCursor(cursor, "assets", { search: "portrait", status: "approved" })).toEqual([
      "2026-07-11T12:00:00.000Z",
      "asset-1",
    ]);
    expect(() => decodeAdminListCursor(cursor, "assets", { search: "different", status: "approved" })).toThrow(/invalid/);
    expect(() => decodeAdminListCursor(cursor, "placements", { search: "portrait", status: "approved" })).toThrow(/invalid/);
  });

  it("rejects malformed encodings and invalid timestamp keys", () => {
    expect(() => decodeAdminListCursor("not-a-cursor", "assets", {})).toThrow(/invalid/);
    expect(() => parseIsoCursorKey("not-a-date", "assets")).toThrow(/timestamp/);
  });
});

// 用一张内存表模拟 Prisma：只需要认得分页器实际发出的那一种 where 形状
// （顶层 OR + 每个子句是 { 字段: 标量 } 与 { 字段: { lt|gt: 标量 } } 的组合）。
interface Row {
  readonly createdAt: Date;
  readonly id: string;
}

const KEYS: readonly AdminKeysetKey<Row>[] = [
  { field: "createdAt", direction: "desc", type: "datetime", value: (row) => row.createdAt },
  { field: "id", direction: "desc", value: (row) => row.id },
];

const TABLE: readonly Row[] = Array.from({ length: 7 }, (_, index) => ({
  createdAt: new Date(Date.UTC(2026, 0, 1 + index)),
  id: `row-${index}`,
}));

function scalar(value: unknown) {
  return value instanceof Date ? value.getTime() : String(value);
}

function field(row: Row, name: string) {
  return scalar(row[name as keyof Row]);
}

function matches(row: Row, clause: Record<string, unknown>) {
  return Object.entries(clause).every(([name, condition]) => {
    const left = field(row, name);
    if (condition instanceof Date || typeof condition === "string") return left === scalar(condition);
    const [operator, operand] = Object.entries(condition as Record<string, unknown>)[0]!;
    const right = scalar(operand);
    return operator === "lt" ? left < right : left > right;
  });
}

function query(paging: {
  cursorWhere: readonly Record<string, unknown>[];
  orderBy: Record<string, "asc" | "desc">[];
  take: number;
}) {
  const filtered = TABLE.filter((row) =>
    paging.cursorWhere.every((predicate) =>
      (predicate.OR as Record<string, unknown>[]).some((clause) => matches(row, clause)),
    ),
  );
  const sorted = [...filtered].sort((left, right) => {
    for (const term of paging.orderBy) {
      const [name, direction] = Object.entries(term)[0]!;
      const a = field(left, name);
      const b = field(right, name);
      if (a !== b) return (a < b ? -1 : 1) * (direction === "asc" ? 1 : -1);
    }
    return 0;
  });
  return Promise.resolve(sorted.slice(0, paging.take));
}

function page(cursor?: string, before?: string) {
  return paginateAdminKeyset({
    scope: "fixture",
    queryIdentity: { status: "open" },
    cursor,
    before,
    limit: 3,
    keys: KEYS,
    fetch: query,
    count: () => Promise.resolve(TABLE.length),
  });
}

describe("paginateAdminKeyset", () => {
  it("walks forward and back to the same rows through the returned cursors", async () => {
    const first = await page();
    expect(first.items.map((row) => row.id)).toEqual(["row-6", "row-5", "row-4"]);
    expect(first.pageInfo).toMatchObject({ hasNextPage: true, hasPreviousPage: false, startCursor: null, totalCount: 7 });

    const second = await page(first.pageInfo.endCursor!);
    expect(second.items.map((row) => row.id)).toEqual(["row-3", "row-2", "row-1"]);
    expect(second.pageInfo).toMatchObject({ hasNextPage: true, hasPreviousPage: true });

    const third = await page(second.pageInfo.endCursor!);
    expect(third.items.map((row) => row.id)).toEqual(["row-0"]);
    expect(third.pageInfo).toMatchObject({ hasNextPage: false, endCursor: null, hasPreviousPage: true });

    // 反向翻页必须回到同一页、同一顺序，而不是把结果倒着吐出来。
    const backToSecond = await page(undefined, third.pageInfo.startCursor!);
    expect(backToSecond.items.map((row) => row.id)).toEqual(second.items.map((row) => row.id));
    expect(backToSecond.pageInfo).toMatchObject({ hasNextPage: true, hasPreviousPage: true });

    const backToFirst = await page(undefined, backToSecond.pageInfo.startCursor!);
    expect(backToFirst.items.map((row) => row.id)).toEqual(["row-6", "row-5", "row-4"]);
    expect(backToFirst.pageInfo).toMatchObject({ hasPreviousPage: false, startCursor: null });
  });

  it("omits totalCount when the caller does not pay for the count query", async () => {
    const result = await paginateAdminKeyset({
      scope: "fixture",
      queryIdentity: { status: "open" },
      limit: 3,
      keys: KEYS,
      fetch: query,
    });
    expect(result.pageInfo.totalCount).toBeUndefined();
  });

  it("refuses a forward and a backward cursor in the same request", async () => {
    const first = await page();
    await expect(page(first.pageInfo.endCursor!, first.pageInfo.endCursor!)).rejects.toThrow(/not both/);
  });

  it("rejects a cursor whose key count no longer matches the sort", async () => {
    const stale = encodeAdminListCursor("fixture", { status: "open" }, ["row-3"]);
    await expect(page(stale)).rejects.toThrow(/invalid/);
  });
});
