// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Request, AdminV2RequestError, setWorkspaceUrl, collaborationPanel } = vi.hoisted(() => ({
  adminV2Request: vi.fn(),
  AdminV2RequestError: class extends Error {},
  setWorkspaceUrl: vi.fn(),
  collaborationPanel: vi.fn<(props: { canWrite: boolean; targetId: string; targetVersion: number; onAuthorityChange: () => Promise<void> }) => null>(() => null),
}));

vi.mock("@/lib/admin-v2-api", () => ({
  adminV2Request,
  setWorkspaceUrl,
  AdminV2RequestError,
}));
vi.mock("@/features/collaboration/CollaborationPanel", () => ({
  CollaborationPanel: collaborationPanel,
}));
vi.mock("@/features/collaboration/SavedViewsControl", () => ({
  SavedViewsControl: () => null,
}));

import { IncidentWorkspace } from "./IncidentWorkspace";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const idempotencyKey = "33333333-3333-4333-8333-333333333333";
const impact = {
  affectedRequests: 4,
  affectedUsers: 3,
  failedCostMicros: 125_000,
  refundMicros: 0,
  refundDreamcoins: 40,
};
const incident = {
  id: "incident-1",
  signature: "signature-abcdef012345",
  signatureVersion: "v2",
  status: "mitigating",
  severity: "critical",
  ownerId: null,
  firstSeenAt: "2026-08-11T11:00:00.000Z",
  lastSeenAt: "2026-08-11T12:30:00.000Z",
  impact,
  lastKnownGoodAt: null,
  slaDueAt: null,
  suspectedCause: "Provider timeouts",
  causeConfidence: 0.75,
  recommendedActions: ["retry_eligible", "pause_route"],
  runbookUrl: null,
  rollbackTarget: null,
  recoveryVerification: { state: "pending", checkedAt: null, evidenceRefs: [], checks: null },
  version: 7,
  createdAt: "2026-08-11T11:00:00.000Z",
  updatedAt: "2026-08-11T12:31:00.000Z",
};
const plan = {
  id: "plan-1",
  incidentId: incident.id,
  action: "refund" as const,
  incidentVersion: incident.version,
  occurrenceSetHash: "hash-1",
  eligibleOccurrenceIds: ["occurrence-1", "occurrence-2"],
  skippedOccurrenceIds: [],
  impact,
  targetVersion: null,
  // 相对 list.asOf 未过期——过期判断锚在服务端时钟上，不受跑测试的挂钟影响。
  expiresAt: "2026-08-11T12:47:00.000Z",
  createdBy: "operator-1",
  createdAt: "2026-08-11T12:31:00.000Z",
};
const list = {
  items: [incident],
  pageInfo: { endCursor: null, hasNextPage: false },
  asOf: "2026-08-11T12:32:00.000Z",
  freshness: "fresh",
};
const detail = {
  incident,
  occurrences: [
    { id: "occurrence-1", incidentId: incident.id, requestId: "job-1", attemptId: "attempt-1", transportExecutionId: null, observedAt: "2026-08-11T12:00:00.000Z", assignmentHistory: [] },
    { id: "occurrence-2", incidentId: incident.id, requestId: "job-2", attemptId: "attempt-2", transportExecutionId: null, observedAt: "2026-08-11T12:10:00.000Z", assignmentHistory: [] },
  ],
  // 两条 occurrence 分属两个用户，外加一条反查不到的——三种情况在一个夹具里都覆盖到。
  affectedUsers: [
    { userId: "customer-a", occurrenceCount: 2, customerRecordAvailable: true },
    { userId: "customer-b", occurrenceCount: 1, customerRecordAvailable: false },
  ],
  unattributableOccurrences: 1,
  actionPlans: [plan],
  postmortem: null,
  activity: [],
};

