// SPEC: chat.maintain (design §9-D3). Keep session.jsonl small + bounded:
//   - roll the active log to a numbered segment once it exceeds a size threshold
//     (append stays fast); long-term memory already distilled into mem/*.md.
//   - TTL: delete segments older than a retention window (raw trace is not the
//     memory authority, so pruning it loses nothing material).
// no-memory sessions don't write jsonl at all (handled upstream in generate).
import { rename, stat, readdir, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { env } from "./env.js";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days

function sessionsDir(): string {
  return path.join(env.CHAT_FS_ROOT, "sessions");
}

/** Roll the active {sessionId}.jsonl → {sessionId}.{seq}.jsonl if over maxBytes. */
export async function rollSessionLog(
  userId: string,
  sessionId: string,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<boolean> {
  const dir = path.join(sessionsDir(), userId);
  const active = path.join(dir, `${sessionId}.jsonl`);
  let size = 0;
  try {
    size = (await stat(active)).size;
  } catch {
    return false;
  }
  if (size < maxBytes) return false;

  // find next segment number
  const entries = await readdir(dir).catch(() => [] as string[]);
  const seqs = entries
    .map((f) => f.match(new RegExp(`^${escapeRe(sessionId)}\\.(\\d+)\\.jsonl$`)))
    .filter(Boolean)
    .map((m) => Number.parseInt((m as RegExpMatchArray)[1], 10));
  const next = (seqs.length ? Math.max(...seqs) : 0) + 1;
  await mkdir(dir, { recursive: true });
  await rename(active, path.join(dir, `${sessionId}.${next}.jsonl`));
  return true;
}

/** Delete archived segments older than ttlMs across all users (TTL hard-expire). */
export async function pruneExpiredSegments(ttlMs = DEFAULT_TTL_MS, now = Date.now()): Promise<number> {
  const base = sessionsDir();
  let removed = 0;
  const users = await readdir(base, { withFileTypes: true }).catch(() => []);
  for (const u of users) {
    if (!u.isDirectory()) continue;
    const dir = path.join(base, u.name);
    const files = await readdir(dir).catch(() => [] as string[]);
    for (const f of files) {
      // only numbered segments are eligible (active file is never TTL-deleted here)
      if (!/\.\d+\.jsonl$/.test(f)) continue;
      const full = path.join(dir, f);
      const st = await stat(full).catch(() => null);
      if (st && now - st.mtimeMs > ttlMs) {
        await rm(full, { force: true });
        removed += 1;
      }
    }
  }
  return removed;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
