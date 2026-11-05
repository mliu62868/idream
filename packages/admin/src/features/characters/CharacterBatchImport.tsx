"use client";

// SPEC: 列表页「导入」：粘贴或上传 JSON 数组 → 逐行校验 → 一键建私有草稿，失败行可重试。
// INVARIANT: 只建私有草稿，不发布；逐行调用现有创建接口，并发不超过 CHARACTER_IMPORT_CONCURRENCY。
import { Check, Copy, Download, Loader2, Upload, X } from "lucide-react";
import Link from "next/link";
import { useState, type ChangeEvent } from "react";
import { createPortal } from "react-dom";
import { useAdminI18n } from "@/components/admin/i18n";
import { operatorErrorCopy } from "@/components/admin/ui/request-error-copy";
import { WorkspaceButton, textAreaClass } from "@/features/operations/WorkspaceUi";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import {
  CHARACTER_IMPORT_CONCURRENCY,
  CHARACTER_IMPORT_EXAMPLE,
  CHARACTER_IMPORT_MAX_ROWS,
  characterImportIntent,
  parseCharacterImport,
  runWithConcurrency,
  type CharacterImportRow,
} from "./character-batch-import";

type RowResult =
  | { readonly state: "creating" }
  | { readonly state: "created"; readonly deepLink: string }
  | { readonly state: "failed"; readonly message: string };

const PARSE_ERRORS = {
  invalid_json: "This is not valid JSON. Check the brackets and quotes.",
  not_array: "The JSON must be an array of characters.",
  empty: "The array is empty.",
  too_many: "Import at most {max} characters at a time.",
} as const;

const IMPORT_REASON = { code: "character_batch_import", summary: "Create a private draft from a batch import" };

