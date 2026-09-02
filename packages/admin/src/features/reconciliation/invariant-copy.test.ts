import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { translateAdmin } from "@/components/admin/i18n-dictionary";
import { hasInvariantCopy, invariantCopy, invariantOwnerBreakdown } from "./invariant-copy";

// SPEC: 权威的 key 清单从**后端源码**派生，不是手抄的常量。
// INTENT: 这份清单原来是硬编码的 31 个 key，于是"覆盖权威返回的每一条检查"这句话是假的——
//         后端新增一条检查时，这条用例照样绿，而那条新检查在界面上静默走兜底文案
//         「数据一致性检查失败」。实测就这么发生过：队友加了
//         `open_request_exceeds_settlement_deadline` 与 `attempt_without_request`，
//         报告里已经有 34 条、其中 2 条在报警，而字典和这条用例一无所知。
//         从源码派生之后，加检查不补文案 = 这条用例变红。
// INVARIANT: 路径写死。文件搬家就让这条用例失败——那正是它该做的事：
//            一个悄悄失效的漂移守卫比没有守卫更糟。
const AUTHORITY_SOURCE = new URL(
  "../../../../main/src/server/modules/admin-v2/reconciliation/invariants.ts",
  import.meta.url,
);

function authorityKeys(source: string): readonly string[] {
  // 权威里 key 有两种写法：SQL 表驱动的 `key: "..."` 和编程式
  // `invariantCheck(\n  "..."`。两种都要抓，漏一种就等于漏一批检查。
  return [
    ...[...source.matchAll(/^\s*key: "([a-z0-9_]+)",$/gm)].map((match) => match[1]!),
    ...[...source.matchAll(/invariantCheck\(\s*\n\s*"([a-z0-9_]+)"/g)].map((match) => match[1]!),
  ];
}

const AUTHORITY_KEYS: readonly string[] = (() => {
  const keys = authorityKeys(readFileSync(AUTHORITY_SOURCE, "utf8"));
  if (keys.length < 30) {
    throw new Error(`Only parsed ${keys.length} invariant keys — the authority file shape changed`);
  }
  return keys;
})();

describe("data-integrity invariant copy", () => {
  it("covers every check the authority currently returns", () => {
    expect(AUTHORITY_KEYS.filter((key) => !hasInvariantCopy(key))).toEqual([]);
  });

  // SPEC: 中文界面上不许出现没翻译的结论或下一步。
  // INTENT: 字典存的是 i18n key，漏一条中文就会在页面上原样漏出英文——`underage` 当年
  //         就是这样漏出去的，这里提前钉死。
  it("has Chinese for every title and hint", () => {
    for (const key of AUTHORITY_KEYS) {
      const { title, hint } = invariantCopy(key);
      expect(translateAdmin("zh", title), `${key} title 缺中文`).not.toBe(title);
      expect(translateAdmin("zh", hint), `${key} hint 缺中文`).not.toBe(hint);
    }
  });

  // SPEC: 兜底不猜结论，只说"转给工程"。
  it("falls back without inventing a cause for an unknown check", () => {
    expect(hasInvariantCopy("some_future_invariant")).toBe(false);
    expect(invariantCopy("some_future_invariant")).toMatchObject({
      title: "Data-integrity check failed",
      owner: "engineering",
    });
  });

  // SPEC: 标成 operations 的前提是运营真有一条命令能收口它。
  // INTENT: 交付计数这两条曾被标成 operations，下一步写的是"对账样本生成记录"——而后台唯一
  //         沾边的命令 `jobs/:id/commands/reconcile-unknown` 只接受 status=unknown 的 Attempt
  //         （unknown-reconciliation.ts:146 直接抛 conflict）。指向一个不存在的动作，比不给
  //         下一步更糟：运营会以为是自己没找到。
  it("does not tell operations to close a break only engineering can fix", () => {
    for (const key of [
      "succeeded_request_delivery_count_mismatch",
      "partial_request_delivery_count_mismatch",
      "terminal_attempt_without_unique_terminal_event",
      // 后台没有任何重新资质化的写入口：唯一能写 GenerationRouteQualification 的端点
      // `POST /characters/route-qualifications/commands/evaluate` 在 packages/admin 里零引用，
      // 角色工作台的路由工作台通篇只读。标成 operations 就是指着一个不存在的按钮。
      "serving_default_route_unqualified",
    ]) {
      expect(invariantCopy(key).owner, `${key} 不该由运营收口`).toBe("engineering");
    }
  });

  // SPEC: 顶部结论条要先把违规切成「我能收口的」和「只能转工程的」。
  // INTENT: unavailable 不进这两个桶 —— 结论条把"没能检查"单列成第三个数字，算进 engineering
  //         就是同一条被数两遍。
  it("splits failing checks by who can close them and counts nothing else", () => {
    expect(
      invariantOwnerBreakdown([
        { key: "open_source_without_case", status: "failed" },
        { key: "official_public_character_not_live", status: "failed" },
        { key: "generation_settlement_link_mismatch", status: "failed" },
        { key: "some_future_invariant", status: "unavailable" },
        { key: "character_project_orphan", status: "passed" },
      ]),
    ).toEqual({ operations: 2, engineering: 1 });
  });
});

// SPEC: 这条守卫本身必须真的会红。
// INTENT: 派生清单如果哪天解析不出东西（正则失配、文件改形），上面几条会退化成
//         「对空数组断言」——全绿，而实际上一条都没在守。这里把解析结果本身钉住。
describe("the drift guard itself", () => {
  it("parses both declaration shapes the authority uses", () => {
    expect(authorityKeys(`
      {
        key: "sql_table_check",
        severity: "critical",
      },
      invariantCheck(
        "programmatic_check",
        "critical",
        0,
      ),
    `)).toEqual(["sql_table_check", "programmatic_check"]);
    // SQL 表驱动的一条 + 编程式 invariantCheck() 的一条，各取一个代表。
    expect(AUTHORITY_KEYS).toContain("character_project_orphan");
    expect(AUTHORITY_KEYS).toContain("serving_character_pointer_orphan");
    expect(new Set(AUTHORITY_KEYS).size).toBe(AUTHORITY_KEYS.length);
  });
});
