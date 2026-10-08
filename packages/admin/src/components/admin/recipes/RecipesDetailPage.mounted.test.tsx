// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RecipesDetailPage } from "./RecipesDetailPage";
import { RecipesSection } from "./RecipesSection";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  window.history.replaceState(null, "", "/admin/generation/recipes/recipe-1");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

it("reloads recipe details through shell refresh without remounting an unfinished prompt", async () => {
  const recipe = {
    id: "recipe-1", recipeKey: "portrait", label: "Original recipe", mode: "image", useCase: "freeplay",
    body: "Original body", negativeBase: "blur", version: 1, status: "draft", sampleMatrix: [], dryRunSummary: null,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
  };
  const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async input =>
    Response.json({ ok: true, data: String(input).includes("/model-profiles") ? { items: [] } : { recipe } }));
  vi.stubGlobal("fetch", fetchMock);
  await act(async () => root.render(<RecipesDetailPage canWrite id={recipe.id} />));
  await waitFor(() => button("Edit recipe") !== undefined);
  await act(async () => button("Edit recipe")!.click());
  await changeInput(field("Body"), "Unfinished recipe prompt");
  let finish!: (response: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const href = window.location.href;
  await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
  expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith(`/recipes/${recipe.id}`))).toHaveLength(2);
  expect(field("Body").value).toBe("Unfinished recipe prompt");
  await act(async () => finish(Response.json({ ok: true, data: { recipe: { ...recipe, label: "Fresh recipe label" } } })));
  expect(field("Body").value).toBe("Unfinished recipe prompt");
  expect(window.location.href).toBe(href);
  expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
});

it.each([true, false])("recovers an initial recipe 503 with only reads (canWrite=%s)", async (canWrite) => {
  const recipe = {
    id: "recipe-1", recipeKey: "portrait", label: "Recovered recipe", mode: "image", useCase: "freeplay",
    body: "Saved recipe body", negativeBase: null, version: 1, status: "draft", sampleMatrix: [], dryRunSummary: null,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
  };
  const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async input =>
    Response.json({ ok: true, data: String(input).includes("/model-profiles") ? { items: [] } : { recipe } }));
  fetchMock.mockResolvedValueOnce(Response.json({ ok: false, error: { code: "unavailable", message: "Recipe read unavailable" } }, { status: 503 }));
  vi.stubGlobal("fetch", fetchMock);
  await act(async () => root.render(<RecipesDetailPage canWrite={canWrite} id={recipe.id} />));
  await waitFor(() => container.textContent?.includes("Recipe read unavailable") === true);
  expect(container.textContent).not.toContain("Recipe not found.");
  expect(container.textContent).toContain("Could not load recipe.");
  expect(button("Retry")).toBeDefined();
  await act(async () => button("Retry")!.click());
  await waitFor(() => container.textContent?.includes(recipe.label) === true);
  const detailReads = fetchMock.mock.calls.filter(([path]) => String(path) === `/api/v2/admin/generation/recipes/${recipe.id}`);
  expect(detailReads).toHaveLength(2);
  expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  expect(button("Retry")).toBeUndefined();
  expect(Boolean(button("Edit recipe"))).toBe(canWrite);
});

it("keeps a real recipe 404 distinct from a failed read", async () => {
  const fetchMock = vi.fn(async () => Response.json({ ok: false, error: { code: "not_found", message: "Recipe missing" } }, { status: 404 }));
  vi.stubGlobal("fetch", fetchMock);
  await act(async () => root.render(<RecipesDetailPage canWrite id="missing-recipe" />));
  await waitFor(() => container.textContent?.includes("Recipe missing") === true);
  expect(container.textContent).toContain("Recipe not found.");
  expect(container.textContent).not.toContain("Could not load recipe.");
  expect(button("Retry")).toBeUndefined();
  expect(container.querySelector('a[href="/admin/generation/recipes"]')).not.toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("guards Back and reload only for changed recipe input and keeps that input when leaving is cancelled", async () => {
  const recipe = {
    id: "recipe-1", recipeKey: "portrait", label: "Original recipe", mode: "image", useCase: "freeplay",
    body: "Original body", negativeBase: "blur", version: 1, status: "draft", sampleMatrix: [], dryRunSummary: null,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => Response.json({ ok: true, data: String(input).includes("/model-profiles") ? { items: [] } : { recipe } })));
  await act(async () => root.render(<RecipesDetailPage canWrite id={recipe.id} />));
  await waitFor(() => button("Edit recipe") !== undefined);
  await act(async () => button("Edit recipe")!.click());
  const back = container.querySelector<HTMLAnchorElement>('a[href="/admin/generation/recipes"]')!;
  const navigate = vi.fn((event: MouseEvent) => event.preventDefault()); back.addEventListener("click", navigate);
  await act(async () => back.click());
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await changeInput(field("Body"), "My unsaved prompt body");
  const reload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(reload);
  expect(reload.defaultPrevented).toBe(true);
  await act(async () => back.click());
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Discard unsaved changes?");
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node => node.textContent === "Cancel")!.click());
  expect(field("Body").value).toBe("My unsaved prompt body");
  await changeInput(field("Body"), recipe.body);
  await act(async () => back.click());
  expect(navigate).toHaveBeenCalledTimes(2);
  await changeInput(field("Body"), "Cancelled prompt body");
  await act(async () => button("Cancel")!.click());
  const cleanReload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(cleanReload);
  expect(cleanReload.defaultPrevented).toBe(false);
  expect(container.querySelector("textarea")).toBeNull();
});