// SPEC: 事故详情要给出「打到了谁」的名单，并如实说明有多少条反查不到。
// INTENT: `impact.affectedUsers` 一直只是个计数，运营要联系受影响的人时没有名单可用。
//         这里同时钉住那条容易被"顺手清理掉"的诚实性要求：反查不到的 occurrence 必须单独说，
//         既不能并进名单（会指错人），也不能悄悄丢掉（会让运营以为已经联系全了）。
describe("IncidentWorkspace affected users", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalNavigation: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalNavigation = Object.getOwnPropertyDescriptor(window, "navigation");
    window.history.replaceState(null, "", "/admin/ops/incidents");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    adminV2Request.mockReset();
    setWorkspaceUrl.mockReset();
    adminV2Request.mockImplementation(async (path: string) =>
      path.startsWith("/api/v2/admin/incidents?") ? list : detail,
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    if (originalNavigation) Object.defineProperty(window, "navigation", originalNavigation);
    else Reflect.deleteProperty(window, "navigation");
    vi.restoreAllMocks();
  });

  async function mountInspector() {
    await act(async () => {
      root.render(<IncidentWorkspace canManage initialIncidentId={incident.id} />);
    });
    await waitUntil(() => (container.textContent ?? "").includes("customer-a"));
  }

  it.each(["close", "switch", "history"])("protects an unsaved postmortem before %s and preserves it on cancel", async (navigationKind) => {
    const resolved = { ...incident, status: "resolved" };
    const second = { ...incident, id: "incident-2", suspectedCause: "Second Incident" };
    window.history.replaceState(null, "", "/admin/ops/incidents/incident-1");
    setWorkspaceUrl.mockImplementation((params: URLSearchParams, options: { pathname: string; mode: "push" | "replace" }) => {
      window.history[options.mode === "push" ? "pushState" : "replaceState"](null, "", `${options.pathname}?${params}`);
    });
    adminV2Request.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/v2/admin/incidents?")) return { ...list, items: [resolved, second] };
      return { ...detail, incident: path.endsWith("/incident-2") ? second : resolved };
    });
    const navigation = new EventTarget();
    const targetPath = navigationKind === "switch" ? "/admin/ops/incidents/incident-2" : "/admin/ops/incidents";
    const traverseTo = vi.fn(() => {
      window.history.replaceState(null, "", targetPath);
      window.dispatchEvent(new PopStateEvent("popstate"));
      return { committed: Promise.resolve(), finished: Promise.resolve() };
    });
    Object.defineProperty(window, "navigation", { configurable: true, value: Object.assign(navigation, { traverseTo }) });
    await mountInspector();
    const summary = () => container.querySelector<HTMLTextAreaElement>('[aria-labelledby="incident-postmortem-title"] textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(summary(), "Unfinished postmortem containing operator investigation");
      summary().dispatchEvent(new Event("input", { bubbles: true }));
    });
    const leave = async () => act(async () => {
      if (navigationKind === "close") findButton("Close incident detail", container)!.click();
      else if (navigationKind === "switch") [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Incident results"] button')].find(button => button.textContent?.includes("Second Incident"))!.click();
      else {
        const event = Object.assign(new Event("navigate", { cancelable: true }), { navigationType: "traverse", destination: { key: "incident-list", url: new URL(targetPath, window.location.href).href } });
        navigation.dispatchEvent(event);
        if (!event.defaultPrevented) traverseTo();
      }
    });
    await leave();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Discard unsaved changes?");
    await click(findButton("Cancel", document.querySelector('[role="dialog"]')!));
    expect(window.location.pathname).toBe("/admin/ops/incidents/incident-1");
    expect(summary().value).toBe("Unfinished postmortem containing operator investigation");
    await leave();
    await click(findButton("Discard changes", document.querySelector('[role="dialog"]')!));
    expect(window.location.pathname).toBe(targetPath);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("reloads the applied incident list and selected inspector once through shell refresh without remounting its draft", async () => {
    await mountInspector();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Unfinished incident evidence");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const before = adminV2Request.mock.calls.length;
    const applied = adminV2Request.mock.calls.find(([path]) => path.startsWith("/api/v2/admin/incidents?"))![0];
    const href = window.location.href;
    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
    expect(adminV2Request.mock.calls.slice(before).map(([path]) => path)).toEqual([applied, `/api/v2/admin/incidents/${incident.id}`]);
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Unfinished incident evidence");
    expect(window.location.href).toBe(href);
  });

  it.each([false, true])("freezes postmortem submission fields and distinguishes committed content from a failed write (saved: %s)", async (saved) => {
    let finish!: () => void;
    let committed = false;
    adminV2Request.mockImplementation(async (path: string) => {
      if (path.endsWith("/commands/close")) return new Promise((resolve, reject) => {
        finish = () => {
          if (!saved) { reject(new Error("Close request failed")); return; }
          committed = true;
          resolve({ incidentId: incident.id, status: "closed", version: 8 });
        };
      });
      if (path.startsWith("/api/v2/admin/incidents?")) return list;
      if (committed) throw new Error("Committed postmortem readback unavailable");
      return { ...detail, incident: { ...incident, status: "resolved" } };
    });
    await mountInspector();
    const postmortem = container.querySelector<HTMLElement>('[aria-labelledby="incident-postmortem-title"]')!;
    const field = (label: string) => [...container.querySelectorAll("label")].find(node => node.textContent?.startsWith(label))!.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea")!;
    await act(async () => {
      for (const [label, value] of [["Summary", "Investigated and restored affected requests"], ["Root cause", "Provider request timeout"], ["Corrective actions", "Apply request timeout budget"], ["Close audit reason", "Verified recovery evidence"], ["Type close confirmation", "incident-1:close"], ["Supplemental evidence reference", "evidence:recovery-check"]]) {
        const input = field(label!);
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await click(findButton("Record postmortem and close", container));
    await waitUntil(() => Boolean(finish));
    expect(postmortem.querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBe(true);
    expect(field("Supplemental evidence reference").disabled).toBe(true);
    await act(async () => finish());
    await waitUntil(() => saved ? container.querySelector('[role="alert"]') !== null : !findButton("Record postmortem and close", container)!.disabled);
    expect(field("Summary").value).toBe("Investigated and restored affected requests");
    await click(findButton("Close incident detail", container));
    expect(Boolean(document.querySelector('[role="dialog"]'))).toBe(!saved);
  });

  it("preserves a readable unsaved postmortem when a shell refresh finds the incident closed elsewhere", async () => {
    let closed = false;
    adminV2Request.mockImplementation(async (path: string) => {
      const current = { ...incident, status: closed ? "closed" : "resolved", version: closed ? 8 : 7 };
      return path.startsWith("/api/v2/admin/incidents?")
        ? { ...list, items: closed ? [] : [current] }
        : { ...detail, incident: current };
    });
    await mountInspector();
    const postmortem = () => container.querySelector<HTMLElement>('[aria-labelledby="incident-postmortem-title"]');
    const summary = () => postmortem()?.querySelector<HTMLTextAreaElement>("textarea");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(summary(), "Unsubmitted investigation from this operator");
      summary()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    closed = true;
    await act(async () => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)));
    expect(summary()?.value).toBe("Unsubmitted investigation from this operator");
    expect(summary()?.readOnly).toBe(true);
    expect(summary()?.matches(":disabled")).toBe(false);
    expect(postmortem()?.textContent).toContain("The latest incident status is closed.");
    expect(findButton("Record postmortem and close", container)?.disabled).toBe(true);
    expect(adminV2Request.mock.calls.some(([path]) => path.endsWith("/commands/close"))).toBe(false);
    await click(findButton("Close incident detail", container));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Discard unsaved changes?");
    await click(findButton("Cancel", document.querySelector('[role="dialog"]')!));
    expect(summary()?.value).toBe("Unsubmitted investigation from this operator");
    await click(findButton("Close incident detail", container));
    await click(findButton("Discard changes", document.querySelector('[role="dialog"]')!));
    expect(postmortem()).toBeNull();
  });

  it("refreshes pristine triage fields after handoff while retaining edits and releases saved overrides", async () => {
    let current = { ...incident, ownerId: null as string | null };
    adminV2Request.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === "PATCH") {
        current = { ...current, suspectedCause: "Operator diagnosis", version: current.version + 1 };
        return { incidentId: incident.id, version: current.version };
      }
      return path.startsWith("/api/v2/admin/incidents?") ? { ...list, items: [current] } : { ...detail, incident: current };
    });
    await mountInspector();
    const triage = () => findButton("Save triage", container)!.closest("form")!;
    const owner = () => triage().querySelector<HTMLInputElement>("input")!;
    const cause = () => triage().querySelector<HTMLTextAreaElement>("textarea")!;
    const severity = () => triage().querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(cause(), "Operator diagnosis");
      cause().dispatchEvent(new Event("input", { bubbles: true }));
    });
    current = { ...current, ownerId: "operator-8", severity: "low", suspectedCause: "Authority diagnosis", version: 8 };
    await act(async () => collaborationPanel.mock.calls.at(-1)![0].onAuthorityChange());
    expect(owner().value).toBe("operator-8");
    expect(severity().value).toBe("low");
    expect(cause().value).toBe("Operator diagnosis");
    await enter(triage().querySelector<HTMLInputElement>('input[required]'), "Record current diagnosis");
    await click(findButton("Save triage", container));
    await waitUntil(() => !findButton("Save triage", container)!.disabled);
    expect(adminV2Request.mock.calls.find(([, options]) => options?.method === "PATCH")?.[1]).toMatchObject({
      body: { entityVersion: 8, ownerId: "operator-8", severity: "low", suspectedCause: "Operator diagnosis" },
    });

    current = { ...current, suspectedCause: "Updated authority diagnosis", version: 10 };
    await act(async () => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)));
    expect(cause().value).toBe("Updated authority diagnosis");
  });

  it("keeps edits entered while a triage save is pending and clears only the submitted field values", async () => {
    let finishSave!: () => void;
    let current = { ...incident, ownerId: null as string | null };
    adminV2Request.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === "PATCH") return new Promise(resolve => {
        finishSave = () => {
          current = { ...current, ownerId: "operator-8", suspectedCause: "Submitted diagnosis", version: 8 };
          resolve({ incidentId: incident.id, version: current.version });
        };
      });
      return path.startsWith("/api/v2/admin/incidents?") ? { ...list, items: [current] } : { ...detail, incident: current };
    });
    await mountInspector();
    const triage = () => findButton("Save triage", container)!.closest("form")!;
    const cause = () => triage().querySelector<HTMLTextAreaElement>("textarea")!;
    const editCause = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(cause(), value);
      cause().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await enter(triage().querySelector<HTMLInputElement>("input"), "operator-8");
    await enter(triage().querySelector<HTMLInputElement>('input[required]'), "Save initial diagnosis");
    await editCause("Submitted diagnosis");
    await click(findButton("Save triage", container));
    await waitUntil(() => Boolean(finishSave));
    await editCause("Later local evidence");
    await act(async () => finishSave());
    await waitUntil(() => !findButton("Save triage", container)!.disabled);
    expect(cause().value).toBe("Later local evidence");
    current = { ...current, ownerId: "operator-9", version: 9 };
    await act(async () => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)));
    expect(triage().querySelector<HTMLInputElement>("input")!.value).toBe("operator-9");
    expect(cause().value).toBe("Later local evidence");
  });

  it("lists each affected user and says how many occurrences could not be traced", async () => {
    await mountInspector();
    expect(adminV2Request).toHaveBeenCalledWith(
      `/api/v2/admin/incidents/${incident.id}`,
      expect.objectContaining({ schema: expect.any(Object) }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("customer-a");
    expect(text).toContain("customer-b");
    // 反查不到的那条必须自己出现，且不能被并进任何一个用户的计数。
    expect(text).toContain("could not be traced back to a user");
    expect(text).toContain("2 occurrences");
    expect(text).toContain("1 occurrences");
    expect(text).toContain("No customer record");
  });

  it("dates detail events against the server snapshot instead of the last incident update", async () => {
    adminV2Request.mockImplementation(async (path: string) =>
      path.startsWith("/api/v2/admin/incidents?") ? { ...list, asOf: "2026-09-29T12:32:00.000Z" } : detail,
    );
    await mountInspector();
    const seen = [...container.querySelectorAll("time")].filter((node) => node.dateTime === incident.lastSeenAt);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((node) => node.textContent?.includes("49 days ago"))).toBe(true);
  });

  it("links each affected user to their customer record", async () => {
    await mountInspector();
    expect(
      container.querySelector('a[href*="/admin/customers?search=customer-a"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('a[href*="/admin/customers?search=customer-b"]'),
    ).toBeNull();
  });
});