export function CharacterBatchImport() {
  const { t } = useAdminI18n();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [results, setResults] = useState<Readonly<Record<number, RowResult>>>({});
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const parsed = text.trim() ? parseCharacterImport(text) : null;
  const importRows = parsed?.ok ? parsed.rows : [];
  const pendingRows = importRows.filter((row) => row.draft && results[row.index]?.state !== "created");
  const createdCount = importRows.filter((row) => results[row.index]?.state === "created").length;
  const hasFailures = importRows.some((row) => results[row.index]?.state === "failed");

  function changeText(next: string) {
    setText(next);
    setResults({});
  }

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) changeText(await file.text());
  }

  async function createRow(row: CharacterImportRow) {
    setResults((current) => ({ ...current, [row.index]: { state: "creating" } }));
    try {
      const created = await adminV2Operation("POST /api/v2/admin/characters", {
        intent: characterImportIntent(row),
        body: { ...row.draft!, reason: IMPORT_REASON, confirmation: "CREATE CHARACTER" },
      });
      setResults((current) => ({ ...current, [row.index]: { state: "created", deepLink: created.deepLink } }));
    } catch (cause) {
      const copy = operatorErrorCopy(cause);
      setResults((current) => ({ ...current, [row.index]: { state: "failed", message: t(copy.headline) } }));
    }
  }

  async function createAll() {
    setRunning(true);
    try {
      await runWithConcurrency(pendingRows, CHARACTER_IMPORT_CONCURRENCY, createRow);
    } finally {
      setRunning(false);
    }
  }

  async function copyExample() {
    await navigator.clipboard?.writeText(CHARACTER_IMPORT_EXAMPLE);
    setCopied(true);
  }

  function downloadExample() {
    const url = URL.createObjectURL(new Blob([CHARACTER_IMPORT_EXAMPLE], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "characters-example.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <WorkspaceButton onClick={() => setOpen(true)}>
        <Upload aria-hidden="true" className="h-4 w-4" /> {t("Import")}
      </WorkspaceButton>
      {open ? createPortal(
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/20 p-4">
          <div
            aria-labelledby="character-import-title"
            aria-modal="true"
            className="max-h-[calc(100dvh-2rem)] w-full max-w-3xl overflow-y-auto rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-5"
            role="dialog"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold" id="character-import-title">{t("Import characters")}</h3>
                <p className="mt-1 text-sm text-[var(--ad-text-muted)]">
                  {t("Paste or upload a JSON array. Each row becomes a private draft; nothing is published.")}
                </p>
              </div>
              <button aria-label={t("Close")} className="grid min-h-10 min-w-10 place-items-center" disabled={running} onClick={() => setOpen(false)} type="button">
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-[var(--ad-border)] px-3 text-sm font-medium">
                <Upload aria-hidden="true" className="h-4 w-4" /> {t("Upload JSON file")}
                <input accept="application/json,.json" aria-label={t("Upload JSON file")} className="sr-only" onChange={(event) => void readFile(event)} type="file" />
              </label>
              <WorkspaceButton onClick={() => void copyExample()}>
                {copied ? <Check aria-hidden="true" className="h-4 w-4" /> : <Copy aria-hidden="true" className="h-4 w-4" />}
                {t(copied ? "Example copied" : "Copy example")}
              </WorkspaceButton>
              <WorkspaceButton onClick={downloadExample}>
                <Download aria-hidden="true" className="h-4 w-4" /> {t("Download example")}
              </WorkspaceButton>
            </div>
            <textarea
              aria-label={t("Characters as JSON")}
              className={`${textAreaClass} mt-3 min-h-40 font-mono text-xs`}
              disabled={running}
              onChange={(event) => changeText(event.target.value)}
              placeholder={CHARACTER_IMPORT_EXAMPLE}
              value={text}
            />
            {parsed && !parsed.ok ? (
              <p className="mt-2 rounded-md bg-[var(--ad-red-bg)] p-2 text-sm text-[var(--ad-red-text)]" role="alert">
                {t(PARSE_ERRORS[parsed.error], { max: CHARACTER_IMPORT_MAX_ROWS })}
              </p>
            ) : null}
            {importRows.length > 0 ? (
              <>
                <p className="mt-3 text-sm font-semibold" role="status">
                  {t("{valid} of {total} rows are ready. {created} created.", {
                    valid: importRows.filter((row) => row.draft).length,
                    total: importRows.length,
                    created: createdCount,
                  })}
                </p>
                <ol className="mt-2 divide-y divide-[var(--ad-border)] rounded-lg border border-[var(--ad-border)]" data-testid="character-import-rows">
                  {importRows.map((row) => {
                    const result = results[row.index];
                    return (
                      <li className="flex flex-col gap-1 p-2 text-sm sm:flex-row sm:items-start sm:justify-between" key={row.index}>
                        <span className="min-w-0">
                          <span className="text-[var(--ad-text-muted)]">{row.index + 1}. </span>
                          <strong>{row.label || t("Unnamed")}</strong>
                          {row.errors.map((error) => (
                            <span className="mt-0.5 block text-xs text-[var(--ad-red-text)]" key={error}>{t(error)}</span>
                          ))}
                          {result?.state === "failed" ? (
                            <span className="mt-0.5 block text-xs text-[var(--ad-red-text)]">{result.message}</span>
                          ) : null}
                        </span>
                        <span className="shrink-0 text-xs font-semibold">
                          {!row.draft ? t("Needs fixing")
                            : result?.state === "creating" ? <Loader2 aria-label={t("Creating…")} className="h-4 w-4 animate-spin" />
                            : result?.state === "created" ? <Link className="underline" href={result.deepLink}>{t("Open draft")}</Link>
                            : result?.state === "failed" ? t("Failed")
                            : t("Ready")}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </>
            ) : null}
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <WorkspaceButton disabled={running} onClick={() => setOpen(false)}>{t("Close")}</WorkspaceButton>
              <WorkspaceButton disabled={running || pendingRows.length === 0} onClick={() => void createAll()} tone="primary">
                {running ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
                {t(hasFailures ? "Retry {count} rows" : "Create {count} private drafts", { count: pendingRows.length })}
              </WorkspaceButton>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
