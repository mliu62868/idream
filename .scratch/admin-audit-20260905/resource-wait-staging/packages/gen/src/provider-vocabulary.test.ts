import { describe, expect, it } from "vitest";
import {
  GEN_ADAPTERS,
  GEN_BLOB_ADAPTERS,
  parseGenAdapter,
  parseGenBlobAdapter,
} from "./provider-vocabulary";

// 词表与分发的一致性由编译期保证：buildImageModel / buildVideoModel / buildBlobStore
// 的 switch 没有 default 也没有兜底 throw，少一个分支就是 TS2366；PRODUCTION_ADAPTERS
// 的元素类型是 GenAdapter，写错一个名字就是 TS2820。这里只测运行时那部分 ——
// **拒绝词表外的值，并给出别处（providers.test.ts、运维手册）依赖的那条消息**。
describe("provider vocabulary", () => {
  it("接受词表内的每一个值，原样返回", () => {
    for (const adapter of GEN_ADAPTERS) {
      expect(parseGenAdapter("image", adapter)).toBe(adapter);
      expect(parseGenAdapter("video", adapter)).toBe(adapter);
    }
    for (const adapter of GEN_BLOB_ADAPTERS) {
      expect(parseGenBlobAdapter(adapter)).toBe(adapter);
    }
  });

  it("拒绝词表外的适配器，消息里带上 kind 和原值", () => {
    expect(() => parseGenAdapter("image", "sdcpp")).toThrow("Unsupported image provider: sdcpp");
    expect(() => parseGenAdapter("video", "sdcpp")).toThrow("Unsupported video provider: sdcpp");
    // 大小写和空白都不宽容 —— 环境变量里的 " backend" 是配置错误，不是 backend。
    expect(() => parseGenAdapter("image", "Backend")).toThrow("Unsupported image provider: Backend");
    expect(() => parseGenAdapter("image", " backend")).toThrow("Unsupported image provider:  backend");
  });

  it("拒绝词表外的 blob 适配器", () => {
    // 此前 buildBlobStore 和 assertProductionBlobReady 各写了一遍 r2/s3 判断，
    // 但没有任何用例覆盖"词表外的值"这条路径。
    expect(() => parseGenBlobAdapter("gcs")).toThrow("Unsupported blob provider: gcs");
    expect(() => parseGenBlobAdapter("")).toThrow("Unsupported blob provider: ");
  });
});
