import type { IgrepWake } from "./igrep";

/** Relationship scope of a cached profile; purge and promotion select by it. */
export interface WakeCacheScope {
  userId: string;
  characterId: string;
}

export type WakeCacheInvalidation =
  | { scope: "user"; userId: string }
  | { scope: "relationship"; userId: string; characterId: string };

interface Entry extends WakeCacheScope {
  wake: IgrepWake;
}

/**
 * SPEC: `mem wake` reads only the resident profile of the immutable canonical
 * version an attempt copied (reproject rebuilds dialogue views, never the
 * profile). Its validated result is therefore a function of that version's
 * realpath, and a hit skips one igrep subprocess before the first token.
 *
 * INVARIANT (privacy): no profile text outlives a relationship/user purge,
 * account erasure or rebuild promotion. Those paths call `invalidate`, which
 * drops matching entries and advances an epoch; a lookup taken before the
 * invalidation cannot store its (possibly superseded) result afterwards.
 * The cache is bounded (LRU) and process-local; nothing is persisted.
 */
export class WakeProfileCache {
  private readonly entries = new Map<string, Entry>();
  private epoch = 0;

  constructor(private readonly maxEntries = 256) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("wake cache size must be a positive integer");
  }

  get size(): number {
    return this.entries.size;
  }

  /** Return a cached wake for this exact version and scope, plus a store token. */
  lookup(version: string, scope: WakeCacheScope): { wake?: IgrepWake; token: number } {
    const entry = this.entries.get(version);
    if (!entry || entry.userId !== scope.userId || entry.characterId !== scope.characterId) {
      return { token: this.epoch };
    }
    // Refresh recency.
    this.entries.delete(version);
    this.entries.set(version, entry);
    return { wake: entry.wake, token: this.epoch };
  }

  /** Store a validated wake unless an invalidation happened since `lookup`. */
  store(token: number, version: string, scope: WakeCacheScope, wake: IgrepWake): void {
    if (token !== this.epoch) return;
    this.entries.delete(version);
    this.entries.set(version, { userId: scope.userId, characterId: scope.characterId, wake: { ...wake } });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  invalidate(request: WakeCacheInvalidation): void {
    this.epoch += 1;
    for (const [version, entry] of this.entries) {
      if (entry.userId !== request.userId) continue;
      if (request.scope === "relationship" && entry.characterId !== request.characterId) continue;
      this.entries.delete(version);
    }
  }

  clear(): void {
    this.epoch += 1;
    this.entries.clear();
  }
}
