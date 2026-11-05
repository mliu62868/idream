// @vitest-environment happy-dom
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminV2Request } from "@/lib/admin-v2-api";
import { useAdminAuthority } from "./use-admin-authority";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GRANTED = ["character.project.read", "dashboard.read"];
const bootstrapBody = (permissions: readonly string[] = GRANTED) => ({
  ok: true,
  data: { bootstrap: {
    actor: { id: "producer-1", role: "support" },
    permissions,
    canReadDashboard: true,
    canCreateCharacters: false,
    devLogin: { enabled: false, accounts: [] },
    shellSignals: { environment: "local", dataClass: "internal", fixtureState: "excluded", productTimezone: "UTC", freshness: { state: "reported", label: "x" } },
  } },
});

const observed: { current: ReturnType<typeof useAdminAuthority> | null } = { current: null };
function Harness() {
  const [initial] = useState({ actor: { id: "producer-1", role: "support" }, permissions: GRANTED as never[], canCreateCharacters: false });
  const authority = useAdminAuthority(initial);
  useEffect(() => { observed.current = authority; });
  return null;
}

describe("useAdminAuthority", () => {
  let container: HTMLDivElement;
  let root: Root;
  let boots = 0;
  beforeEach(async () => {
    boots = 0;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function stubAuthority(rejected: () => Response, bootstrap: () => Response = () => Response.json(bootstrapBody())) {
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (String(path).endsWith("/bootstrap")) { boots += 1; return bootstrap(); }
      return rejected();
    }));
  }
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });

  it("does not revoke a permission when one resource is outside the operator's scope", async () => {
    stubAuthority(() => Response.json({
      ok: false,
      error: { code: "forbidden", message: "Character is outside the effective permission scope", details: { permission: "character.project.read", characterId: "out-of-scope" } },
    }, { status: 403 }));
    await act(async () => { await adminV2Request("/api/v2/admin/characters/out-of-scope").catch(() => undefined); });
    await settle();
    expect(boots).toBe(0);
    expect(observed.current!.permissions).toEqual(GRANTED);
  });

  it("still retires a permission on a real global rejection", async () => {
    stubAuthority(
      () => Response.json({ ok: false, error: { code: "forbidden", message: "Missing admin permission", details: { permission: "character.project.read" } } }, { status: 403 }),
      () => Response.json(bootstrapBody(["dashboard.read"])),
    );
    await act(async () => { await adminV2Request("/api/v2/admin/characters/portfolio").catch(() => undefined); });
    await settle();
    expect(boots).toBe(1);
    expect(observed.current!.permissions).toEqual(["dashboard.read"]);
  });

  it("stops the revoke and re-grant loop once bootstrap contradicts the same rejection", async () => {
    stubAuthority(() => new Response("<html>blocked by WAF</html>", { status: 403 }));
    await act(async () => { await adminV2Request("/api/v2/admin/today").catch(() => undefined); });
    await settle();
    expect(boots).toBe(1);
    expect(observed.current!.permissions).toEqual(GRANTED);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await act(async () => { await adminV2Request("/api/v2/admin/today").catch(() => undefined); });
      await settle();
    }
    expect(boots).toBe(1);
    expect(observed.current!.permissions).toEqual(GRANTED);
  });

  it("retains permissions only for a transient bootstrap failure, never for a lost session", async () => {
    stubAuthority(() => new Response(null, { status: 404 }), () => Response.json({ ok: false, error: { code: "admin_upstream_unavailable", message: "down" } }, { status: 503 }));
    await act(async () => { await observed.current!.refresh(); });
    expect(observed.current!.permissions).toEqual([]);
    expect(observed.current!.retainedPermissions).toEqual(GRANTED);

    await act(async () => { await observed.current!.refresh(); });
    expect(observed.current!.retainedPermissions).toEqual(GRANTED);

    stubAuthority(() => new Response(null, { status: 404 }), () => Response.json(bootstrapBody()));
    await act(async () => { await observed.current!.refresh(); });
    expect(observed.current!.error).toBeNull();
    expect(observed.current!.retainedPermissions).toBeNull();
    expect(observed.current!.permissions).toEqual(GRANTED);

    stubAuthority(() => new Response(null, { status: 404 }), () => Response.json(bootstrapBody().data.bootstrap && {
      ok: true, data: { bootstrap: { ...bootstrapBody().data.bootstrap, actor: null } },
    }));
    await act(async () => { await observed.current!.refresh(); });
    expect(observed.current!.error).not.toBeNull();
    expect(observed.current!.retainedPermissions).toBeNull();
  });
});
