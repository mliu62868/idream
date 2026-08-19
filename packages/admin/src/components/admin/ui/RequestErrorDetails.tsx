"use client";
import { useState } from "react";
import { Copy } from "lucide-react";
import { useAdminI18n } from "@/components/admin/i18n";
import { EngineeringDetails } from "@/components/admin/generation/EngineeringDetails";
import { technicalDetailText, type OperatorErrorCopy } from "./request-error-copy";

// SPEC: 失败横幅/弹窗底部那一行折叠的技术详情，外加一键复制给工程。
// INTENT: 复用既有的 EngineeringDetails（首屏只留人话，黑话点开才见）；这里只多加复制按钮——
//         运营转述 requestId 时抄错一个字符，工程就查不到那次调用。
export function RequestErrorDetails({
  technical,
}: {
  technical: OperatorErrorCopy["technical"];
}) {
  const { t } = useAdminI18n();
  const [copied, setCopied] = useState(false);
  const text = technicalDetailText(technical);

  async function copy() {
    await navigator.clipboard?.writeText(text);
    setCopied(true);
  }

  return (
    <div className="mt-3">
      <EngineeringDetails summary={technical.code ?? t("No error code was returned")}>
        <pre className="whitespace-pre-wrap">{text}</pre>
        <button
          className="mt-2 inline-flex min-h-8 items-center gap-1 rounded border border-current px-2 font-sans font-semibold"
          onClick={() => void copy()}
          type="button"
        >
          <Copy className="h-3 w-3" />
          {copied ? t("Copied") : t("Copy for engineering")}
        </button>
      </EngineeringDetails>
    </div>
  );
}
