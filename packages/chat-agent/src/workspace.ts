import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  companionMemoryCutoverSidecarProofSchema,
  companionWorkspaceRebuildFenceSchema,
  releasedKnowledgeSnapshotSchema,
  type CompanionInvocation,
  type CompanionMemoryCutoverSidecarProof,
  type CompanionWorkspaceRebuildFence,
} from "@idream/shared/chat/companion-runtime";

export interface MemoryStatus {
  dialogueFiles: number;
  pendingProfileRows?: number;
  processedProfileRows?: number;
  lastMaintainAt?: string | null;
}

export interface MemoryProbe {
  status(workspace: string): Promise<MemoryStatus>;
}

export interface AttemptWorkspace {
  readonly path: string;
  readonly mode: "normal" | "private";
  commit(): Promise<void>;
  discard(): Promise<void>;
  settleAndDiscard(): Promise<void>;
}

export interface PreparedRelationshipRebuild {
  rebuildId: string;
  sessions: number;
  messages: number;
}

interface RelationshipRebuildCandidateManifest extends PreparedRelationshipRebuild {
  fence: CompanionWorkspaceRebuildFence;
}

export interface AttemptWorkspaceStoreOptions {
  canonicalRoot: string;
  privateRoot?: string;
  memoryProbe: MemoryProbe;
  verificationTimeoutMs?: number;
  verificationPollMs?: number;
}

export type WorkspacePurgeRequest =
  | { scope: "user"; userId: string }
  | {
      scope: "relationship";
      userId: string;
      characterId: string;
    };

interface LockWaiter {
  promise: Promise<void>;
  release(): void;
}

function deferredLock(): LockWaiter {
  const state = Promise.withResolvers<void>();
  return { promise: state.promise, release: () => state.resolve() };
}

function safeKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

export function userWorkspacePath(canonicalRoot: string, userId: string): string {
  return join(resolve(canonicalRoot), `user-${safeKey(userId)}`);
}

export function relationshipWorkspacePath(
  canonicalRoot: string,
  userId: string,
  characterId: string,
): string {
  return join(userWorkspacePath(canonicalRoot, userId), `relationship-${safeKey(userId, characterId)}`);
}

function memoryCutoverUserMetaPath(canonicalRoot: string, userId: string): string {
  return join(resolve(canonicalRoot), "_meta", `user-${safeKey(userId)}`);
}

export function memoryCutoverMarkerPath(
  canonicalRoot: string,
  userId: string,
  characterId: string,
): string {
  return join(
    memoryCutoverUserMetaPath(canonicalRoot, userId),
    `relationship-${safeKey(userId, characterId)}.json`,
  );
}

export interface MemoryCutoverMarker {
  checksum: string;
  entries: number;
  legacySourceChecksum: string;
  igrepVersion: string;
  workspaceVersion: string;
  status: "cutover_ready";
  recallParity: MemoryCutoverRecallParityEvidence;
  completedAt: string;
}

export interface MemoryCutoverRecallParityProbeEvidence {
  probeId: string;
  queryHash: string;
  legacyExpectedHash: string;
  recallContextHash: string;
  hitCount: number;
}

export interface MemoryCutoverRecallParityEvidence {
  probeSetChecksum: string;
  total: number;
  passed: number;
  probes: MemoryCutoverRecallParityProbeEvidence[];
}
function privateUserWorkspacePath(privateRoot: string, userId: string): string {
  return join(resolve(privateRoot), `user-${safeKey(userId)}`);
}

function privateRelationshipWorkspacePath(
  privateRoot: string,
  userId: string,
  characterId: string,
): string {
  return join(
    privateUserWorkspacePath(privateRoot, userId),
    `relationship-${safeKey(userId, characterId)}`,
  );
}