it("keeps the same recipe draft through rerenders and never offers it as another recipe's edit", async () => {
  const recipe = {
    id: "recipe-1", recipeKey: "portrait", label: "Original recipe", mode: "image", useCase: "freeplay",
    body: "Original body", negativeBase: "blur", version: 1, status: "draft", sampleMatrix: [], dryRunSummary: null,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
  };
  const other = { ...recipe, id: "recipe-other", recipeKey: "landscape", label: "Other recipe", body: "Other recipe body" };
  const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async input => Response.json({ ok: true, data: String(input).includes("/model-profiles") ? { items: [] } : { recipe: String(input).includes(other.id) ? other : recipe } }));
  vi.stubGlobal("fetch", fetchMock);
  await act(async () => root.render(<RecipesSection canWrite view={{ kind: "detail", id: recipe.id }} />));
  await waitFor(() => button("Edit recipe") !== undefined);
  await act(async () => button("Edit recipe")!.click());
  await changeInput(field("Body"), "My unsaved first recipe body");
  await act(async () => root.render(<RecipesSection canWrite view={{ kind: "detail", id: recipe.id }} />));
  expect(field("Body").value).toBe("My unsaved first recipe body");
  await act(async () => root.render(<RecipesSection canWrite view={{ kind: "detail", id: other.id }} />));
  await waitFor(() => container.textContent?.includes(other.label) === true);
  expect(button("Save changes")).toBeUndefined();
  expect(container.querySelector("textarea")).toBeNull();
  expect(container.textContent).toContain(other.body);
  await act(async () => button("Edit recipe")!.click());
  expect(field("Body").value).toBe(other.body);
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("renames a draft without replacing configuration and verification fields absent from the editor", async () => {
  const recipe = {
    id: "recipe-1", recipeKey: "portrait", label: "Original recipe", mode: "image", useCase: "enhance",
    body: "portrait prompt", negativeBase: "blur", version: 1, status: "draft",
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    presetOrder: ["pose", "outfit"], safetyHints: { preserved: true }, sampleMatrix: [{ orientation: "1:1" }],
    dryRunSummary: { sampleCount: 20, configurationPassRate: 1 },
  };
  const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PATCH") Object.assign(recipe, JSON.parse(String(init.body)));
    return Response.json({ ok: true, data: { recipe } });
  });
  vi.stubGlobal("fetch", fetchMock);
  await act(async () => root.render(<RecipesDetailPage canWrite id={recipe.id} />));
  await waitFor(() => button("Edit recipe") !== undefined);
  await act(async () => button("Edit recipe")?.click());
  const label = [...container.querySelectorAll("label")].find(field => field.querySelector("span")?.textContent === "Label")?.querySelector("input");
  expect(label).toBeDefined();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(label, "Renamed recipe");
    label?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Save changes")?.click());
  await waitFor(() => fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH"));
  const write = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")?.[1];
  expect(JSON.parse(String(write?.body))).toEqual({
    recipeKey: "portrait", label: "Renamed recipe", mode: "image", useCase: "enhance", body: "portrait prompt", negativeBase: "blur",
  });
  expect(recipe.presetOrder).toEqual(["pose", "outfit"]);
  expect(recipe.dryRunSummary).toEqual({ sampleCount: 20, configurationPassRate: 1 });
});

