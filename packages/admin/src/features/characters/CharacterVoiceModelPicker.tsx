"use client";

import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { ListMusic, Mic } from "lucide-react";
import type { ReactNode } from "react";
import { useAdminI18n } from "@/components/admin/i18n";
import { voiceProviderLabel } from "@/features/voice/VoiceSettingsControls";
import { cn } from "@/lib/utils";
import {
  cloneStatusDetail,
  engineLabel,
  modelStatusLabel,
  officialStatusDetail,
  type ModelStatus,
  type Translate,
  type VoiceModel,
} from "./character-voice-model";

// SPEC: 「换声音」的第一步：官方声音（即时试听、一键应用）还是克隆（二级能力）。
export function CharacterVoiceModelPicker({
  data,
  model,
  officialStatus,
  cloneStatus,
  onSelect,
}: {
  data: CharacterWorkspaceDetail;
  model: VoiceModel;
  officialStatus: ModelStatus;
  cloneStatus: ModelStatus;
  onSelect: (model: VoiceModel) => void;
}) {
  const { t } = useAdminI18n();
  const voice = data.voice;
  return (
    <fieldset className="px-5 pt-5 sm:px-6">
      <legend className="sr-only">{t("Model")}</legend>
      <div className="grid gap-3 md:grid-cols-2">
        <ModelOption
          checked={model === "official"}
          description={t("{count} official English female voices. Listen instantly and apply in one step.", {
            count: voice.presetRuntime.catalogVoiceIds.length,
          })}
          detail={officialStatusDetail(officialStatus)}
          engine={voice.provider === "pocket_tts" ? engineLabel(voice) : null}
          icon={<ListMusic aria-hidden="true" className="h-5 w-5" />}
          id="voice-model-official"
          kind={t("Official voices")}
          name="Pocket TTS"
          onSelect={() => onSelect("official")}
          status={officialStatus}
          t={t}
        />
        <ModelOption
          checked={model === "clone"}
          description={t("Upload a reference recording to clone a dedicated voice, then listen before activating it.")}
          detail={cloneStatusDetail(voice.provider, cloneStatus)}
          engine={voice.provider === "fish_audio" ? engineLabel(voice) : null}
          icon={<Mic aria-hidden="true" className="h-5 w-5" />}
          id="voice-model-clone"
          kind={t("Voice cloning")}
          name={voice.provider === "mock" ? t("Voice cloning") : voiceProviderLabel(voice.provider, voice.runtimeModel)}
          onSelect={() => onSelect("clone")}
          status={cloneStatus}
          t={t}
        />
      </div>
    </fieldset>
  );
}

function ModelOption({
  checked,
  description,
  detail,
  engine,
  icon,
  id,
  kind,
  name,
  onSelect,
  status,
  t,
}: {
  checked: boolean;
  description: string;
  detail: string | null;
  engine: string | null;
  icon: ReactNode;
  id: string;
  kind: string;
  name: string;
  onSelect: () => void;
  status: ModelStatus;
  t: Translate;
}) {
  const disabled = status === "inactive";
  return (
    <label
      className={cn(
        "relative flex cursor-pointer gap-3 rounded-lg border p-4 transition-[border-color,box-shadow] duration-150 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-[var(--ad-ink)]",
        checked
          ? "border-[var(--ad-ink)] shadow-[inset_0_0_0_1px_var(--ad-ink)]"
          : "border-[var(--ad-border)] hover:border-[#bdbbb3]",
        disabled && "cursor-not-allowed opacity-60 hover:border-[var(--ad-border)]",
      )}
      htmlFor={id}
    >
      <input
        checked={checked}
        className="sr-only"
        disabled={disabled}
        id={id}
        name="character-voice-model"
        onChange={onSelect}
        type="radio"
      />
      <span
        className={cn(
          "grid h-10 w-10 shrink-0 place-items-center rounded-lg",
          checked ? "bg-[var(--ad-ink)] text-white" : "bg-[var(--ad-surface-subtle)] text-[var(--ad-text)]",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="text-sm font-semibold text-[var(--ad-ink)]">
            {name}
            <span className="font-normal text-[var(--ad-text-muted)]"> · {kind}</span>
          </span>
          <ModelStatusLabel status={status} t={t} />
        </span>
        <span className="mt-1 block text-xs leading-5 text-[var(--ad-text-muted)]">{description}</span>
        {engine ? (
          <span className="mt-1 block text-xs text-[var(--ad-text-muted)]">
            {t("Engine")} {engine}
          </span>
        ) : null}
        {disabled && detail ? (
          <span className="mt-2 block text-xs leading-5 text-[var(--ad-yellow-text)]">{t(detail)}</span>
        ) : null}
      </span>
    </label>
  );
}

function ModelStatusLabel({ status, t }: { status: ModelStatus; t: Translate }) {
  const ready = status === "ready";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-semibold",
        ready ? "text-[var(--ad-green-text)]" : "text-[var(--ad-yellow-text)]",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("h-2 w-2 rounded-full", ready ? "bg-[var(--ad-green-text)]" : "bg-[var(--ad-yellow-text)]")}
      />
      {t(modelStatusLabel(status))}
    </span>
  );
}
