// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Request } = vi.hoisted(() => ({ adminV2Request: vi.fn() }));
vi.mock("@/lib/admin-v2-api", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/admin-v2-api")>(), adminV2Request }));
import { IncidentPlanCommand } from "./IncidentWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Incident plan execution receipt", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    vi.useFakeTimers(); adminV2Request.mockReset();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

  it("shows actual command stages and retries terminal projection failure without replaying execution", async () => {
    let status = "accepted";
    const onSettled = vi.fn().mockRejectedValueOnce(new Error("read unavailable")).mockResolvedValue(undefined);
    adminV2Request.mockImplementation(async () => ({ commandId: "command-real", commandType: "incident.action_plan.execute", target: { type: "incident_action_plan", id: "plan-real" }, status }));
    await act(async () => root.render(<IncidentPlanCommand commandId="command-real" planIds={["plan-real"]} onSettled={onSettled} />));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(container.querySelector("span")?.textContent).toBe("accepted");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/admin/system/audit?commandId=command-real");
    expect(onSettled).not.toHaveBeenCalled();
    status = "verifying";
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(container.querySelector("span")?.textContent).toBe("verifying");
    expect(onSettled).not.toHaveBeenCalled();
    status = "failed";
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(container.querySelector("span")?.textContent).toBe("failed");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    const reads = adminV2Request.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(adminV2Request).toHaveBeenCalledTimes(reads);
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Retry")!.click());
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(adminV2Request.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
  });

  it("rejects a command belonging to another plan instead of showing its success", async () => {
    const onSettled = vi.fn();
    adminV2Request.mockResolvedValue({ commandId: "command-real", commandType: "incident.action_plan.execute", target: { type: "incident_action_plan", id: "another-plan" }, status: "succeeded" });
    await act(async () => root.render(<IncidentPlanCommand commandId="command-real" planIds={["plan-real"]} onSettled={onSettled} />));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain("succeeded");
    expect(onSettled).not.toHaveBeenCalled();
  });
});
