import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AuditWorkspace } from "./AuditWorkspace";

describe("Audit operator workspace", () => {
  it("renders the shared filter bar and a structure-matched accessible loading state", () => {
    const html = renderToStaticMarkup(<AuditWorkspace />);

    expect(html).toContain("Audit Log");
    // 搜索常驻，其余字段折在「Filters」后面 —— 首屏不再被一整块筛选面板顶掉。
    expect(html).toContain('aria-label="action, target, reason, or request"');
    expect(html).toContain(">Filters<");
    expect(html).not.toContain("Exact action");
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading Audit authority events…");
  });

  it("claims nothing about emptiness before the audit authority answers", () => {
    const html = renderToStaticMarkup(<AuditWorkspace />);

    expect(html).not.toContain("No audit events exist yet");
    expect(html).not.toContain("No audit events match these filters");
    expect(html).toContain("animate-pulse");
  });
});
