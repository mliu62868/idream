import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CaseWorkspace } from "../cases/CaseWorkspace";
import { IncidentWorkspace } from "../incidents/IncidentWorkspace";

describe("operational workspaces", () => {
  it("renders an incident landmark and structure-matched loading status", () => {
    const html = renderToStaticMarkup(<IncidentWorkspace canManage={false} />);
    expect(html).toContain('aria-labelledby="incident-workspace-title"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading correlated incidents");
  });

  it("renders keyboard-addressable case saved views before data arrives", () => {
    const html = renderToStaticMarkup(<CaseWorkspace canAssign={false} canDecide={false} />);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-selected="true"');
  });
});
