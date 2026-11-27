"use client";

import type { ReactNode } from "react";
import { RequestErrorDetails } from "@/components/admin/ui/RequestErrorDetails";
import type { OperatorErrorCopy } from "@/components/admin/ui/request-error-copy";
import { cn } from "@/lib/utils";
import type { Translate } from "./character-voice-model";

// SPEC: 声音面板各区块共用的就地提示：运行时告警 / 试听失败，以及直接写入失败。
export function InlineAlert({ children, tone }: { children: ReactNode; tone: "warn" | "error" }) {
  return (
    <p
      className={cn(
        "mt-4 rounded-lg px-4 py-3 text-sm",
        tone === "error"
          ? "bg-[var(--ad-red-bg)] text-[var(--ad-red-text)]"
          : "bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]",
      )}
      role="alert"
    >
      {children}
    </p>
  );
}

export function ActionErrorAlert({ copy, t }: { copy: OperatorErrorCopy; t: Translate }) {
  return (
    <div className="mt-4 rounded-lg bg-[var(--ad-red-bg)] px-4 py-3 text-sm text-[var(--ad-red-text)]" role="alert">
      <span className="block font-semibold">{t(copy.headline)}</span>
      <span className="mt-1 block">{t(copy.nextStep, copy.nextStepValues)}</span>
      <RequestErrorDetails technical={copy.technical} />
    </div>
  );
}
