// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceInputController } from "@/hooks/useVoiceInput";
import type { VoiceCallController } from "@/hooks/useVoiceCall";
import { VoiceInputButton, VoiceInputStatus } from "./VoiceInputControls";
import { VoiceCallButton, VoiceCallControls } from "./VoiceCallControls";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function voiceInput(overrides: Partial<VoiceInputController> = {}): VoiceInputController {
  return {
    phase: "idle", elapsedMs: 0, volume: 0, notice: null, candidate: null, canRetry: false,
    capability: { supported: true, available: true, ownerScope: "user:voice-owner", languages: ["en", "fr"], maxDurationMs: 60_000, maxUploadBytes: 8_388_608, resultTtlMs: 120_000 },
    start: vi.fn(async () => undefined), finish: vi.fn(), cancel: vi.fn(), addCandidate: vi.fn(), refreshCapability: vi.fn(),
    retry: vi.fn(), transcribeClip: vi.fn(), blocksSend: false, readOnly: false, canUndo: false, undo: vi.fn(),
    ...overrides,
  };
}

function voiceCall(overrides: Partial<VoiceCallController> = {}): VoiceCallController {
  return {
    phase: "listening", available: true, active: true, balance: 10, quote: null, otherCallSessionId: null, notice: null, microphoneActive: false, microphonePaused: false,
    call: { id: "11111111-1111-4111-8111-111111111111", sessionId: "session", characterId: "character", status: "active", language: "en", leaseToken: "owned-lease", leaseExpiresAt: "2026-10-02T12:00:15.000Z", deadlineAt: "2026-10-02T12:03:00.000Z", startedAt: "2026-10-02T12:00:00.000Z", endedAt: null, connectedMs: 0, maxCostDreamcoins: 2, costDreamcoins: 0, voiceDurationMs: 0, endReason: null },
    prepare: vi.fn(async () => undefined), connect: vi.fn(async () => undefined), end: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined),
    toggleMute: vi.fn(async () => undefined), refresh: vi.fn(async () => undefined), cancelQuote: vi.fn(), resume: vi.fn(async () => undefined), submitRecording: vi.fn(), retry: vi.fn(),
    finishSentence: vi.fn(), discardSentence: vi.fn(), ...overrides,
  };
}