it("freezes draft inputs until a pending recipe save settles", async () => {
  const recipe = {
    id: "recipe-pending", recipeKey: "portrait", label: "Original recipe", mode: "image", useCase: "freeplay",
    body: "Original body", negativeBase: "blur", version: 1, status: "draft", sampleMatrix: [], dryRunSummary: null,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
  };
  let finishWrite!: (response: Response) => void;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PATCH") return new Promise<Response>(resolve => { finishWrite = resolve; });
    return Response.json({ ok: true, data: String(input).includes("/model-profiles") ? { items: [] } : { recipe } });
  });
  vi.stubGlobal("fetch", fetchMock);
  await act(async () => root.render(<RecipesDetailPage canWrite id={recipe.id} />));
  await waitFor(() => button("Edit recipe") !== undefined);
  await act(async () => button("Edit recipe")!.click());
  await changeInput(field("Label"), "Saved pending label");
  await changeInput(field("Body"), "Saved pending body");
  await act(async () => button("Save changes")!.click());
  expect(field("Label").closest("fieldset")?.disabled).toBe(true);
  expect(field("Body").closest("fieldset")?.disabled).toBe(true);
  expect(button("Cancel")!.disabled).toBe(true);
  expect(button("Save changes")!.disabled).toBe(true);
  const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
  expect(writes).toHaveLength(1);
  const payload = JSON.parse(String(writes[0][1]?.body));
  expect(payload).toMatchObject({ label: "Saved pending label", body: "Saved pending body" });
  Object.assign(recipe, payload);
  await act(async () => finishWrite(Response.json({ ok: true, data: { recipe } })));
  await waitFor(() => container.textContent?.includes("Draft saved. Saved pending label") === true);
  expect(container.querySelector("input,textarea")).toBeNull();
  expect(container.textContent).toContain("Saved pending body");
});

it("keeps a failed recipe edit available for correction and retry", async () => {
  const recipe = {
    id: "recipe-retry", recipeKey: "portrait", label: "Original recipe", mode: "image", useCase: "freeplay",
    body: "Original body", negativeBase: "blur", version: 1, status: "draft", sampleMatrix: [], dryRunSummary: null,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
  };
  let rejectFirst = true;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      if (rejectFirst) {
        rejectFirst = false;
        return Response.json({ ok: false, error: { code: "unavailable", message: "Recipe write unavailable" } }, { status: 503 });
      }
      Object.assign(recipe, JSON.parse(String(init.body)));
    }
    return Response.json({ ok: true, data: String(input).includes("/model-profiles") ? { items: [] } : { recipe } });
  });
  vi.stubGlobal("fetch", fetchMock);
  await act(async () => root.render(<RecipesDetailPage canWrite id={recipe.id} />));
  await waitFor(() => button("Edit recipe") !== undefined);
  await act(async () => button("Edit recipe")!.click());
  await changeInput(field("Label"), "My failed label");
  await changeInput(field("Body"), "My pending body");
  await act(async () => button("Save changes")!.click());
  await waitFor(() => container.textContent?.includes("Recipe write unavailable") === true);
  expect(field("Label").value).toBe("My failed label");
  expect(field("Body").value).toBe("My pending body");
  expect(Boolean(field("Label").closest("fieldset")?.disabled)).toBe(false);
  expect(button("Save changes")!.disabled).toBe(false);
  expect(container.textContent).not.toContain("Draft saved.");
  await changeInput(field("Label"), "My corrected label");
  await act(async () => button("Save changes")!.click());
  await waitFor(() => container.textContent?.includes("Draft saved. My corrected label") === true);
  const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
  expect(writes).toHaveLength(2);
  expect(JSON.parse(String(writes[1][1]?.body))).toMatchObject({ label: "My corrected label", body: "My pending body" });
});

