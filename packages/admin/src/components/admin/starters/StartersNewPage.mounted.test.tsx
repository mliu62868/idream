// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminI18nProvider, translateAdmin } from "../i18n";
import { StartersNewPage } from "./StartersNewPage";
import { AdminV2RequestError } from "../api";

const { apiWrite } = vi.hoisted(() => ({ apiWrite: vi.fn() }));
vi.mock("../api", async (original) => ({ ...await original<typeof import("../api")>(), apiWrite }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("starter AI assist operator expectations", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    apiWrite.mockReset().mockResolvedValue({
      description: "A patient botanical curator.",
      nameIdeas: [],
      advancedDetails: { detailsMarkdown: "## Personality\nPatient", firstMessage: "Welcome to the conservatory.", visualBrief: "Green linen and warm light." },
    });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const field = (key: string) => [...container.querySelectorAll("label")].find(node => node.firstChild?.textContent === translateAdmin("zh", key))!.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea")!;

  it("describes the generated fields accurately and preserves operator tags and name", async () => {
    await act(async () => root.render(<AdminI18nProvider locale="zh"><StartersNewPage canWrite canAssist /></AdminI18nProvider>));
    await act(async () => {
      input(field("Inspiration"), "A 30-year-old botanical curator");
      input(field("Name (≥1)"), "Operator name");
      input(field("Tags (comma-separated, ≤12)"), "botanical, calm");
    });
    await act(async () => [...container.querySelectorAll("button")].find(node => node.textContent === translateAdmin("zh", "Generate with AI"))!.click());
    expect(field("Summary (≤200)").value).toBe("A patient botanical curator.");
    expect(field("Additional details · Markdown (optional)").value).toBe("## Personality\nPatient");
    expect(field("First message").value).toBe("Welcome to the conservatory.");
    expect(field("Art direction").value).toBe("Green linen and warm light.");
    expect(field("Tags (comma-separated, ≤12)").value).toBe("botanical, calm");
    expect(field("Name (≥1)").value).toBe("Operator name");
    expect(container.textContent).toContain("AI 自动填写摘要、角色细节、首条消息和视觉方向。");
    expect(container.textContent).not.toContain("AI 自动填充描述与标签");
    expect(apiWrite).toHaveBeenCalledTimes(1);
    expect(apiWrite).toHaveBeenCalledWith("/api/v2/admin/content/character-assist", "POST", {
      seed: "A 30-year-old botanical curator", includeNameIdeas: false,
    });
  });

  it("keeps the authoritative summary intact instead of cutting a sentence at the client limit", async () => {
    const description = "Mara is a 30-year-old botanical curator who tends a quiet conservatory, shares stories about rare orchids, and listens patiently to an adult companion. Her warmth has clear boundaries: affection is mutual, consent is explicit, and neither person is pressured to move faster than they choose.";
    apiWrite.mockResolvedValue({ description, advancedDetails: { detailsMarkdown: "## Boundaries\nMutual consent.", firstMessage: "Welcome.", visualBrief: "Green linen." } });
    await act(async () => root.render(<AdminI18nProvider locale="zh"><StartersNewPage canWrite canAssist /></AdminI18nProvider>));
    await act(async () => input(field("Inspiration"), "A 30-year-old botanical curator"));
    await act(async () => [...container.querySelectorAll("button")].find(node => node.textContent === translateAdmin("zh", "Generate with AI"))!.click());
    expect(field("Summary (≤200)").value).toBe(description);
  });

  it.each([
    ["AI text generation exceeded the summary character limit. Try a shorter seed", "AI 生成的摘要超过字数上限，请缩短灵感描述后重试。"],
    ["AI text generation reached its output limit before completing the draft. Try a shorter seed", "AI 生成在草稿完成前达到输出上限，请缩短灵感描述后重试。"],
    ["AI text generation is temporarily unavailable. Check the chat model connection and try again", "AI 文本生成暂时不可用，请检查聊天模型连接后重试。"],
  ])("shows the AI failure in Chinese and retains the operator draft: %s", async (message, chinese) => {
    apiWrite.mockRejectedValue(new AdminV2RequestError(message, 503, "unavailable", {
      stage: "description", requestId: "assist-parent-trace", modelRequestId: "assist-model-trace",
    }, "assist-http-trace"));
    await act(async () => root.render(<AdminI18nProvider locale="zh"><StartersNewPage canWrite canAssist /></AdminI18nProvider>));
    const draft = {
      "Name (≥1)": "Operator name",
      "Summary (≤200)": "Existing complete summary.",
      "Tags (comma-separated, ≤12)": "botanical, calm",
      "Additional details · Markdown (optional)": "Existing persona",
      "First message": "Existing greeting",
      "Art direction": "Existing art direction",
    };
    await act(async () => {
      input(field("Inspiration"), "A 30-year-old botanical curator");
      for (const [key, value] of Object.entries(draft)) input(field(key), value);
    });
    await act(async () => [...container.querySelectorAll("button")].find(node => node.textContent === translateAdmin("zh", "Generate with AI"))!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(chinese);
    const technical = container.querySelector('[role="alert"] details');
    expect(technical?.hasAttribute("open")).toBe(false);
    expect(technical?.querySelector("pre")?.textContent).toContain(message);
    expect(technical?.querySelector("pre")?.textContent).toContain("requestId: assist-http-trace");
    expect(technical?.querySelector("pre")?.textContent).toContain('"stage":"description"');
    expect(technical?.querySelector("pre")?.textContent).toContain('"modelRequestId":"assist-model-trace"');
    expect([...container.querySelectorAll("button")].some(node => node.textContent === translateAdmin("zh", "Retry"))).toBe(false);
    for (const [key, value] of Object.entries(draft)) expect(field(key).value).toBe(value);
    expect(apiWrite).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<AdminI18nProvider locale="en"><StartersNewPage canWrite canAssist /></AdminI18nProvider>));
    expect(container.querySelector('[role="alert"] > p')?.textContent).toBe(message);
    expect(apiWrite).toHaveBeenCalledTimes(1);
  });
});