describe("recording scope and upload guidance", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  async function input(voice: VoiceInputController) {
    await act(async () => root.render(createElement("div", {}, createElement(VoiceInputStatus, { voice }), createElement(VoiceInputButton, { voice, disabled: false }))));
  }

  it("explains actual capability languages and editable drafts before recording, without a language picker", async () => {
    const voice = voiceInput(); await input(voice);
    expect(container.textContent).toContain("English"); expect(container.textContent).toContain("French");
    expect(container.textContent).toContain("editable draft"); expect(container.textContent).toContain("before sending");
    expect(container.querySelector("select")).toBeNull(); expect(voice.start).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Voice input"]')?.getAttribute("title")).toContain("French");
    await input(voiceInput({ capability: { ...voice.capability!, languages: ["en", "de"] } }));
    expect(container.textContent).toContain("German"); expect(container.textContent).not.toContain("French");
  });

  it("retains scope and review guidance while recording with the existing Done and Cancel controls", async () => {
    const voice = voiceInput({ phase: "recording", notice: "Recording…", blocksSend: true, readOnly: true }); await input(voice);
    expect(container.textContent).toContain("English"); expect(container.textContent).toContain("French");
    expect(container.textContent).toContain("editable draft"); expect(container.textContent).toContain("before sending");
    const done = [...container.querySelectorAll("button")].find(button => button.textContent === "Done")!;
    await act(async () => done.click()); expect(voice.finish).toHaveBeenCalledOnce();
    const cancel = [...container.querySelectorAll("button")].find(button => button.textContent === "Cancel")!;
    await act(async () => cancel.click()); expect(voice.cancel).toHaveBeenCalledOnce();
  });

  it("keeps idle guidance to one collapsed line and spreads the transcript note once the microphone is in use", async () => {
    await input(voiceInput());
    const note = [...container.querySelectorAll("p")].filter(p => p.textContent?.includes("editable draft"));
    expect(note).toHaveLength(1); expect(note[0].closest("details")).not.toBeNull();
    await input(voiceInput({ phase: "review", candidate: "hello there" }));
    expect([...container.querySelectorAll("p")].some(p => p.textContent?.includes("editable draft") && !p.closest("details"))).toBe(true);
  });

  it("does not expose recording controls before a supported capability is known", async () => {
    await input(voiceInput({ capability: null })); expect(container.textContent).toBe(""); expect(container.querySelector("button")).toBeNull();
  });

  it("limits the Call chooser to existing decoder containers and explains English, duration and size", async () => {
    await act(async () => root.render(createElement(VoiceCallControls, { voice: voiceCall(), disabled: false, open: false, onClose: vi.fn() })));
    const field = container.querySelector<HTMLInputElement>('[aria-label="Send English call recording"]')!;
    const formats = field.accept.split(",");
    for (const extension of [".wav", ".flac", ".mp3", ".ogg", ".m4a", ".mp4", ".mov", ".mkv", ".webm", ".aac"]) expect(formats).toContain(extension);
    for (const unsupported of ["audio/*", ".aiff", ".caf", ".amr", ".wma"]) expect(formats).not.toContain(unsupported);
    const help = document.getElementById(field.getAttribute("aria-describedby")!)!;
    expect(help.textContent).toContain("English"); expect(help.textContent).toContain("WAV"); expect(help.textContent).toContain("60 seconds"); expect(help.textContent).toContain("8 MiB");
    expect(container.textContent).toContain("English · turn-based");
  });

  it("keeps an idle call to a composer button and forces the panel open once a call or price is under way", async () => {
    const idle = voiceCall({ phase: "idle", active: false, call: null });
    const onToggle = vi.fn(); const onClose = vi.fn();
    const render = async (voice: VoiceCallController, open: boolean) => act(async () => root.render(createElement("div", {},
      createElement(VoiceCallControls, { voice, disabled: false, open, onClose }), createElement(VoiceCallButton, { voice, open, onToggle }))));
    await render(idle, false);
    expect(container.querySelector('[aria-label="Voice call"][id]')).toBeNull();
    expect(container.textContent).not.toContain("Review call price");
    const entry = container.querySelector<HTMLButtonElement>('button[aria-label="Voice call"]')!;
    expect(entry.getAttribute("aria-expanded")).toBe("false");
    await act(async () => entry.click()); expect(onToggle).toHaveBeenCalledOnce();
    await render(idle, true);
    expect(container.textContent).toContain("Review call price");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Hide voice call"]')!.click()); expect(onClose).toHaveBeenCalledOnce();
    // Mid-call (or with a price awaiting acceptance) the controls cannot be hidden.
    await render(voiceCall(), false);
    expect(container.textContent).toContain("End call");
    expect(container.querySelector('[aria-label="Hide voice call"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Voice call"]')!.disabled).toBe(true);
    await render(voiceCall({ phase: "idle", active: false, call: null, quote: { allowanceMinutes: 0, costPerReply: 1, maxCostDreamcoins: 2 } as VoiceCallController["quote"] }), false);
    expect(container.textContent).toContain("Accept & connect microphone");
    // Unavailable voice: no entry at all.
    await render(voiceCall({ phase: "idle", active: false, call: null, available: false }), false);
    expect(container.querySelector("button")).toBeNull();
  });

  it("passes the original selected recording through the existing Call controller", async () => {
    const voice = voiceCall(); await act(async () => root.render(createElement(VoiceCallControls, { voice, disabled: false, open: false, onClose: vi.fn() })));
    const file = new File(["recorded speech"], "greeting.mp3", { type: "audio/mpeg" });
    const field = container.querySelector<HTMLInputElement>('[aria-label="Send English call recording"]')!;
    Object.defineProperty(field, "files", { value: [file], configurable: true });
    await act(async () => field.dispatchEvent(new Event("change", { bubbles: true })));
    expect(voice.submitRecording).toHaveBeenCalledExactlyOnceWith(file); expect(field.value).toBe("");
  });
});