it("keeps a confirmed recipe write until a failed readback is retried, without offering another stale write", async () => {
  const recipe = {
    id: "recipe-readback", recipeKey: "portrait", label: "Original recipe", mode: "image", useCase: "freeplay",
    body: "Original body", negativeBase: "blur", version: 1, status: "draft", sampleMatrix: [], dryRunSummary: null,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
  };
  let committed = false;
  let failRead = true;
  const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async (input, init) => {
    if (String(input).includes("/model-profiles")) return Response.json({ ok: true, data: { items: [] } });
    if (init?.method === "PATCH") {
      committed = true;
      Object.assign(recipe, JSON.parse(String(init.body)), { version: 2 });
      return Response.json({ ok: true, data: { recipe } });
    }
    if (committed && failRead) return Response.json({ ok: false, error: { code: "unavailable", message: "Latest recipe read unavailable" } }, { status: 503 });
    return Response.json({ ok: true, data: { recipe } });
  });
  vi.stubGlobal("fetch", fetchMock);
  await act(async () => root.render(<RecipesDetailPage canWrite id={recipe.id} />));
  await waitFor(() => button("Edit recipe") !== undefined);
  await act(async () => button("Edit recipe")!.click());
  await changeInput(field("Label"), "My confirmed recipe");
  await changeInput(field("Body"), "My confirmed prompt body");
  await act(async () => button("Save changes")!.click());
  await waitFor(() => container.textContent?.includes("Latest recipe read unavailable") === true);
  expect(container.textContent).not.toContain("Draft saved.");
  expect(field("Label").value).toBe("My confirmed recipe");
  expect(field("Body").value).toBe("My confirmed prompt body");
  expect(field("Body").closest("fieldset")?.disabled).toBe(true);
  expect(button("Save changes")!.disabled).toBe(true);
  expect(button("Cancel")!.disabled).toBe(true);
  expect(container.textContent).toContain("Changes were saved, but the latest details could not be loaded.");
  await act(async () => button("Save changes")!.click());
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  const reload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(reload);
  expect(reload.defaultPrevented).toBe(false);
  await act(async () => root.render(<RecipesDetailPage canWrite={false} id={recipe.id} />));
  expect(button("Save changes")).toBeUndefined();
  expect(button("Publish")).toBeUndefined();
  recipe.label = "Latest authority recipe"; recipe.body = "Latest authority prompt"; recipe.version = 3;
  failRead = false;
  await act(async () => button("Retry")!.click());
  await waitFor(() => container.textContent?.includes(recipe.body) === true);
  expect(container.textContent).toContain(recipe.label);
  expect(container.querySelector("textarea")).toBeNull();
  expect(container.textContent).not.toContain("Latest recipe read unavailable");
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  await act(async () => root.render(<RecipesDetailPage canWrite id={recipe.id} />));
  await act(async () => button("Edit recipe")!.click());
  expect(field("Body").value).toBe(recipe.body);
});

it.each([true, false])("keeps the operator's test profile across matrix save, without substituting an unavailable profile (available=%s)", async (available) => {
  const recipe = {
    id: "recipe-profile-selection", recipeKey: "freeplay", label: "Draft matrix", mode: "image", useCase: "freeplay",
    body: "Operator template", negativeBase: null, version: 1, status: "draft",
    sampleMatrix: [{ prompt: "Original scene", orientation: "1:1" }], dryRunSummary: null,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
  };
  const profiles = [
    { id: "audit-batch-four", label: "Audit batch 4", mode: "image", status: "active", allowedOrientations: ["1:1"] },
    { id: "default-image", label: "Default image", mode: "image", status: "active", allowedOrientations: ["1:1"] },
  ];
  const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async (input, init) => {
    const path = String(input);
    if (path.includes("/model-profiles")) return Response.json({ ok: true, data: { items: profiles.filter(profile => recipe.version === 1 || available || profile.id === "audit-batch-four") } });
    if (path.includes("/preview")) return Response.json({ ok: true, data: {
      fingerprint: "a".repeat(64), profileId: new URL(path, "http://localhost").searchParams.get("profileId"),
      samples: recipe.sampleMatrix.map((sample, index) => ({ ...sample, index, negativePrompt: "", issues: [] })),
      issues: [], validation: { status: "not_run", issues: [], jobs: [] },
    } });
    if (init?.method === "PATCH") {
      Object.assign(recipe, JSON.parse(String(init.body)), { version: 2, updatedAt: "2026-09-01T00:01:00.000Z" });
    }
    if (path.endsWith("/commands/test-matrix")) return Response.json({ ok: true, data: { fingerprint: "a".repeat(64), jobs: [] } });
    return Response.json({ ok: true, data: { recipe } });
  });
  vi.stubGlobal("fetch", fetchMock);
  await act(async () => root.render(<RecipesDetailPage canWrite id={recipe.id} />));
  const profileSelect = () => [...container.querySelectorAll("label")]
    .find(label => label.querySelector("span")?.textContent === "Test profile")?.querySelector("select");
  await waitFor(() => profileSelect()?.value === "audit-batch-four");
  await act(async () => {
    profileSelect()!.value = "default-image";
    profileSelect()!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitFor(() => fetchMock.mock.calls.some(([path]) => String(path).includes("profileId=default-image")));
  await changeInput(field("Sample scene 1"), "Saved operator scene");
  await act(async () => button("Save sample matrix")?.click());
  await waitFor(() => recipe.version === 2 && profileSelect()?.options.length === 2);
  expect(profileSelect()?.value).toBe("default-image");
  if (!available) {
    expect(container.textContent).toContain("Selected test profile is unavailable. Choose an available profile before running samples.");
    expect(button("Run sample matrix")?.disabled).toBe(true);
    expect(button("Verify results")?.disabled).toBe(true);
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes("/commands/test-matrix"))).toBe(false);
    return;
  }
  await waitFor(() => button("Run sample matrix")?.disabled === false);
  await act(async () => button("Run sample matrix")?.click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Default image");
  expect(dialog.textContent).not.toContain("Audit batch 4");
  await confirm(dialog, "Run sample matrix");
  const create = fetchMock.mock.calls.find(([path]) => String(path).endsWith("/commands/test-matrix"));
  expect(JSON.parse(String(create?.[1]?.body))).toMatchObject({ profileId: "default-image" });
});

