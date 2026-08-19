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

type CursorDirection = "asc" | "desc";

// SPEC: 一个 keyset 排序键 —— Prisma 标量字段名、方向、以及从行里取游标值的方法。
// INVARIANT: field 必须是非空列。可空列上的 keyset 比较（NULL > x 恒为 NULL）会把
// NULL 行永久跳过，翻页时静默丢数据，比排序不对更糟。
export interface AdminKeysetKey<TRow> {
  readonly field: string;
  readonly direction: CursorDirection;
  readonly type?: "string" | "number" | "datetime";
  readonly value: (row: TRow) => string | number | Date;
}

// 绝大多数 Admin 列表都是「最近的排前面」，复合键固定是 (createdAt desc, id desc)。
export const CREATED_AT_DESC_KEYS: readonly AdminKeysetKey<{
  readonly createdAt: Date;
  readonly id: string;
}>[] = [
  { field: "createdAt", direction: "desc", type: "datetime", value: (row) => row.createdAt },
  { field: "id", direction: "desc", value: (row) => row.id },
];

export interface AdminKeysetPageInfo {
  readonly endCursor: string | null;
  readonly hasNextPage: boolean;
  readonly startCursor: string | null;
  readonly hasPreviousPage: boolean;
  readonly totalCount?: number;
}

// 分页器算出来、原样传给 Prisma findMany 的三个参数。
// 显式命名是为了让调用点能标注 fetch 的参数 —— 参数不带标注的函数表达式是
// context-sensitive，TS 会推迟推断，行类型就退化成 unknown。
// TOrderBy 由调用点填自己模型的 OrderByWithRelationInput，省掉每个调用点各写一次断言。
export interface AdminKeysetPaging<TOrderBy = Record<string, CursorDirection>> {
  // 游标谓词，无游标时为空数组。展开进调用方自己的 AND 里：
  // `where: { AND: [base, ...paging.cursorWhere] }`。
  // 故意做成数组而不是 `AND: paging.where` —— metric-data-scope 的 where 构造器返回的就是
  // `{ AND: [数据域限制, 调用方条件] }`，对象展开会把数据域限制整条覆盖掉。
  readonly cursorWhere: readonly Record<string, unknown>[];
  readonly orderBy: TOrderBy[];
  readonly take: number;
}

// SPEC: Admin 列表统一的双向 keyset 分页。`cursor` 向后翻，`before` 向前翻，两者互斥。
// INTENT: 不改 offset 分页 —— 这批表已压过 10 万量级，OFFSET 会随页码线性退化；keyset
// 只要复合键有索引就恒定代价。反向翻页 = 翻转每个键的方向 + 翻转比较符 + 结果数组倒序。
// INTENT: endCursor / startCursor 在没有下一页 / 上一页时为 null —— 沿用改造前的语义，
// 前端可以只看游标是否为空，不必再判 hasNextPage。
export async function paginateAdminKeyset<
  TRow,
  TOrderBy = Record<string, CursorDirection>,
>(input: {
  readonly scope: string;
  readonly queryIdentity: unknown;
  readonly cursor?: string | null;
  readonly before?: string | null;
  readonly limit: number;
  // NoInfer: 行类型只从 fetch 的返回值推，别让 keys 里的箭头函数参数反过来把它推成 unknown。
  readonly keys: readonly AdminKeysetKey<NoInfer<TRow>>[];
  readonly fetch: (page: AdminKeysetPaging<TOrderBy>) => Promise<readonly TRow[]>;
  readonly count?: () => Promise<number>;
}): Promise<{ readonly items: readonly TRow[]; readonly pageInfo: AdminKeysetPageInfo }> {
  const { scope, queryIdentity, keys, limit } = input;
  if (input.cursor && input.before) {
    throw Errors.badRequest(`${scope} accepts a forward cursor or a backward cursor, not both`);
  }
  const backward = Boolean(input.before);
  const anchor = input.before ?? input.cursor ?? null;
  const cursorKeys = anchor ? decodeAdminListCursor(anchor, scope, queryIdentity) : null;
  if (cursorKeys && cursorKeys.length !== keys.length) {
    throw Errors.badRequest(`${scope} cursor is invalid for the selected query`);
  }

  // 唯一一处断言：Prisma 的 OrderByWithRelationInput 是逐字段联合，收不下动态键的
  // Record。断言收在这里，调用点就不用各写一次。
  const orderBy = keys.map((key) => ({
    [key.field]: backward ? flipDirection(key.direction) : key.direction,
  })) as unknown as TOrderBy[];
  const cursorWhere = cursorKeys
    ? [{
        OR: keys.map((key, index) => {
          const clause: Record<string, unknown> = {};
          for (let prior = 0; prior < index; prior += 1) {
            const priorKey = keys[prior]!;
            clause[priorKey.field] = cursorOperand(priorKey, cursorKeys[prior], scope);
          }
          const direction = backward ? flipDirection(key.direction) : key.direction;
          clause[key.field] = {
            [direction === "asc" ? "gt" : "lt"]: cursorOperand(key, cursorKeys[index], scope),
          };
          return clause;
        }),
      }]
    : [];

  const [rows, totalCount] = await Promise.all([
    input.fetch({ cursorWhere, orderBy, take: limit + 1 }),
    input.count?.(),
  ]);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const items = backward ? [...page].reverse() : page;
  // 反向翻页一定是从后面某页退回来的，所以下一页必然存在；正向反之。
  const hasNextPage = backward ? true : hasMore;
  const hasPreviousPage = backward ? hasMore : Boolean(input.cursor);
  const first = items.at(0);
  const last = items.at(-1);
  return {
    items,
    pageInfo: {
      endCursor: hasNextPage && last ? encodeRowCursor(scope, queryIdentity, keys, last) : null,
      hasNextPage,
      startCursor: hasPreviousPage && first ? encodeRowCursor(scope, queryIdentity, keys, first) : null,
      hasPreviousPage,
      ...(totalCount === undefined ? {} : { totalCount }),
    },
  };
}

function flipDirection(direction: CursorDirection): CursorDirection {
  return direction === "asc" ? "desc" : "asc";
}

function encodeRowCursor<TRow>(
  scope: string,
  queryIdentity: unknown,
  keys: readonly AdminKeysetKey<TRow>[],
  row: TRow,
) {
  return encodeAdminListCursor(
    scope,
    queryIdentity,
    keys.map((key) => {
      const value = key.value(row);
      return value instanceof Date ? value.toISOString() : value;
    }),
  );
}

function cursorOperand<TRow>(key: AdminKeysetKey<TRow>, value: unknown, scope: string) {
  if (key.type === "datetime") return parseIsoCursorKey(value, scope);
  if (key.type === "number") {
    if (typeof value !== "number") throw Errors.badRequest(`${scope} cursor key is invalid`);
    return value;
  }
  if (typeof value !== "string" || !value) throw Errors.badRequest(`${scope} cursor key is invalid`);
  return value;
}
