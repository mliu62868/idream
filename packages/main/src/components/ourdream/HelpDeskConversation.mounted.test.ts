// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HelpDeskHistoryPanel } from "./HelpDeskWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ticket = { id: "ticket-row", ticketId: "SUP-REPLY", category: "bug", subject: "Cannot save image", status: "waiting_on_user", createdAt: "2026-09-02T12:00:00.000Z", updatedAt: "2026-09-02T12:00:00.000Z", resolution: null };
const conversation = { ticketId: ticket.ticketId, subject: ticket.subject, description: "My download failed.", status: ticket.status, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt, canReply: true, messages: [{ id: "question", author: "support", body: "Which image failed?", createdAt: ticket.createdAt }] };
const envelope = (data: unknown) => Response.json({ ok: true, data });
async function settle() { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }

describe("Help Desk support conversation", () => {
  let root: Root;
  let container: HTMLDivElement;
  let viewer: string;
  let failReply: boolean;
  let writes: Array<{ messageId: string; body: string }>;
  beforeEach(() => {
    viewer = "customer"; failReply = false; writes = [];
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/me") return envelope({ user: { id: viewer }, anonymousId: null });
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)); writes.push(body);
        if (failReply) return Response.json({ ok: false, error: { message: "Please retry the connection." } }, { status: 503 });
        return envelope({ request: { ...conversation, status: "open", messages: [...conversation.messages, { id: "reply", author: "customer", body: body.body, createdAt: ticket.createdAt }] }, replayed: false });
      }
      return envelope({ request: conversation });
    }));
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function mount(scope = "user:customer") {
    await act(async () => root.render(createElement(HelpDeskHistoryPanel, {
      key: scope, viewerScope: scope, authenticated: true, error: "", loading: false,
      history: { supportRequests: [ticket], reports: [], appeals: [] }, onRefresh: vi.fn(),
    })));
    await settle();
  }
  async function click(label: string) {
    const button = [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
    expect(button, label).toBeDefined(); await act(async () => button!.click()); await settle();
  }
  async function type(value: string) {
    const textarea = container.querySelector("textarea")!;
    expect(textarea).not.toBeNull();
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
  }
  it("reads the support question, retains a failed draft and retries with the same message identity", async () => {
    await mount(); await click("View conversation");
    expect(container.textContent).toContain("Which image failed?");
    await type("Image ABC in my gallery."); failReply = true;
    await click("Send reply");
    expect(container.textContent).toContain("Please retry the connection.");
    expect(container.querySelector("textarea")?.value).toBe("Image ABC in my gallery.");
    failReply = false; await click("Send reply");
    expect(writes).toHaveLength(2); expect(writes[1].messageId).toBe(writes[0].messageId);
    expect(container.textContent).toContain("Image ABC in my gallery.");
    expect(container.querySelector("textarea")?.value).toBe("");
  });
  it("refreshes the parent ticket status after reading an operator resolution", async () => {
    let resolved = false;
    const originalFetch = fetch;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/v1/support/requests/") && !init?.method) {
        return Promise.resolve(envelope({ request: { ...conversation, status: resolved ? "resolved" : ticket.status, canReply: !resolved } }));
      }
      return originalFetch(input, init);
    }));
    function History() {
      const [status, setStatus] = useState(ticket.status);
      return createElement(HelpDeskHistoryPanel, {
        viewerScope: "user:customer", authenticated: true, error: "", loading: false,
        history: { supportRequests: [{ ...ticket, status }], reports: [], appeals: [] },
        onRefresh: () => setStatus(resolved ? "resolved" : ticket.status),
      });
    }
    await act(async () => root.render(createElement(History)));
    await settle(); await click("View conversation");
    resolved = true;
    await click("Refresh conversation");
    expect(container.textContent).toContain("Status: resolved");
    expect([...container.querySelectorAll("span")].some((node) => node.textContent === "Resolved")).toBe(true);
    expect(container.querySelector("textarea")).toBeNull();
  });
  it("clears a reply draft when the signed-in customer changes before submission", async () => {
    await mount(); await click("View conversation"); await type("Private account detail");
    viewer = "another-customer";
    await click("Send reply");
    expect(writes).toHaveLength(0);
    expect(container.textContent).not.toContain("Which image failed?");
    expect(container.querySelector("textarea")?.value ?? "").toBe("");
    expect(container.textContent).toContain("Your account changed");
  });
  it("settles a pending reply after a same-account history refresh", async () => {
    const originalFetch = fetch;
    let complete!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { complete = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => init?.method === "POST" ? pending : originalFetch(input, init)));
    await mount(); await click("View conversation"); await type("Image from the first page."); await click("Send reply");
    await mount();
    complete(envelope({ request: { ...conversation, messages: [...conversation.messages, { id: "late-reply", author: "customer", body: "Image from the first page.", createdAt: ticket.createdAt }] }, replayed: false }));
    await settle();
    expect(container.querySelector("textarea")?.value).toBe("");
    expect(container.querySelector("textarea")?.disabled).toBe(false);
    expect(container.textContent).toContain("Image from the first page.");
  });
  it("does not insert a late reply after the account panel is replaced", async () => {
    const originalFetch = fetch;
    let complete!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { complete = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => init?.method === "POST" ? pending : originalFetch(input, init)));
    await mount(); await click("View conversation"); await type("Previous customer's private reply"); await click("Send reply");
    viewer = "new-customer"; await mount("user:new-customer");
    complete(envelope({ request: { ...conversation, messages: [{ id: "late-reply", author: "customer", body: "Previous customer's private reply", createdAt: ticket.createdAt }] }, replayed: false }));
    await settle();
    expect(container.textContent).not.toContain("Previous customer's private reply");
    expect(container.querySelector("textarea")).toBeNull();
  });
});