it("offers preview, real matrix jobs and result verification before publishing without a client-invented summary", async () => {
  const recipe = {
    id: "recipe-verified", recipeKey: "freeplay", label: "Freeplay recipe", mode: "image", useCase: "freeplay",
    body: "Operator template description", negativeBase: "blur", version: 1, status: "draft", sampleMatrix: [{ prompt: "Sunlit portrait", orientation: "1:1" }], dryRunSummary: null,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
  };
  let status = "not_run";
  const validation = () => ({ status, issues: [], jobs: status === "not_run" ? [] : [{ id: "recipe-sample-1", sampleIndex: 0, status: status === "running" ? "queued" : "completed", assetUrls: [] }] });
  const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async input => {
    const path = String(input);
    if (path.includes("/model-profiles")) return Response.json({ ok: true, data: { items: [{ id: "profile-1", label: "Production image profile", mode: "image", status: "active", allowedOrientations: ["1:1"] }] } });
    if (path.includes("/commands/test-matrix")) { status = "running"; return Response.json({ ok: true, data: { fingerprint: "a".repeat(64), jobs: validation().jobs } }); }
    if (path.includes("/commands/verify")) { status = "passed"; return Response.json({ ok: true, data: { validation: validation() } }); }
    if (path.includes("/commands/publish")) return Response.json({ ok: true, data: { recipe: { ...recipe, status: "active" } } });
    if (path.includes("/preview")) return Response.json({ ok: true, data: { fingerprint: "a".repeat(64), profileId: "profile-1", samples: [{ index: 0, prompt: "Compiled sunlit portrait", negativePrompt: "blur", orientation: "1:1", issues: [] }], issues: [], validation: validation() } });
    return Response.json({ ok: true, data: { recipe } });
  });
  vi.stubGlobal("fetch", fetchMock);
  await act(async () => root.render(<RecipesDetailPage canWrite id={recipe.id} />));
  await waitFor(() => button("Publish") !== undefined);
  expect(button("Publish")?.disabled).toBe(true);
  await waitFor(() => container.textContent?.includes("Compiled sunlit portrait") ?? false);
  await act(async () => button("Run sample matrix")?.click());
  let dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain("real generation");
  await confirm(dialog, "Run sample matrix");
  await waitFor(() => fetchMock.mock.calls.some(([path]) => String(path).includes("/commands/test-matrix")));
  status = "ready";
  await act(async () => button("Refresh results")?.click());
  await waitFor(() => button("Verify results")?.disabled === false);
  await act(async () => button("Verify results")?.click());
  dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
  await confirm(dialog, "Verify results");
  await waitFor(() => button("Publish")?.disabled === false);
  await act(async () => button("Publish")?.click());
  dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
  await confirm(dialog, "Publish");
  await waitFor(() => fetchMock.mock.calls.some(([path]) => String(path).includes("/commands/publish")));
  const write = fetchMock.mock.calls.find(([path]) => String(path).includes("/commands/publish"))?.[1];
  expect(JSON.parse(String(write?.body))).toEqual({ reason: "Verify the complete operator journey", confirmation: recipe.id });
});

async function confirm(dialog: HTMLElement, label: string) {
  const input = dialog.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Verify the complete operator journey");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const action = [...dialog.querySelectorAll("button")].find(button => button.textContent?.trim() === label)!;
  await act(async () => action.click());
}

function button(label: string) {
  return [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === label);
}

function field(label: string) {
  return [...container.querySelectorAll("label")].find(node => node.querySelector("span")?.textContent === label)!.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea")!;
}

async function changeInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
  throw new Error("Condition did not become true");
}
