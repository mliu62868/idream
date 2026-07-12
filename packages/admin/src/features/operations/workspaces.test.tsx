import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CaseWorkspace } from "../cases/CaseWorkspace";
import { IncidentWorkspace } from "../incidents/IncidentWorkspace";
import { EmptyWorkspace, LoadingWorkspace, StatusBadge } from "./WorkspaceUi";

describe("operational workspaces", () => {
  it("renders an incident landmark and structure-matched loading status", () => {
    const html = renderToStaticMarkup(<IncidentWorkspace canManage={false} />);
    expect(html).toContain('aria-labelledby="incident-workspace-title"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading correlated incidents");
  });

  it("renders keyboard-addressable case saved views before data arrives", () => {
    const html = renderToStaticMarkup(<CaseWorkspace canAssign={false} canDecide={false} />);
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-pressed="true"');
  });

  it("distinguishes loading, true empty, filtered empty, partial, and stale states", () => {
    const html = renderToStaticMarkup(<>
      <LoadingWorkspace label="Loading authority" />
      <EmptyWorkspace filtered={false} onClear={() => undefined} />
      <EmptyWorkspace filtered onClear={() => undefined} />
      <StatusBadge value="partially_succeeded" />
      <StatusBadge value="stale" />
    </>);
    expect(html).toContain("Loading authority");
    expect(html).toContain("The queue is clear");
    expect(html).toContain("No work matches these filters");
    expect(html).toContain("partially succeeded");
    expect(html).toContain("stale");
  });
});
