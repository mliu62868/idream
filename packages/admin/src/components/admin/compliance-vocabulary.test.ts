import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPLIANCE_ACCOUNT_DELETION_WAITING_ON } from "@idream/shared/admin";
import { BLOCKER_COPY, WAITING_ON_COPY } from "./ComplianceView";

// SPEC: 前端这两张表是服务端词表的镜像，镜像就会漂。
// INTENT: 本仓刚为这件事付过两次代价——一条不变式的 SQL 和 TS 两处实现取了不同的 JSON 路径，
//         判据恒为空；另一条把「支持请求的 Case 类型」写成了词表里不存在的取值。
//         判据只要存在第二处实现，就必须有东西去比对两处，不能假设它们同步。
describe("compliance console mirrors the authority's vocabulary", () => {
  // 这一个词表是共享契约里的导出常量，所以能做精确覆盖：多一个少一个都算失败。
  it("has copy for exactly the waitingOn values the contract can emit", () => {
    expect(Object.keys(WAITING_ON_COPY).sort())
      .toEqual([...COMPLIANCE_ACCOUNT_DELETION_WAITING_ON].sort());
  });

  // SPEC: blocker 码没有共享常量——它们是 account-deletion-authority 里的字符串字面量。
  // INVARIANT: 认不出来的 blocker 会原样显示服务端的码（不编解释），所以漏一个不会撒谎；
  //            但**改名**会让已有的那条解释静默失效，这条用例就是为了挡住改名。
  it("keeps every blocker it explains alive in the authority", () => {
    const authority = readFileSync(
      new URL("../../../../main/src/server/account-deletion-authority.ts", import.meta.url),
      "utf8",
    );
    expect(Object.keys(BLOCKER_COPY).length).toBeGreaterThan(0);
    for (const code of Object.keys(BLOCKER_COPY)) {
      expect(authority, `${code} 在权威里已经不存在了`).toContain(`"${code}"`);
    }
  });
});