describe("IncidentWorkspace mitigation safety", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/ops/incidents");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    adminV2Request.mockReset();
    setWorkspaceUrl.mockReset();
    adminV2Request.mockImplementation(async (path: string) =>
      path.startsWith("/api/v2/admin/incidents?") ? list : detail,
    );
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(idempotencyKey);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("keeps the selected Incident and its own write lock when another Incident's preview finishes late", async () => {
    let completeFirst!: (value: unknown) => void, completeSecond!: (value: unknown) => void;
    let secondSaved = false;
    const second = { ...incident, id: "incident-2", suspectedCause: "Second Incident" };
    setWorkspaceUrl.mockImplementation((params: URLSearchParams, options: { pathname: string; mode: "push" | "replace" }) => {
      window.history[options.mode === "push" ? "pushState" : "replaceState"](null, "", `${options.pathname}?${params}`);
    });
    adminV2Request.mockImplementation(async (path: string) => {
      if (path.endsWith("incident-1/action-plans/preview")) return new Promise(resolve => { completeFirst = resolve; });
      if (path.endsWith("incident-2/action-plans/preview")) return new Promise(resolve => { completeSecond = resolve; });
      if (path.startsWith("/api/v2/admin/incidents?")) return { ...list, items: [incident, second] };
      if (path.endsWith("/incident-2")) return { ...detail, incident: { ...second, version: secondSaved ? 8 : 7 }, actionPlans: [] };
      return detail;
    });
    await act(async () => root.render(<IncidentWorkspace canManage initialIncidentId={incident.id} />));
    await waitUntil(() => findButton("Preview eligible scope", container) !== null);
    await click(findButton("Preview eligible scope", container));
    await waitUntil(() => Boolean(completeFirst));
    expect(collaborationPanel.mock.calls.at(-1)![0].canWrite).toBe(false);
    await click([...container.querySelectorAll<HTMLButtonElement>('[aria-label="Incident results"] button')].find(button => button.textContent?.includes("Second Incident"))!);
    await waitUntil(() => container.querySelector("#incident-detail-title")?.textContent === "Second Incident");
    expect(collaborationPanel.mock.calls.at(-1)![0].canWrite).toBe(true);
    await click(findButton("Preview eligible scope", container));
    await waitUntil(() => Boolean(completeSecond));
    const urlWrites = setWorkspaceUrl.mock.calls.length;
    const firstReads = adminV2Request.mock.calls.filter(([path]) => path === "/api/v2/admin/incidents/incident-1").length;
    await act(async () => completeFirst({ plan }));
    expect(window.location.pathname).toBe("/admin/ops/incidents/incident-2");
    expect(container.querySelector("#incident-detail-title")?.textContent).toBe("Second Incident");
    expect(setWorkspaceUrl).toHaveBeenCalledTimes(urlWrites);
    expect(adminV2Request.mock.calls.filter(([path]) => path === "/api/v2/admin/incidents/incident-1")).toHaveLength(firstReads);
    expect(findButton("Preview eligible scope", container)!.disabled).toBe(true);
    expect(collaborationPanel.mock.calls.at(-1)![0].canWrite).toBe(false);
    secondSaved = true;
    await act(async () => completeSecond({ plan }));
    await waitUntil(() => !findButton("Preview eligible scope", container)!.disabled);
    expect(collaborationPanel.mock.calls.at(-1)![0]).toMatchObject({ canWrite: true, targetId: "incident-2", targetVersion: 8 });
  });

  it("blocks collaboration while authoritative detail is stale even when its list refreshed successfully", async () => {
    let saved = false, failReadback = true;
    adminV2Request.mockImplementation(async (path: string) => {
      if (path.endsWith("/action-plans/preview")) { saved = true; return { plan }; }
      if (path.startsWith("/api/v2/admin/incidents?")) return list;
      if (saved && failReadback) throw new Error("Incident detail unavailable");
      return { ...detail, incident: { ...incident, version: saved ? 8 : 7 } };
    });
    await act(async () => root.render(<IncidentWorkspace canManage initialIncidentId={incident.id} />));
    await waitUntil(() => findButton("Preview eligible scope", container) !== null);
    await click(findButton("Preview eligible scope", container));
    await waitUntil(() => container.querySelector('[role="alert"]') !== null);
    expect(collaborationPanel.mock.calls.at(-1)![0]).toMatchObject({ canWrite: false, targetVersion: 7 });
    failReadback = false;
    await click(findButton("Retry", container));
    await waitUntil(() => collaborationPanel.mock.calls.at(-1)![0].canWrite);
    expect(collaborationPanel.mock.calls.at(-1)![0].targetVersion).toBe(8);
    expect(adminV2Request.mock.calls.filter(([path]) => path.endsWith("/action-plans/preview"))).toHaveLength(1);
  });

  it("keeps the new Incident confirmation open when the previous Incident's command finishes late", async () => {
    let completeFirst!: (value: unknown) => void;
    const second = { ...incident, id: "incident-2", suspectedCause: "Second Incident" };
    setWorkspaceUrl.mockImplementation((params: URLSearchParams, options: { pathname: string; mode: "push" | "replace" }) => {
      window.history[options.mode === "push" ? "pushState" : "replaceState"](null, "", `${options.pathname}?${params}`);
    });
    adminV2Request.mockImplementation(async (path: string) => {
      if (path.endsWith("/execute")) return new Promise(resolve => { completeFirst = resolve; });
      if (path.startsWith("/api/v2/admin/incidents?")) return { ...list, items: [incident, second] };
      if (path.endsWith("/incident-2")) return { ...detail, incident: second, actionPlans: [{ ...plan, id: "plan-2", incidentId: second.id }] };
      return detail;
    });
    await act(async () => root.render(<IncidentWorkspace canManage initialIncidentId={incident.id} />));
    await waitUntil(() => findButton("Execute frozen plan", container) !== null);
    await click(findButton("Execute frozen plan", container));
    const firstDialog = await waitForDialog();
    await enter(firstDialog.querySelector<HTMLInputElement>('input[aria-label="Execution confirmation"]'), "incident-1:plan-1:refund");
    await click(findButton("Execute frozen plan", firstDialog));
    await waitUntil(() => Boolean(completeFirst));
    await act(async () => {
      window.history.pushState(null, "", "/admin/ops/incidents/incident-2?incident=incident-2");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitUntil(() => container.querySelector("#incident-detail-title")?.textContent === "Second Incident");
    await click(findButton("Execute frozen plan", container));
    const secondDialog = await waitForDialog();
    await act(async () => completeFirst({ commandId: "command-a", state: "accepted" }));
    expect(document.querySelector('[role="dialog"]')).toBe(secondDialog);
    expect(secondDialog.textContent).toContain("incident-2:plan-2:refund");
    expect(window.location.pathname).toBe("/admin/ops/incidents/incident-2");
    expect(new URLSearchParams(window.location.search).has("commandId")).toBe(false);
    expect(adminV2Request.mock.calls.filter(([path]) => path.endsWith("/execute"))).toHaveLength(1);
  });

  it("shows the frozen plan's own money impact and blocks execution behind a modal confirmation", async () => {
    await act(async () => {
      root.render(<IncidentWorkspace canManage initialIncidentId={incident.id} />);
    });
    await waitUntil(() => findButton("Execute frozen plan", container) !== null);

    const inspector = container.querySelector<HTMLElement>('[aria-labelledby="incident-detail-title"]');
    const results = container.querySelector<HTMLElement>('[aria-label="Incident results"]');
    expect(inspector?.className).toContain("lg:sticky");
    expect(inspector?.parentElement?.className).toContain("lg:grid-cols");
    expect(inspector?.nextElementSibling).toBe(results);
    expect(results?.className).toContain("lg:order-first");

    // 冻结计划来自 detail.actionPlans，所以别的浏览器冻的那份在这里也看得见。
    expect(container.textContent).toContain("125,000 μ");
    expect(container.textContent).toContain("2 eligible");

    await click(findButton("Execute frozen plan", container));
    const dialog = await waitForDialog();
    // 后果是常驻红条，运营在敲确认串之前就读得到「没有回头路」。
    expect(dialog.textContent).toContain("This cannot be undone.");
    expect(dialog.textContent).toContain("This moves customer money across 2 occurrences");
    // 幂等键在打开对话框时就固定下来，失败后就地重试不会重复退款——这句话必须是真的。
    expect(dialog.textContent).toContain("reuses the same idempotency key");

    const submit = findButton("Execute frozen plan", dialog);
    expect(submit?.disabled).toBe(true);
    await enter(
      dialog.querySelector<HTMLInputElement>('input[aria-label="Execution confirmation"]'),
      `${incident.id}:${plan.id}:refund`,
    );
    expect(submit?.disabled).toBe(false);
    // 契约不收 reason，所以确认框不该多问一个会被丢弃的原因。
    expect(dialog.querySelector('input[aria-label="Reason (≥3)"]')).toBeNull();

    await click(submit);
    await waitUntil(() =>
      adminV2Request.mock.calls.some(([path]) => String(path).includes("/execute")),
    );
    const executeCall = adminV2Request.mock.calls.find(([path]) => String(path).includes("/execute"));
    // 键本身归 idempotency-key-lifecycle 管（那里有纯状态机测试），这里只问「带了没」。
    expect(executeCall?.[1]).toMatchObject({
      method: "POST",
      idempotencyKey,
      body: { entityVersion: incident.version, confirmation: `${incident.id}:${plan.id}:refund` },
    });
  });

  it("sends the idempotency key the preview authority requires", async () => {
    await act(async () => {
      root.render(<IncidentWorkspace canManage initialIncidentId={incident.id} />);
    });
    await waitUntil(() => findButton("Preview eligible scope", container) !== null);

    await click(findButton("Preview eligible scope", container));
    await waitUntil(() =>
      adminV2Request.mock.calls.some(([path]) => String(path).includes("/action-plans/preview")),
    );
    const previewCall = adminV2Request.mock.calls.find(([path]) =>
      String(path).includes("/action-plans/preview"),
    );
    expect(previewCall?.[1]).toMatchObject({ method: "POST", idempotencyKey });
  });
});

function findButton(label: string, root: ParentNode = document) {
  return (
    [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) =>
        button.getAttribute("aria-label") === label ||
        button.textContent?.trim() === label,
    ) ?? null
  );
}

async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull();
  await act(async () => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function enter(input: HTMLInputElement | null, value: string) {
  expect(input).not.toBeNull();
  await act(async () => {
    if (!input) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function waitForDialog() {
  await waitUntil(() => document.querySelector('[role="dialog"]') !== null);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error("Incident confirmation dialog did not mount");
  return dialog;
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for IncidentWorkspace state");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
