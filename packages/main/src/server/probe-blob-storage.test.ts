import { describe, expect, it } from "vitest";
import { resolveProbeBlobProvider } from "./probe-blob-storage";

// SPEC: 探针解析 blob 存储开关的规则。
// INTENT: BLOB_PROVIDER 与 GEN_BLOB_PROVIDER 这一对变量此前被两处以相反的优先级
//   解析 —— gen（packages/gen/src/env.ts）是 GEN_ 优先，本探针是 BLOB_ 优先。
//   两个都设且不同时，探针验证的是 gen 根本不写入的那个存储，却照样报"健康"。
//   没有任何用例走过"两个都设且不同"这条路径，所以这次分歧一直没被发现。
describe("resolveProbeBlobProvider", () => {
  it("都没设时是 mock", () => {
    expect(resolveProbeBlobProvider({})).toBe("mock");
  });

  it("只设一个时用那一个 —— 两个方向都要成立", () => {
    expect(resolveProbeBlobProvider({ BLOB_PROVIDER: "r2" })).toBe("r2");
    expect(resolveProbeBlobProvider({ GEN_BLOB_PROVIDER: "s3" })).toBe("s3");
  });

  it("两个一致时用那个值", () => {
    expect(
      resolveProbeBlobProvider({ BLOB_PROVIDER: "r2", GEN_BLOB_PROVIDER: "r2" }),
    ).toBe("r2");
  });

  it("两个都设且不同 → 直接失败，而不是悄悄挑一边", () => {
    expect(() =>
      resolveProbeBlobProvider({ BLOB_PROVIDER: "r2", GEN_BLOB_PROVIDER: "s3" }),
    ).toThrow("BLOB_PROVIDER=r2 and GEN_BLOB_PROVIDER=s3 disagree");
    // mock 与真实存储的组合是最危险的一种：探针跑在 mock 上会全绿，
    // 而 gen 正往一个从没被验证过的桶里写。
    expect(() =>
      resolveProbeBlobProvider({ BLOB_PROVIDER: "mock", GEN_BLOB_PROVIDER: "r2" }),
    ).toThrow("disagree");
  });

  it("拒绝词表外的值", () => {
    expect(() => resolveProbeBlobProvider({ BLOB_PROVIDER: "gcs" })).toThrow(
      "Unsupported blob provider: gcs",
    );
  });
});
