// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/admin-v2-api", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/admin-v2-api")>(), adminV2Request: request }));
import { AdminI18nProvider } from "@/components/admin/i18n";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { VoiceCallHistory } from "./VoiceCallHistory";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
beforeEach(async () => { request.mockReset(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); await act(async () => root.render(createElement(VoiceCallHistory, { characterId: "character" }))); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function load() { await act(async () => (container.querySelector("button") as HTMLButtonElement).click()); }
it("loads persisted Call duration, unique costs and linked Turn/Voice evidence", async () => {
  request.mockResolvedValue({ items: [{ id: crypto.randomUUID(), sessionId: "session", characterId: "character", userId: "customer", status: "ended", language: "en", leaseToken: "",
    leaseExpiresAt: new Date().toISOString(), deadlineAt: new Date().toISOString(), startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), settledAt: new Date().toISOString(),
    connectedMs: 12_000, voiceDurationMs: 2000, costDreamcoins: 2, maxCostDreamcoins: 4, endReason: "user_ended", provider: "pocket_tts",
    utterances: [{ id: "utterance", turnId: "canonical-turn", replyAttempt: 1, status: "delivered", voiceRequestId: "canonical-voice", mediaAssetId: "audio-asset", durationMs: 2000, costDreamcoins: 2, errorCode: null }] }] });
  await load();
  expect(request).toHaveBeenCalledWith(expect.stringContaining("/characters/character/voice-calls"), expect.anything());
  expect(container.textContent).toContain("12.0s"); expect(container.textContent).toContain("2/4 coins");
  expect(container.textContent).toContain("canonical-turn"); expect(container.textContent).toContain("canonical-voice"); expect(container.textContent).toContain("audio-asset");
});
it("shows request failure and keeps it distinct from an empty history", async () => {
  request.mockRejectedValue(new Error("Call history request failed")); await load();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Call history request failed");
  expect(container.textContent).not.toContain("No voice calls");
  request.mockResolvedValue({ items: [] }); await load();
  expect(container.querySelector('[role="alert"]')).toBeNull(); expect(container.textContent).toContain("No voice calls for this Character");
});
it("translates operator labels while preserving canonical Call and delivery evidence", async () => {
  await act(async () => root.render(<AdminI18nProvider locale="zh"><VoiceCallHistory characterId="character" /></AdminI18nProvider>));
  request.mockResolvedValue({ items: [{ id: "canonical-call", sessionId: "canonical-session", userId: "canonical-user", status: "ended", startedAt: new Date().toISOString(),
    connectedMs: 12_000, voiceDurationMs: 2000, costDreamcoins: 2, maxCostDreamcoins: 4, provider: "pocket_tts", language: "en", endReason: "user_ended", settledAt: null,
    utterances: [{ id: "utterance", turnId: "canonical-turn", replyAttempt: 1, status: "delivered", voiceRequestId: "canonical-voice", mediaAssetId: "canonical-asset", durationMs: 2000, costDreamcoins: 2, errorCode: null }] }] });
  await load();
  expect(container.textContent).toContain("语音通话记录");
  expect(container.textContent).toContain("2/4 梦币");
  expect(container.textContent).toContain("通话: canonical-call");
  expect(container.textContent).toContain("用户: canonical-user");
  expect(container.textContent).toContain("会话: canonical-session");
  expect(container.textContent).toContain("对话轮次 canonical-turn · 尝试 1 · 声音 canonical-voice · 素材 canonical-asset");
  expect(container.textContent).toContain("未结算");
});

it("gives read recovery without exposing raw authority errors in the default message", async () => {
  request.mockRejectedValue(new AdminV2RequestError("Internal voice endpoint failure", 503, "unavailable", undefined, "voice-read-id"));
  await load();
  const alert = container.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("Retry to load the latest data.");
  expect(alert.textContent).not.toContain("whether the write landed is unknown");
  expect(alert.querySelector("details")?.open).toBe(false);
  expect(alert.querySelector("details")?.textContent).toContain("voice-read-id");
  expect(alert.querySelector("details")?.textContent).toContain("Internal voice endpoint failure");
  request.mockResolvedValue({ items: [] });
  await act(async () => alert.querySelector<HTMLButtonElement>("button")!.click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("No voice calls for this Character");
});

it("localizes Call states, dates and amounts while folding provider codes into engineering details", async () => {
  await act(async () => root.render(<AdminI18nProvider locale="zh"><VoiceCallHistory characterId="character" /></AdminI18nProvider>));
  request.mockResolvedValue({ items: [{ id: "localized-call", sessionId: "session", userId: "customer", status: "ended", startedAt: "2026-10-04T12:00:00.000Z",
    connectedMs: 12_000, voiceDurationMs: 2000, costDreamcoins: 1200, maxCostDreamcoins: 5000, provider: "pocket_tts", language: "en", endReason: "user_ended", settledAt: "2026-10-04T12:04:00.000Z",
    utterances: [{ id: "utterance", turnId: "turn", replyAttempt: 1, status: "delivered", voiceRequestId: "voice", mediaAssetId: "asset", durationMs: 2000, costDreamcoins: 1200, errorCode: "voice_provider_busy" }] }] });
  await load();
  const history = container.querySelector("details")!;
  const summary = history.querySelector("summary")!;
  expect(summary.textContent).toContain("已结束");
  expect(summary.textContent).toContain("2026年10月4日");
  expect(summary.textContent).toContain("1,200/5,000 梦币");
  expect(history.textContent).toContain("已交付");
  expect(history.textContent).not.toContain("2026-10-04T12:04:00.000Z");
  const technical = history.querySelector("details")!;
  expect(technical.open).toBe(false);
  expect(technical.textContent).toContain("user_ended");
  expect(technical.textContent).toContain("voice_provider_busy");
});
