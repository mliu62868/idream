const STORAGE_KEY = "idream:generation:current-job";

type JobStorage = Pick<Storage, "getItem" | "setItem">;

// sessionStorage keeps each tab's explicit request separate. Its owner must
// match freshly confirmed viewer authority before any saved job is restored.
export function readCurrentGenerationJob(storage: JobStorage, scope: string) {
  try {
    const saved: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
    if (!saved || typeof saved !== "object") return null;
    const record = saved as Record<string, unknown>;
    return record.scope === scope && typeof record.jobId === "string" &&
      record.jobId.length > 0 && record.jobId.length <= 200 ? record.jobId : null;
  } catch {
    return null;
  }
}

export function saveCurrentGenerationJob(storage: JobStorage, scope: string | null, jobId: string) {
  if (!scope) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ scope, jobId }));
  } catch {
    // In-memory tracking still works when the browser disables storage.
  }
}
