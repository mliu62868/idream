import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { AuthorityRequestError } from "./AuthorityRequestError";

describe("AuthorityRequestError", () => {
  it("labels retained data as a last successful snapshot", () => {
    const html = renderToStaticMarkup(
      <AuthorityRequestError
        message="Refresh failed"
        onRetry={() => undefined}
        snapshotAt="2026-07-16T12:00:00.000Z"
      />,
    );

    expect(html).toContain("Showing the last successful snapshot from");
    expect(html).toContain('dateTime="2026-07-16T12:00:00.000Z"');
  });

  it("does not claim a snapshot exists on a first-load failure", () => {
    const html = renderToStaticMarkup(
      <AuthorityRequestError message="Load failed" onRetry={() => undefined} />,
    );

    expect(html).not.toContain("last successful snapshot");
  });

  // SPEC: 运营首屏读到的是「发生了什么 + 下一步」，authority 的英文原文折进技术详情。
  it("leads with operator copy and folds the authority's own words away", () => {
    const html = renderToStaticMarkup(
      <AuthorityRequestError
        cause={
          new AdminV2RequestError("Ledger snapshot unavailable", 503, "unavailable", undefined, "req-3")
        }
        message="Ledger snapshot unavailable"
        onRetry={() => undefined}
      />,
    );

    expect(html).toContain("The authority did not answer.");
    expect(html).toContain("Check this record&#x27;s current state before retrying");
    // 技术详情里 code / status / requestId / 原文一个不少，且默认折叠。
    expect(html).toContain("code: unavailable");
    expect(html).toContain("status: 503");
    expect(html).toContain("requestId: req-3");
    expect(html).toContain("Ledger snapshot unavailable");
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
  });

  // INTENT: 十一处历史调用点只有一句 message，没有异常对象；它们也得有体面的一句话，
  //         而不是退回原始英文串——同时不许伪造 code / status / requestId。
  it("still gives message-only callers a headline without inventing identifiers", () => {
    const html = renderToStaticMarkup(
      <AuthorityRequestError message="Tag authority request failed" onRetry={() => undefined} />,
    );

    expect(html).toContain("The latest data could not be loaded.");
    expect(html).toContain("message: Tag authority request failed");
    expect(html).not.toContain("code:");
    expect(html).not.toContain("status:");
    expect(html).not.toContain("requestId:");
  });
});
