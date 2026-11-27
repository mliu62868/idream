"use client";

// SPEC: 声音交付参数与系统默认声音选择的展示控件 —— 只吃 props，不发请求。
// INTENT: 角色声音页（克隆交付参数、候选摘要）与平台配置页（全平台默认声音）共用同一套控件，
//         两边的取值范围与文案不能各写一份。
import {
  type CharacterWorkspaceDetail,
  type FishAudioDeliverySettings,
  type SystemVoiceCatalogVoiceId,
  type VoiceDefaultSettings,
} from "@idream/shared/admin";
import { INDEXTTS_VOICE_MODEL_ID } from "@idream/shared/contracts";
import { AudioLines, Play } from "lucide-react";
import { StatusBadge, WorkspaceButton, fieldClass } from "@/features/operations/WorkspaceUi";

export function VoiceDeliveryEditor({
  delivery,
  runtimeModel,
  disabled,
  onChange,
  t,
}: {
  delivery: FishAudioDeliverySettings;
  runtimeModel?: string | null;
  disabled: boolean;
  onChange: (value: FishAudioDeliverySettings) => void;
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  const presets = [
    { id: "sensual", label: "Sensual", description: "Low, breathy, magnetic" },
    {
      id: "intimate",
      label: "Intimate",
      description: "Soft, private, close-mic",
    },
    { id: "playful", label: "Playful", description: "Teasing, bright, lively" },
    {
      id: "confident",
      label: "Confident",
      description: "Assured, poised, commanding",
    },
    { id: "natural", label: "Natural", description: "Warm and conversational" },
  ] as const;

  return (
    <div className="space-y-5">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        {presets.map((preset) => {
          const selected = delivery.preset === preset.id;
          return (
            <button
              className={`min-h-20 rounded-lg border px-3 py-2 text-left transition ${
                selected
                  ? "border-[var(--ad-blue-text)] bg-[var(--ad-blue-bg)] text-[var(--ad-blue-text)]"
                  : "border-[var(--ad-border)] bg-[var(--ad-surface)] hover:border-[var(--ad-blue-text)]"
              }`}
              disabled={disabled}
              key={preset.id}
              onClick={() => onChange({ ...delivery, preset: preset.id })}
              type="button"
            >
              <span className="block text-sm font-semibold">
                {t(preset.label)}
              </span>
              <span className="mt-1 block text-xs leading-4 text-[var(--ad-text-muted)]">
                {t(preset.description)}
              </span>
            </button>
          );
        })}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
          <span className="flex items-center justify-between gap-3">
            {t("Attraction intensity")}
            <strong className="text-[var(--ad-text)]">
              {delivery.intensity}%
            </strong>
          </span>
          <input
            className="mt-2 w-full accent-[var(--ad-blue-text)]"
            disabled={disabled}
            max={100}
            min={0}
            onChange={(event) =>
              onChange({ ...delivery, intensity: Number(event.target.value) })
            }
            step={1}
            type="range"
            value={delivery.intensity}
          />
        </label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
          <span className="flex items-center justify-between gap-3">
            {t("Speaking pace")}
            <strong className="text-[var(--ad-text)]">
              {delivery.speed.toFixed(2)}×
            </strong>
          </span>
          <input
            className="mt-2 w-full accent-[var(--ad-blue-text)]"
            disabled={disabled}
            max={1.3}
            min={0.7}
            onChange={(event) =>
              onChange({ ...delivery, speed: Number(event.target.value) })
            }
            step={0.01}
            type="range"
            value={delivery.speed}
          />
        </label>
      </div>
      {runtimeModel === INDEXTTS_VOICE_MODEL_ID ? (
        <p className="border-t border-[var(--ad-border)] pt-3 text-xs leading-5 text-[var(--ad-text-muted)]">
          {t("IndexTTS uses fixed sampling. Saved advanced settings are retained for other models.")}
        </p>
      ) : (
        <details className="border-t border-[var(--ad-border)] pt-3">
          <summary className="cursor-pointer text-xs font-semibold text-[var(--ad-text-muted)]">
            {t("Advanced Fish sampling")}
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <DeliveryNumberField
              disabled={disabled}
              label={t("Temperature")}
              max={1.5}
              min={0.1}
              onChange={(temperature) => onChange({ ...delivery, temperature })}
              step={0.01}
              value={delivery.temperature}
            />
            <DeliveryNumberField
              disabled={disabled}
              label={t("Top P")}
              max={1}
              min={0.1}
              onChange={(topP) => onChange({ ...delivery, topP })}
              step={0.01}
              value={delivery.topP}
            />
            <DeliveryNumberField
              disabled={disabled}
              label={t("Top K")}
              max={100}
              min={1}
              onChange={(topK) => onChange({ ...delivery, topK })}
              step={1}
              value={delivery.topK}
            />
            <DeliveryNumberField
              disabled={disabled}
              label={t("Repetition penalty")}
              max={2}
              min={1}
              onChange={(repetitionPenalty) =>
                onChange({ ...delivery, repetitionPenalty })
              }
              step={0.01}
              value={delivery.repetitionPenalty}
            />
          </div>
        </details>
      )}
    </div>
  );
}

function DeliveryNumberField({
  disabled,
  label,
  max,
  min,
  onChange,
  step,
  value,
}: {
  disabled: boolean;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step: number;
  value: number;
}) {
  return (
    <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
      {label}
      <input
        className={`${fieldClass} mt-1`}
        disabled={disabled}
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
        step={step}
        type="number"
        value={value}
      />
    </label>
  );
}

export function VoiceDeliverySummary({
  delivery,
  t,
}: {
  delivery: FishAudioDeliverySettings;
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  return (
    <div className="mt-3 flex flex-wrap gap-2 text-xs">
      <span className="rounded-full bg-[var(--ad-blue-bg)] px-2.5 py-1 font-semibold text-[var(--ad-blue-text)]">
        {t(deliveryPresetLabel(delivery.preset))}
      </span>
      <span className="rounded-full bg-[var(--ad-surface)] px-2.5 py-1 text-[var(--ad-text-muted)]">
        {t("{value}% intensity", { value: delivery.intensity })}
      </span>
      <span className="rounded-full bg-[var(--ad-surface)] px-2.5 py-1 text-[var(--ad-text-muted)]">
        {delivery.speed.toFixed(2)}×
      </span>
    </div>
  );
}

export function VoiceDefaultSelect({
  active,
  busy,
  canPreview,
  disabled,
  catalog,
  inputId,
  label,
  onChange,
  onPreview,
  t,
  value,
}: {
  active: boolean;
  busy: SystemVoiceCatalogVoiceId | null;
  canPreview: boolean;
  disabled: boolean;
  catalog: VoiceDefaultSettings["catalog"];
  inputId: string;
  label: string;
  onChange: (value: SystemVoiceCatalogVoiceId) => void;
  onPreview: (value: SystemVoiceCatalogVoiceId) => Promise<void>;
  t: (key: string, values?: Record<string, string | number>) => string;
  value: SystemVoiceCatalogVoiceId;
}) {
  const selected = catalog.find((voice) => voice.id === value);
  return (
    <article
      className={`rounded-lg border p-3 transition-colors ${
        active
          ? "border-[var(--ad-blue-text)] bg-[var(--ad-blue-bg)]"
          : "border-[var(--ad-border)] bg-[var(--ad-surface)]"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <label
          className="text-xs font-semibold text-[var(--ad-text-muted)]"
          htmlFor={inputId}
        >
          {label}
        </label>
        {active ? <StatusBadge tone="good" value={t("used here")} /> : null}
      </div>
      <select
        className={`${fieldClass} mt-2`}
        id={inputId}
        disabled={disabled}
        onChange={(event) =>
          onChange(event.target.value as SystemVoiceCatalogVoiceId)
        }
        value={value}
      >
        {catalog.map((voice) => (
          <option key={voice.id} value={voice.id}>
            {t(voice.label)}
          </option>
        ))}
      </select>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-xs text-[var(--ad-text-muted)]">
          {selected ? t(selected.description) : "N/A"}
        </span>
        <WorkspaceButton
          aria-label={t("Preview {voice}", {
            voice: selected?.label ?? value,
          })}
          disabled={!canPreview || busy !== null}
          onClick={() => void onPreview(value)}
          type="button"
        >
          {busy === value ? (
            <AudioLines aria-hidden="true" className="h-4 w-4 animate-pulse" />
          ) : (
            <Play aria-hidden="true" className="h-4 w-4" />
          )}
          {busy === value ? t("Rendering…") : t("Preview")}
        </WorkspaceButton>
      </div>
    </article>
  );
}

export function deliveryPresetLabel(preset: FishAudioDeliverySettings["preset"]) {
  return {
    sensual: "Sensual",
    intimate: "Intimate",
    playful: "Playful",
    confident: "Confident",
    natural: "Natural",
  }[preset];
}

export function voiceProviderLabel(
  provider: CharacterWorkspaceDetail["voice"]["provider"],
  model?: string | null,
) {
  if (provider === "pocket_tts") return "Pocket TTS";
  if (provider === "fish_audio") {
    if (model === INDEXTTS_VOICE_MODEL_ID) return "IndexTTS 2.5";
    if (model?.startsWith("ming-")) return "Ming 3.0 TTS";
    if (model?.startsWith("breeze-")) return "Breeze TTS 2";
    return model ?? "Local voice";
  }
  return provider;
}
