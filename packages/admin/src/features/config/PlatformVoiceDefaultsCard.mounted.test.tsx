// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Request } = vi.hoisted(() => ({ adminV2Request: vi.fn() }));

vi.mock("@/lib/admin-v2-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-v2-api")>();
  return { ...actual, adminV2Request };
});
vi.mock("@/components/admin/i18n", () => ({
  adminDateLocale: () => undefined,
  useAdminI18n: () => ({
    locale: "en" as const,
    t: (value: string, values?: Readonly<Record<string, string | number>>) =>
      Object.entries(values ?? {}).reduce((text, [key, replacement]) => text.replaceAll(`{${key}}`, String(replacement)), value),
    value: (value: string) => value,
  }),
}));

import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { PlatformVoiceDefaultsCard, type PlatformVoiceDefaultsPermissions } from "./PlatformVoiceDefaultsCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const delivery = { preset: "sensual", intensity: 0.6, speed: 1, temperature: 0.7, topP: 0.7, topK: 40, repetitionPenalty: 1.1 } as const;

function settings(overrides: Record<string, unknown> = {}) {
  return {
    provider: "fish_audio",
    source: "app_setting",
    settingVersion: 4,
    updatedAt: null,
    defaultVoiceId: "warm",
    genderVoiceIds: { female: "warm", male: "warm", trans: "warm" },
    delivery,
    catalog: ["warm", "another"].map((id) => ({ id, label: id, presentation: "unspecified", description: "Voice" })),
    ...overrides,
  };
}

const allowed: PlatformVoiceDefaultsPermissions = { read: true, write: true, preview: true };

describe("PlatformVoiceDefaultsCard", () => {
  let container: HTMLDivElement;
  let root: Root;
  let current = settings();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    current = settings();
    adminV2Request.mockReset();
    adminV2Request.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path === "/api/v2/admin/voice-defaults" && (options?.method ?? "GET") === "GET") return current;
      throw new Error(`Unexpected ${options?.method} ${path}`);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  async function render(permissions = allowed) {
    await act(async () => root.render(<PlatformVoiceDefaultsCard permissions={permissions} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  const button = (label: string) => [...document.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const dialogButton = (label: string) => [...(dialog()?.querySelectorAll("button") ?? [])].find((item) => item.textContent?.includes(label));
  async function chooseFallback(voiceId: string) {
    const select = container.querySelector<HTMLSelectElement>("#system-voice-default-global")!;
    await act(async () => {
      select.value = voiceId;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  function puts() {
    return adminV2Request.mock.calls.filter(([, options]) => options?.method === "PUT");
  }

  it("states the platform-wide, release-free blast radius before saving and sends no reason", async () => {
    await render();
    expect(container.textContent).toContain("Affects all characters");
    expect(container.textContent).toContain("does not go through a Character Release");
    expect(button("Save system defaults")?.disabled).toBe(true);
    await chooseFallback("another");
    adminV2Request.mockImplementationOnce(async () => ({ settings: settings({ settingVersion: 5, defaultVoiceId: "another" }), replayed: false }));
    await act(async () => button("Save system defaults")?.click());
    expect(puts()).toHaveLength(0);
    expect(dialog()?.textContent).toContain("It changes new speech for every character that has no voice override");
    expect(dialog()?.querySelector("input")).toBeNull();
    await act(async () => dialogButton("Save system defaults")?.click());
    expect(puts()).toHaveLength(1);
    const [path, options] = puts()[0]!;
    expect(path).toBe("/api/v2/admin/voice-defaults");
    expect(options.body).toEqual({
      expectedVersion: 4,
      provider: "fish_audio",
      defaultVoiceId: "another",
      genderVoiceIds: { female: "warm", male: "warm", trans: "warm" },
      delivery,
    });
    expect(options.body).not.toHaveProperty("reason");
  });

  it("keeps a failed save open and retries it with the same idempotency key", async () => {
    await render();
    await chooseFallback("another");
    await act(async () => button("Save system defaults")?.click());
    adminV2Request.mockImplementationOnce(async () => { throw new Error("Network interrupted"); });
    await act(async () => dialogButton("Save system defaults")?.click());
    expect(dialog()?.querySelector('[role="alert"]')).not.toBeNull();
    adminV2Request.mockImplementationOnce(async () => ({ settings: current, replayed: true }));
    await act(async () => dialogButton("Save system defaults")?.click());
    expect(puts()).toHaveLength(2);
    expect(puts()[1]?.[1].idempotencyKey).toBe(puts()[0]?.[1].idempotencyKey);
    expect(puts()[1]?.[1].body).toEqual(puts()[0]?.[1].body);
  });

  it("keeps the mapping read-only without generation config write", async () => {
    await render({ read: true, write: false, preview: true });
    const fields = [...container.querySelectorAll<HTMLSelectElement>("select")];
    expect(fields).toHaveLength(4);
    expect(fields.every((field) => field.disabled)).toBe(true);
    expect(button("Save system defaults")?.disabled).toBe(true);
  });

  it("keeps an open confirmation with an error when write permission is revoked", async () => {
    await render();
    await chooseFallback("another");
    await act(async () => button("Save system defaults")?.click());
    await render({ read: true, write: false, preview: true });
    await act(async () => dialogButton("Save system defaults")?.click());
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain("You no longer have permission");
    expect(puts()).toHaveLength(0);
  });

  it("preserves an edited draft when the authority version moves and requires an explicit reload", async () => {
    await render();
    await chooseFallback("another");
    current = settings({ settingVersion: 9 });
    await act(async () => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector<HTMLSelectElement>("#system-voice-default-global")?.value).toBe("another");
    expect(container.textContent).toContain("System defaults changed while you were editing.");
    expect(button("Save system defaults")?.disabled).toBe(true);
    await act(async () => button("Discard draft and load current defaults")?.click());
    expect(container.querySelector<HTMLSelectElement>("#system-voice-default-global")?.value).toBe("warm");
    expect(container.textContent).toContain("version 9");
  });

  it("previews a catalog voice with the draft delivery", async () => {
    await render();
    adminV2Request.mockImplementationOnce(async () => ({ voiceId: "warm", contentType: "audio/wav", audioBase64: "AAAA", durationMs: 10 }));
    const preview = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === "Preview warm")!;
    await act(async () => preview.click());
    const call = adminV2Request.mock.calls.find(([path]) => path === "/api/v2/admin/voice-defaults/preview");
    expect(call?.[1].body).toEqual(expect.objectContaining({ provider: "fish_audio", voiceId: "warm", delivery }));
    expect(container.querySelector('audio[aria-label="System voice preview"]')?.getAttribute("src")).toBe("data:audio/wav;base64,AAAA");
  });

  it("shows the advanced sampling controls for the Fish delivery editor", async () => {
    await render();
    expect(container.querySelectorAll('input[type="number"]')).toHaveLength(4);
  });

  it("does not read the authority without generation config read", async () => {
    await render({ read: false, write: false, preview: false });
    expect(adminV2Request).not.toHaveBeenCalled();
    expect(container.querySelector("select")).toBeNull();
  });
});