function assertWithin(parent: string, child: string): void {
  const path = relative(resolve(parent), resolve(child));
  if (path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep))) return;
  throw new Error("workspace path escaped its authority root");
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export class AttemptWorkspaceStore {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly rebuildGarbage = new Set<string>();
  private rebuildGarbageDrain: Promise<void> | undefined;
  private rebuildGarbageRetry: NodeJS.Timeout | undefined;
  private readonly options: Required<
    Omit<AttemptWorkspaceStoreOptions, "privateRoot">
  > & {
    privateRoot: string;
  };

  constructor(options: AttemptWorkspaceStoreOptions) {
    this.options = {
      ...options,
      privateRoot: options.privateRoot ?? tmpdir(),
      // SPEC: promotion waits for the official plugin's post-turn ingest and
      // profile maintenance to become observable through memory-status.
      // INTENT: maintenance is two LLM calls on the shared local GPU — 1.7–3.3 s
      // alone, p90 14.5 s and max 27 s with six relationships in flight
      // (measured 2026-08-24). The old 5 s budget sat inside that distribution:
      // 25% of normal turns timed out, failed their memory commit and triggered
      // a 13–150 s canonical rebuild that blocked the relationship's next turn
      // and added more LLM load — the cascade the burn tests reproduced. The
      // budget is therefore well outside the loaded tail; the plugin itself
      // kills a runaway maintenance at 300 s.
      verificationTimeoutMs: options.verificationTimeoutMs ?? 120_000,
      verificationPollMs: options.verificationPollMs ?? 50,
    };
    void this.discoverRebuildGarbage()
      .then((paths) => this.removeRebuildGarbage(paths))
      .catch(() => undefined);
  }

  async prepare(
    invocation: CompanionInvocation,
    signal?: AbortSignal,
  ): Promise<AttemptWorkspace> {
    signal?.throwIfAborted();
    if (invocation.memoryMode === "private") return this.preparePrivate(invocation);
    return this.prepareNormal(invocation, signal);
  }

  async purge(request: WorkspacePurgeRequest): Promise<number> {
    if (request.scope === "relationship") {
      const releaseCanonical = await this.acquireRelationship(
        request.userId,
        request.characterId,
        this.options.canonicalRoot,
      );
      const canonicalTarget = relationshipWorkspacePath(
        this.options.canonicalRoot,
        request.userId,
        request.characterId,
      );
      const privateTarget = privateRelationshipWorkspacePath(
        this.options.privateRoot,
        request.userId,
        request.characterId,
      );
      const cutoverMarker = memoryCutoverMarkerPath(
        this.options.canonicalRoot,
        request.userId,
        request.characterId,
      );
      try {
        assertWithin(this.options.canonicalRoot, canonicalTarget);
        assertWithin(this.options.privateRoot, privateTarget);
        const found = await Promise.all([
          exists(canonicalTarget),
          exists(privateTarget),
          exists(cutoverMarker),
        ]);
        await Promise.all([
          rm(canonicalTarget, { recursive: true, force: true }),
          rm(cutoverMarker, { force: true }),
        ]);
        // Private attempts hold no memory; there is nothing to analyse.
        await rm(privateTarget, { recursive: true, force: true });
        await Promise.all([
          rmdir(userWorkspacePath(this.options.canonicalRoot, request.userId)),
          rmdir(privateUserWorkspacePath(this.options.privateRoot, request.userId)),
          rmdir(memoryCutoverUserMetaPath(this.options.canonicalRoot, request.userId)),
        ].map((cleanup) => cleanup.catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
        })));
        return found.some(Boolean) ? 1 : 0;
      } finally {
        releaseCanonical();
      }
    }
    const canonicalTarget = userWorkspacePath(this.options.canonicalRoot, request.userId);
    const privateTarget = privateUserWorkspacePath(this.options.privateRoot, request.userId);
    assertWithin(this.options.canonicalRoot, canonicalTarget);
    assertWithin(this.options.privateRoot, privateTarget);
    const relationshipNames = new Set<string>();
    for (const target of [canonicalTarget, privateTarget]) {
      if (!(await exists(target))) continue;
      const children = await readdir(target, { withFileTypes: true });
      for (const entry of children) {
        if (entry.isDirectory() && entry.name.startsWith("relationship-")) {
          relationshipNames.add(entry.name);
        }
      }
    }
    await Promise.all([
      rm(canonicalTarget, { recursive: true, force: true }),
      rm(privateTarget, { recursive: true, force: true }),
      rm(memoryCutoverUserMetaPath(this.options.canonicalRoot, request.userId), {
        recursive: true,
        force: true,
      }),
    ]);
    return relationshipNames.size;
  }

  async rebuildRelationship<T>(
    identity: { userId: string; characterId: string },
    build: (workspace: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const release = await this.acquireRelationship(
      identity.userId,
      identity.characterId,
      this.options.canonicalRoot,
      signal,
    );
    try {
      signal?.throwIfAborted();
      await this.purgeEphemeralRelationship(identity);
      signal?.throwIfAborted();
      return await this.replaceRelationshipLocked(identity, build, signal);
    } finally {
      release();
    }
  }

  async prepareRelationshipRebuild(
    identity: { userId: string; characterId: string },
    fence: CompanionWorkspaceRebuildFence,
    build: (workspace: string) => Promise<{ sessions: number; messages: number }>,
    signal?: AbortSignal,
  ): Promise<PreparedRelationshipRebuild> {
    const parsedFence = companionWorkspaceRebuildFenceSchema.parse(fence);
    const release = await this.acquireRelationship(
      identity.userId,
      identity.characterId,
      this.options.canonicalRoot,
      signal,
    );
    const relationshipRoot = await this.ensurePrivateRelationshipDirectory(
      this.options.canonicalRoot,
      identity.userId,
      identity.characterId,
    );
    const candidatesRoot = join(relationshipRoot, ".rebuild-candidates");
    const rebuildId = randomUUID();
    const candidateRoot = join(candidatesRoot, rebuildId);
    const workspace = join(candidateRoot, "workspace");
    const memory = join(workspace, ".igrep");
    try {
      signal?.throwIfAborted();
      await this.purgeEphemeralRelationship(identity);
      // Each durable claim owns one candidate directory. Removing the shared
      // root here would let a second process destroy a live prepare between
      // Main lease heartbeats.
      await mkdir(memory, { recursive: true, mode: 0o700 });
      for (const path of [candidatesRoot, candidateRoot, workspace, memory]) {
        await chmod(path, 0o700);
      }
      const result = await build(workspace);
      signal?.throwIfAborted();
      const manifest: RelationshipRebuildCandidateManifest = {
        rebuildId,
        fence: parsedFence,
        sessions: result.sessions,
        messages: result.messages,
      };
      const handle = await open(join(candidateRoot, "manifest.json"), "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(manifest)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { rebuildId, sessions: result.sessions, messages: result.messages };
    } catch (error) {
      await rm(candidateRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      release();
    }
  }

  async promoteRelationshipRebuild(input: {
    userId: string;
    characterId: string;
    rebuildId: string;
    fence: CompanionWorkspaceRebuildFence;
  }, signal?: AbortSignal): Promise<{ sessions: number; messages: number }> {
    const fence = companionWorkspaceRebuildFenceSchema.parse(input.fence);
    const release = await this.acquireRelationship(
      input.userId,
      input.characterId,
      this.options.canonicalRoot,
      signal,
    );
    const relationshipRoot = await this.ensurePrivateRelationshipDirectory(
      this.options.canonicalRoot,
      input.userId,
      input.characterId,
    );
    const versionsRoot = join(relationshipRoot, ".igrep.versions");
    const canonicalLink = join(relationshipRoot, ".igrep");
    const candidateRoot = join(relationshipRoot, ".rebuild-candidates", input.rebuildId);
    const candidateMemory = join(candidateRoot, "workspace", ".igrep");
    const candidateVersion = join(
      versionsRoot,
      `projection-${fence.authorityVersion}-${input.rebuildId}`,
    );
    let candidateMoved = false;
    let canonicalChanged = false;
    let priorVersion: string | undefined;
    try {
      signal?.throwIfAborted();
      await mkdir(versionsRoot, { recursive: true, mode: 0o700 });
      await chmod(versionsRoot, 0o700);
      const current = await this.canonicalVersion(canonicalLink, versionsRoot);
      priorVersion = current;
      // A lost HTTP response can leave the pointer swapped while Chat rolls
      // its short transaction back. The exact version name proves this same
      // rebuildId already won, so retry stays idempotent even after its tiny
      // candidate metadata has been collected.
      if (current && resolve(current) === resolve(candidateVersion)
        && !(await exists(candidateRoot))) {
        return { sessions: 0, messages: 0 };
      }
      const manifest = this.parseRelationshipRebuildCandidateManifest(
        await readFile(join(candidateRoot, "manifest.json"), "utf8"),
      );
      if (
        manifest.rebuildId !== input.rebuildId
        || JSON.stringify(manifest.fence) !== JSON.stringify(fence)
      ) {
        throw new Error("relationship rebuild promotion fence does not match its candidate");
      }
      const currentAuthority = current
        ? this.projectionAuthorityVersion(basename(current))
        : undefined;
      const requestedAuthority = BigInt(fence.authorityVersion);
      if (currentAuthority !== undefined && currentAuthority > requestedAuthority) {
        throw new Error("relationship rebuild promotion authority is stale");
      }
      if (currentAuthority === requestedAuthority) {
        if (!current) throw new Error("relationship rebuild authority has no canonical version");
        const garbage = await this.quarantineRebuildGarbage(
          relationshipRoot,
          versionsRoot,
          current,
          candidateRoot,
        );
        this.removeRebuildGarbage(garbage);
        return { sessions: manifest.sessions, messages: manifest.messages };
      }
      signal?.throwIfAborted();
      if (!(await exists(candidateVersion))) {
        await rename(candidateMemory, candidateVersion);
        candidateMoved = true;
      }
      signal?.throwIfAborted();
      const nextLink = join(relationshipRoot, `.igrep.next-${randomUUID()}`);
      try {
        await symlink(relative(relationshipRoot, candidateVersion), nextLink, "dir");
        signal?.throwIfAborted();
        await rename(nextLink, canonicalLink);
        canonicalChanged = true;
        signal?.throwIfAborted();
      } finally {
        await rm(nextLink, { force: true }).catch(() => undefined);
      }
      const garbage = await this.quarantineRebuildGarbage(
        relationshipRoot,
        versionsRoot,
        candidateVersion,
        candidateRoot,
      );
      this.removeRebuildGarbage(garbage);
      return { sessions: manifest.sessions, messages: manifest.messages };
    } catch (error) {
      if (canonicalChanged) {
        if (priorVersion) {
          const rollbackLink = join(relationshipRoot, `.igrep.rollback-${randomUUID()}`);
          try {
            await symlink(relative(relationshipRoot, priorVersion), rollbackLink, "dir");
            await rename(rollbackLink, canonicalLink);
          } finally {
            await rm(rollbackLink, { force: true }).catch(() => undefined);
          }
        } else {
          await rm(canonicalLink, { force: true });
        }
      }
      if (candidateMoved) {
        await rename(candidateVersion, candidateMemory).catch(() => undefined);
      }
      throw error;
    } finally {
      release();
    }
  }

  async discardRelationshipRebuild(input: {
    userId: string;
    characterId: string;
    rebuildId: string;
    fence: CompanionWorkspaceRebuildFence;
  }): Promise<void> {
    const fence = companionWorkspaceRebuildFenceSchema.parse(input.fence);
    const release = await this.acquireRelationship(input.userId, input.characterId);
    const candidateRoot = join(
      relationshipWorkspacePath(
        this.options.canonicalRoot,
        input.userId,
        input.characterId,
      ),
      ".rebuild-candidates",
      input.rebuildId,
    );
    try {
      const manifest = this.parseRelationshipRebuildCandidateManifest(
        await readFile(join(candidateRoot, "manifest.json"), "utf8"),
      );
      if (
        manifest.rebuildId !== input.rebuildId
        || JSON.stringify(manifest.fence) !== JSON.stringify(fence)
      ) {
        throw new Error("relationship rebuild discard fence does not match its candidate");
      }
      await rm(candidateRoot, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      release();
    }
  }

  async memoryCutoverProof(
    identity: { userId: string; characterId: string },
  ): Promise<CompanionMemoryCutoverSidecarProof | null> {
    const release = await this.acquireRelationship(identity.userId, identity.characterId);
    try {
      const marker = await this.readMemoryCutoverMarker(
        memoryCutoverMarkerPath(
          this.options.canonicalRoot,
          identity.userId,
          identity.characterId,
        ),
      );
      if (!marker) return null;
      const relationshipRoot = relationshipWorkspacePath(
        this.options.canonicalRoot,
        identity.userId,
        identity.characterId,
      );
      const canonical = await this.readCanonicalVersion(
        join(relationshipRoot, ".igrep"),
        join(relationshipRoot, ".igrep.versions"),
      );
      if (!canonical) {
        throw new Error("cutover marker exists without a canonical igrep workspace");
      }
      const workspaceVersion = basename(canonical);
      if (
        workspaceVersion !== marker.workspaceVersion
        && workspaceVersion.startsWith("rebuild-")
      ) {
        // A rebuild is not a descendant commit of the certified migration.
        // The old marker remains on disk for forensics, but the audit is stale.
        return null;
      }
      return companionMemoryCutoverSidecarProofSchema.parse({
        ...marker,
        cutoverWorkspaceVersion: marker.workspaceVersion,
        workspaceVersion,
      });
    } finally {
      release();
    }
  }

  private async replaceRelationshipLocked<T>(
    identity: { userId: string; characterId: string },
    build: (workspace: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const relationshipRoot = await this.ensurePrivateRelationshipDirectory(
      this.options.canonicalRoot,
      identity.userId,
      identity.characterId,
    );
    const versionsRoot = join(relationshipRoot, ".igrep.versions");
    const rebuildsRoot = join(relationshipRoot, ".rebuilds");
    const canonicalLink = join(relationshipRoot, ".igrep");
    const rebuildRoot = join(rebuildsRoot, randomUUID());
    const workspace = join(rebuildRoot, "workspace");
    const candidateMemory = join(workspace, ".igrep");
    const candidateVersion = join(versionsRoot, `rebuild-${Date.now()}-${randomUUID()}`);
    let promoted = false;
    let canonicalChanged = false;
    let nextLink: string | undefined;
    let priorVersion: string | undefined;
    let result!: T;
    try {
      signal?.throwIfAborted();
      await mkdir(versionsRoot, { recursive: true, mode: 0o700 });
      await chmod(versionsRoot, 0o700);
      // A prior interrupted rebuild may have left transcripts outside .igrep.
      // The relationship lock makes it safe to clear them before retrying.
      await rm(rebuildsRoot, { recursive: true, force: true });
      await mkdir(rebuildRoot, { recursive: true, mode: 0o700 });
      await chmod(rebuildRoot, 0o700);
      await mkdir(workspace, { mode: 0o700 });
      await chmod(workspace, 0o700);
      await mkdir(candidateMemory, { mode: 0o700 });
      await chmod(candidateMemory, 0o700);
      assertWithin(relationshipRoot, rebuildRoot);
      assertWithin(versionsRoot, candidateVersion);
      priorVersion = await this.canonicalVersion(canonicalLink, versionsRoot);
      result = await build(workspace);
      signal?.throwIfAborted();
      // igrep 0.1.134 refuses a workspace whose .igrep resolves outside the
      // workspace. Build and verify in a real directory, then move that exact
      // certified directory into the version authority before pointer swap.
      await rename(candidateMemory, candidateVersion);
      signal?.throwIfAborted();
      nextLink = join(relationshipRoot, `.igrep.next-${randomUUID()}`);
      await symlink(relative(relationshipRoot, candidateVersion), nextLink, "dir");
      signal?.throwIfAborted();
      await rename(nextLink, canonicalLink);
      canonicalChanged = true;
      // INVARIANT: cancellation remains rollback-safe through pointer swap;
      // superseded privacy data has not been garbage-collected at this point.
      signal?.throwIfAborted();
      promoted = true;
      await rm(rebuildRoot, { recursive: true, force: true });
      await this.garbageCollectVersions(versionsRoot, candidateVersion);
      return result;
    } finally {
      if (nextLink) await rm(nextLink, { recursive: true, force: true }).catch(() => undefined);
      if (!promoted) {
        if (canonicalChanged) {
          if (priorVersion) {
            const rollbackLink = join(relationshipRoot, `.igrep.rollback-${randomUUID()}`);
            await symlink(relative(relationshipRoot, priorVersion), rollbackLink, "dir");
            await rename(rollbackLink, canonicalLink);
          } else {
            await rm(canonicalLink, { force: true }).catch(() => undefined);
          }
        }
        await rm(candidateVersion, { recursive: true, force: true }).catch(() => undefined);
        await rm(rebuildRoot, { recursive: true, force: true }).catch(() => undefined);
      } else {
        await rm(rebuildRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private assertMemoryCutoverMarker(marker: MemoryCutoverMarker): void {
    this.assertMemoryCutoverMarkerIdentity(marker);
    if (!/^(?:rebuild|migrated)-\d+-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
      .test(marker.workspaceVersion)) {
      throw new Error("memory cutover marker workspace version is invalid");
    }
    if (marker.status !== "cutover_ready") {
      throw new Error("memory cutover marker is not cutover-ready");
    }
    if (!Number.isSafeInteger(marker.entries) || marker.entries < 0) {
      throw new Error("memory cutover marker entry count is invalid");
    }
    this.assertMemoryCutoverRecallParity(marker.recallParity, marker.entries);
    if (!Number.isFinite(Date.parse(marker.completedAt))) {
      throw new Error("memory cutover marker completion time is invalid");
    }
  }

  private assertMemoryCutoverRecallParity(
    parity: MemoryCutoverRecallParityEvidence,
    entries: number,
  ): void {
    if (!/^[a-f0-9]{64}$/.test(parity.probeSetChecksum)
      || !Number.isSafeInteger(parity.total)
      || parity.total < 0
      || parity.passed !== parity.total
      || parity.probes.length !== parity.total
      || ((entries === 0) !== (parity.total === 0))) {
      throw new Error("memory cutover recall parity evidence is incomplete");
    }
    const probeIds = new Set<string>();
    for (const probe of parity.probes) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(probe.probeId)
        || probeIds.has(probe.probeId)
        || ![probe.queryHash, probe.legacyExpectedHash, probe.recallContextHash]
          .every((digest) => /^[a-f0-9]{64}$/.test(digest))
        || !Number.isSafeInteger(probe.hitCount)
        || probe.hitCount < 0) {
        throw new Error("memory cutover recall parity probe evidence is invalid");
      }
      probeIds.add(probe.probeId);
    }
  }

  private assertMemoryCutoverMarkerIdentity(
    marker: Pick<
      MemoryCutoverMarker,
      "checksum" | "legacySourceChecksum" | "igrepVersion"
    >,
  ): void {
    if (!/^[a-f0-9]{64}$/.test(marker.checksum)) {
      throw new Error("memory cutover marker checksum is invalid");
    }
    if (!/^[a-f0-9]{64}$/.test(marker.legacySourceChecksum)) {
      throw new Error("memory cutover marker source checksum is invalid");
    }
    if (!/^\d+\.\d+\.\d+$/.test(marker.igrepVersion)) {
      throw new Error("memory cutover marker igrep version is invalid");
    }
  }

  private async readMemoryCutoverMarker(
    path: string,
  ): Promise<MemoryCutoverMarker | null> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const value = JSON.parse(raw) as Record<string, unknown>;
    const fields = Object.keys(value).sort().join(",");
    if (fields === "checksum,completedAt,igrepVersion") {
      if (!Number.isFinite(Date.parse(String(value.completedAt)))) {
        throw new Error("memory cutover marker completion time is invalid");
      }
      return null;
    }
    if (
      fields === "checksum,completedAt,igrepVersion,recallParity,status"
      || fields
        === "checksum,completedAt,igrepVersion,recallParity,status,workspaceVersion"
      || fields
        === "checksum,completedAt,entries,igrepVersion,recallParity,status,workspaceVersion"
    ) {
      // Pre-gate markers did not bind the certified entry count and therefore
      // are insufficient as historical migration audit evidence.
      return null;
    }
    if (fields
      !== "checksum,completedAt,entries,igrepVersion,legacySourceChecksum,recallParity,status,workspaceVersion") {
      throw new Error("memory cutover marker contains unexpected fields");
    }
    const marker = value as unknown as MemoryCutoverMarker;
    this.assertMemoryCutoverMarker(marker);
    return marker;
  }
  private async preparePrivate(invocation: CompanionInvocation): Promise<AttemptWorkspace> {
    const relationshipRoot = await this.ensurePrivateRelationshipDirectory(
      this.options.privateRoot,
      invocation.userId,
      invocation.characterId,
    );
    const path = await mkdtemp(join(relationshipRoot, "attempt-"));
    await chmod(path, 0o700);
    let finished = false;
    const discard = async () => {
      if (finished) return;
      finished = true;
      await rm(path, { recursive: true, force: true });
      await rmdir(relationshipRoot).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
      });
      await rmdir(privateUserWorkspacePath(this.options.privateRoot, invocation.userId))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
        });
    };
    return { path, mode: "private", commit: discard, discard, settleAndDiscard: discard };
  }

  private async prepareNormal(
    invocation: CompanionInvocation,
    signal?: AbortSignal,
  ): Promise<AttemptWorkspace> {
    const authorityRoot = this.options.canonicalRoot;
    const release = await this.acquireRelationship(
      invocation.userId,
      invocation.characterId,
      authorityRoot,
      signal,
    );
    let attemptRoot: string | undefined;
    let knowledgeRoot: string | undefined;
    try {
      const relationshipRoot = await this.ensurePrivateRelationshipDirectory(
        authorityRoot,
        invocation.userId,
        invocation.characterId,
      );
      const versionsRoot = join(relationshipRoot, ".igrep.versions");
      const attemptsRoot = join(relationshipRoot, ".attempts");
      const canonicalLink = join(relationshipRoot, ".igrep");
      await mkdir(versionsRoot, { recursive: true, mode: 0o700 });
      await mkdir(attemptsRoot, { recursive: true, mode: 0o700 });
      await chmod(versionsRoot, 0o700);
      await chmod(attemptsRoot, 0o700);
      const canonicalVersion = await this.ensureCanonicalVersion(canonicalLink, versionsRoot);
      const ownedAttemptRoot = join(attemptsRoot, `${safeKey(invocation.attemptId)}-${randomUUID()}`);
      attemptRoot = ownedAttemptRoot;
      const workspace = join(ownedAttemptRoot, "workspace");
      const attemptMemory = join(workspace, ".igrep");
      assertWithin(relationshipRoot, ownedAttemptRoot);
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      for (const path of [ownedAttemptRoot, workspace]) await chmod(path, 0o700);
      await cp(canonicalVersion, attemptMemory, { recursive: true, force: false });
      await chmod(attemptMemory, 0o700);
      const mountedKnowledgeRoot = await this.materializeReleasedKnowledge(
        workspace,
        invocation,
      );
      knowledgeRoot = mountedKnowledgeRoot;
      const before = await this.options.memoryProbe.status(workspace);
      let finished = false;

      const discard = async () => {
        if (finished) return;
        finished = true;
        try {
          await this.removeAttemptRoot(ownedAttemptRoot, mountedKnowledgeRoot);
        } finally {
          release();
        }
      };
      const settleAndDiscard = async () => {
        if (finished) return;
        try {
          await this.waitForMaintain(workspace, before);
        } finally {
          await discard();
        }
      };
      const commit = async () => {
        if (finished) throw new Error("attempt workspace is already finalized");
        let nextVersion: string | undefined;
        let nextLink: string | undefined;
        try {
          await this.waitForLifecycle(workspace, before);
          const versionName = `commit-${Date.now()}-${randomUUID()}`;
          nextVersion = join(versionsRoot, versionName);
          await rename(attemptMemory, nextVersion);
          nextLink = join(relationshipRoot, `.igrep.next-${randomUUID()}`);
          await symlink(relative(relationshipRoot, nextVersion), nextLink, "dir");
          await rename(nextLink, canonicalLink);
          finished = true;
          await this.removeAttemptRoot(ownedAttemptRoot, mountedKnowledgeRoot).catch(() => undefined);
          await this.garbageCollectVersions(versionsRoot, nextVersion);
        } finally {
          if (!finished) {
            await Promise.all([
              this.removeAttemptRoot(ownedAttemptRoot, mountedKnowledgeRoot),
              ...(nextLink ? [rm(nextLink, { recursive: true, force: true })] : []),
              ...(nextVersion ? [rm(nextVersion, { recursive: true, force: true })] : []),
            ]);
          }
          release();
        }
      };
      return { path: workspace, mode: "normal", commit, discard, settleAndDiscard };
    } catch (error) {
      if (attemptRoot) {
        if (knowledgeRoot) {
          await this.removeAttemptRoot(attemptRoot, knowledgeRoot).catch(() => undefined);
        } else {
          await rm(attemptRoot, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      release();
      throw error;
    }
  }

  private async materializeReleasedKnowledge(
    workspace: string,
    invocation: CompanionInvocation,
  ): Promise<string> {
    const snapshot = releasedKnowledgeSnapshotSchema.parse(
      invocation.preparedTurn.releasedKnowledge,
    );
    if (snapshot.characterId !== invocation.characterId) {
      throw new Error("released knowledge character does not match invocation");
    }
    const knowledgeRoot = join(workspace, "knowledge");
    assertWithin(workspace, knowledgeRoot);
    await mkdir(knowledgeRoot, { mode: 0o700 });
    for (const file of snapshot.files) {
      const target = join(knowledgeRoot, file.path);
      assertWithin(knowledgeRoot, target);
      await writeFile(target, file.content, { encoding: "utf8", flag: "wx", mode: 0o400 });
      await chmod(target, 0o400);
    }
    await chmod(knowledgeRoot, 0o500);
    return knowledgeRoot;
  }

  private async removeAttemptRoot(
    attemptRoot: string,
    knowledgeRoot: string,
  ): Promise<void> {
    await chmod(knowledgeRoot, 0o700).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rm(attemptRoot, { recursive: true, force: true });
  }

  private async garbageCollectVersions(
    versionsRoot: string,
    currentVersion: string,
  ): Promise<void> {
    assertWithin(versionsRoot, currentVersion);
    const currentName = relative(versionsRoot, currentVersion);
    if (!currentName || currentName.includes(sep)) {
      throw new Error("canonical igrep version must be a direct child");
    }
    const entries = await readdir(versionsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === currentName) continue;
      const target = join(versionsRoot, entry.name);
      assertWithin(versionsRoot, target);
      // Privacy rebuild is incomplete until every superseded version is gone.
      // Do not swallow removal failures: the durable mutation must retry.
      await rm(target, { recursive: true, force: true });
    }
  }

  /**
   * Move superseded trees out of the authority namespace using same-filesystem
   * renames. Recursive unlink is intentionally asynchronous: rebuild promotion
   * executes inside Chat's short authority transaction and may only perform a
   * bounded local pointer cutover. The durable garbage directory is retried by
   * every later promotion before new entries are added.
   */
  private async quarantineRebuildGarbage(
    relationshipRoot: string,
    versionsRoot: string,
    currentVersion: string,
    candidateRoot: string,
  ): Promise<string[]> {
    assertWithin(versionsRoot, currentVersion);
    const garbageRoot = join(relationshipRoot, ".rebuild-garbage");
    await mkdir(garbageRoot, { recursive: true, mode: 0o700 });
    await chmod(garbageRoot, 0o700);
    const garbage = (await readdir(garbageRoot, { withFileTypes: true }))
      .map((entry) => join(garbageRoot, entry.name));
    for (const entry of await readdir(versionsRoot, { withFileTypes: true })) {
      const source = join(versionsRoot, entry.name);
      if (resolve(source) === resolve(currentVersion)) continue;
      const target = join(garbageRoot, `${entry.name}-${randomUUID()}`);
      assertWithin(garbageRoot, target);
      await rename(source, target);
      garbage.push(target);
    }
    if (await exists(candidateRoot)) {
      const target = join(garbageRoot, `candidate-${randomUUID()}`);
      assertWithin(garbageRoot, target);
      await rename(candidateRoot, target);
      garbage.push(target);
    }
    const candidatesRoot = join(relationshipRoot, ".rebuild-candidates");
    for (const entry of await readdir(candidatesRoot, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    })) {
      if (!entry.isDirectory()) continue;
      const source = join(candidatesRoot, entry.name);
      const target = join(garbageRoot, `candidate-${entry.name}-${randomUUID()}`);
      assertWithin(candidatesRoot, source);
      assertWithin(garbageRoot, target);
      await rename(source, target);
      garbage.push(target);
    }
    return garbage;
  }

  private removeRebuildGarbage(paths: readonly string[]): void {
    for (const path of paths) this.rebuildGarbage.add(path);
    if (this.rebuildGarbageDrain || this.rebuildGarbage.size === 0) return;
    if (this.rebuildGarbageRetry) clearTimeout(this.rebuildGarbageRetry);
    this.rebuildGarbageRetry = undefined;
    this.rebuildGarbageDrain = (async () => {
      for (const path of [...this.rebuildGarbage]) {
        try {
          await rm(path, { recursive: true, force: true });
          this.rebuildGarbage.delete(path);
        } catch {
          // The quarantined path is outside canonical authority. Keep its
          // durable name and retry without making an already-complete pointer
          // cutover fail after the fact.
        }
      }
    })().finally(() => {
      this.rebuildGarbageDrain = undefined;
      if (this.rebuildGarbage.size === 0) return;
      this.rebuildGarbageRetry = setTimeout(
        () => this.removeRebuildGarbage([]),
        30_000,
      );
      this.rebuildGarbageRetry.unref();
    });
  }

  private async discoverRebuildGarbage(): Promise<string[]> {
    const found: string[] = [];
    let users;
    try {
      users = await readdir(this.options.canonicalRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return found;
      throw error;
    }
    for (const user of users) {
      if (!user.isDirectory() || !user.name.startsWith("user-")) continue;
      const userRoot = join(this.options.canonicalRoot, user.name);
      for (const relationship of await readdir(userRoot, { withFileTypes: true })) {
        if (!relationship.isDirectory() || !relationship.name.startsWith("relationship-")) {
          continue;
        }
        const garbageRoot = join(userRoot, relationship.name, ".rebuild-garbage");
        try {
          for (const entry of await readdir(garbageRoot, { withFileTypes: true })) {
            found.push(join(garbageRoot, entry.name));
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    return found;
  }

  private parseRelationshipRebuildCandidateManifest(
    raw: string,
  ): RelationshipRebuildCandidateManifest {
    const value = JSON.parse(raw) as Partial<RelationshipRebuildCandidateManifest>;
    if (
      typeof value.rebuildId !== "string"
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.rebuildId)
      || !Number.isSafeInteger(value.sessions)
      || Number(value.sessions) < 0
      || !Number.isSafeInteger(value.messages)
      || Number(value.messages) < 0
    ) {
      throw new Error("relationship rebuild candidate manifest is invalid");
    }
    return {
      rebuildId: value.rebuildId,
      sessions: Number(value.sessions),
      messages: Number(value.messages),
      fence: companionWorkspaceRebuildFenceSchema.parse(value.fence),
    };
  }

  private projectionAuthorityVersion(versionName: string): bigint | undefined {
    const match = /^projection-([1-9]\d*)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.exec(
      versionName,
    );
    return match?.[1] ? BigInt(match[1]) : undefined;
  }

  private async purgeEphemeralRelationship(
    identity: { userId: string; characterId: string },
  ): Promise<void> {
    const privateTarget = privateRelationshipWorkspacePath(
      this.options.privateRoot,
      identity.userId,
      identity.characterId,
    );
    assertWithin(this.options.privateRoot, privateTarget);
    await rm(privateTarget, { recursive: true, force: true });
    await rmdir(privateUserWorkspacePath(this.options.privateRoot, identity.userId))
      .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
    });
  }

  private async acquireRelationship(
    userId: string,
    characterId: string,
    authorityRoot = this.options.canonicalRoot,
    signal?: AbortSignal,
  ): Promise<() => void> {
    const relationshipKey = safeKey(authorityRoot, userId, characterId);
    const previous = this.locks.get(relationshipKey) ?? Promise.resolve();
    const mine = deferredLock();
    const queued = previous.then(() => mine.promise);
    this.locks.set(relationshipKey, queued);
    try {
      if (signal) {
        const aborted = Promise.withResolvers<never>();
        const onAbort = () => aborted.reject(
          signal.reason ?? new Error("relationship workspace wait aborted"),
        );
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        try {
          await Promise.race([previous, aborted.promise]);
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
        signal.throwIfAborted();
      } else {
        await previous;
      }
    } catch (error) {
      // INVARIANT: A cancelled waiter stays behind the current owner but no
      // longer owns a queue slot. Resolving its node lets later waiters advance
      // only after the preceding owner releases the relationship.
      mine.release();
      void queued.then(() => {
        if (this.locks.get(relationshipKey) === queued) this.locks.delete(relationshipKey);
      });
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      mine.release();
      if (this.locks.get(relationshipKey) === queued) this.locks.delete(relationshipKey);
    };
  }

  private async ensurePrivateRelationshipDirectory(
    authorityRoot: string,
    userId: string,
    characterId: string,
  ): Promise<string> {
    const resolvedRoot = resolve(authorityRoot);
    const userRoot = userWorkspacePath(resolvedRoot, userId);
    const relationshipRoot = relationshipWorkspacePath(
      resolvedRoot,
      userId,
      characterId,
    );
    assertWithin(resolvedRoot, relationshipRoot);
    await mkdir(relationshipRoot, { recursive: true, mode: 0o700 });
    // The default private root may be the shared OS tmpdir; never chmod that
    // global directory. Every product-owned descendant still fails closed.
    const owned = resolve(resolvedRoot) === resolve(tmpdir())
      ? [userRoot, relationshipRoot]
      : [resolvedRoot, userRoot, relationshipRoot];
    for (const path of owned) await chmod(path, 0o700);
    return relationshipRoot;
  }

  private async canonicalVersion(
    canonicalLink: string,
    versionsRoot: string,
  ): Promise<string | undefined> {
    if (!(await exists(canonicalLink))) return undefined;
    const stat = await lstat(canonicalLink);
    if (stat.isSymbolicLink()) {
      const target = resolve(dirname(canonicalLink), await readlink(canonicalLink));
      assertWithin(versionsRoot, target);
      if (!(await exists(target))) throw new Error("canonical igrep pointer target is missing");
      return target;
    }
    if (!stat.isDirectory()) throw new Error("canonical .igrep must be a directory or symlink");
    const migrated = join(versionsRoot, `migrated-${Date.now()}-${randomUUID()}`);
    await rename(canonicalLink, migrated);
    await symlink(relative(dirname(canonicalLink), migrated), canonicalLink, "dir");
    return migrated;
  }

  private async readCanonicalVersion(
    canonicalLink: string,
    versionsRoot: string,
  ): Promise<string | undefined> {
    if (!(await exists(canonicalLink))) return undefined;
    const stat = await lstat(canonicalLink);
    if (!stat.isSymbolicLink()) return undefined;
    const target = resolve(dirname(canonicalLink), await readlink(canonicalLink));
    assertWithin(versionsRoot, target);
    if (!(await exists(target))) throw new Error("canonical igrep pointer target is missing");
    return target;
  }

  private async ensureCanonicalVersion(canonicalLink: string, versionsRoot: string): Promise<string> {
    const current = await this.canonicalVersion(canonicalLink, versionsRoot);
    if (current) return current;
    const initial = join(versionsRoot, `initial-${randomUUID()}`);
    await mkdir(initial, { mode: 0o700 });
    await chmod(initial, 0o700);
    const nextLink = `${canonicalLink}.next-${randomUUID()}`;
    await symlink(relative(dirname(canonicalLink), initial), nextLink, "dir");
    await rename(nextLink, canonicalLink);
    return initial;
  }

  private async waitForLifecycle(workspace: string, before: MemoryStatus): Promise<void> {
    const deadline = Date.now() + this.options.verificationTimeoutMs;
    const tracksMaintenance = Object.hasOwn(before, "lastMaintainAt");
    let latest: MemoryStatus = before;
    let sawPendingProfileRows = false;
    do {
      latest = await this.options.memoryProbe.status(workspace);
      if ((latest.pendingProfileRows ?? 0) > 0) sawPendingProfileRows = true;
      const ingestObserved = latest.dialogueFiles > before.dialogueFiles;
      // SPEC: promotion needs the turn's dialogue ingested and the plugin's
      // profile pass finished — finished, not necessarily clean. Rows the LLM
      // pass could not fold stay pending and the next turn's pass retries them.
      // INTENT: rejecting the whole attempt for leftover rows only produced a
      // canonical rebuild that re-ran the same LLM work under the same GPU
      // pressure. The rename below must still never race a running pass, so
      // "finished" is evidenced by memory-status, not by elapsed time.
      const maintainFinished = !tracksMaintenance || (
        latest.lastMaintainAt !== null
        && latest.lastMaintainAt !== undefined
        && (latest.lastMaintainAt !== before.lastMaintainAt
          || (latest.processedProfileRows ?? 0) > (before.processedProfileRows ?? 0)
          || (sawPendingProfileRows && (latest.pendingProfileRows ?? 0) === 0))
      );
      if (ingestObserved && maintainFinished) return;
      await new Promise((resolve) => setTimeout(resolve, this.options.verificationPollMs));
    } while (Date.now() < deadline);
    throw new Error(
      `igrep lifecycle was not observable through memory-status: dialogueFiles ${before.dialogueFiles} -> ${latest.dialogueFiles}, lastMaintain ${before.lastMaintainAt ?? "none"} -> ${latest.lastMaintainAt ?? "none"}`,
    );
  }

  private async waitForMaintain(workspace: string, before: MemoryStatus): Promise<void> {
    if (!Object.hasOwn(before, "lastMaintainAt")) {
      await new Promise((resolveWait) => setTimeout(resolveWait, this.options.verificationPollMs));
      return;
    }
    const deadline = Date.now() + this.options.verificationTimeoutMs;
    let latest = before;
    while (Date.now() <= deadline) {
      latest = await this.options.memoryProbe.status(workspace);
      if (latest.lastMaintainAt && latest.lastMaintainAt !== before.lastMaintainAt) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, this.options.verificationPollMs));
    }
    throw new Error(
      `igrep disposal maintain did not settle: lastMaintain ${before.lastMaintainAt ?? "none"} -> ${latest.lastMaintainAt ?? "none"}`,
    );
  }
}
