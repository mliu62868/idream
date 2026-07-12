import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UsersView } from "./AdminConsoleClient";

const permissionForm = {
  userId: "target-user",
  permissionKey: "billing.ledger.adjust",
  effect: "grant" as const,
};

const rows = [{
  id: "target-user",
  email: "target@example.test",
  displayName: "Target User",
  role: "user",
  status: "active",
  dreamcoins: 0,
  createdAt: "2026-07-12T00:00:00.000Z",
}];

describe("Team Access effective permission matrix", () => {
  it("renders read-only rows without status or permission mutation controls", () => {
    const html = renderToStaticMarkup(
      <UsersView
        canChangeStatus={false}
        canManagePermissions={false}
        openAction={vi.fn()}
        permissionForm={permissionForm}
        rows={rows}
        setPermissionForm={vi.fn()}
      />,
    );

    expect(html).toContain("target@example.test");
    expect(html).not.toContain("Permission override");
    expect(html).not.toContain("Suspend");
  });

  it("exposes only the independently granted high-risk controls", () => {
    const statusOnly = renderToStaticMarkup(
      <UsersView
        canChangeStatus
        canManagePermissions={false}
        openAction={vi.fn()}
        permissionForm={permissionForm}
        rows={rows}
        setPermissionForm={vi.fn()}
      />,
    );
    const permissionsOnly = renderToStaticMarkup(
      <UsersView
        canChangeStatus={false}
        canManagePermissions
        openAction={vi.fn()}
        permissionForm={permissionForm}
        rows={rows}
        setPermissionForm={vi.fn()}
      />,
    );

    expect(statusOnly).toContain("Suspend");
    expect(statusOnly).not.toContain("Permission override");
    expect(permissionsOnly).toContain("Permission override");
    expect(permissionsOnly).not.toContain("Suspend");
  });
});
