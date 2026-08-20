import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
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
  releasedKnowledgeSnapshotSchema,
  type CompanionInvocation,
  type CompanionMemoryCutoverSidecarProof,
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

export interface AttemptWorkspaceStoreOptions {
  canonicalRoot: string;
  privateRoot?: string;
  memoryProbe: MemoryProbe;
  verificationTimeoutMs?: number;
  verificationPollMs?: number;
}

export type WorkspacePurgeRequest =
  | { scope: "user"; userId: string }
  | { scope: "relationship"; userId: string; characterId: string };

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
  private readonly options: Required<
    Omit<AttemptWorkspaceStoreOptions, "privateRoot">
  > & {
    privateRoot: string;
  };

  constructor(options: AttemptWorkspaceStoreOptions) {
    this.options = {
      ...options,
      privateRoot: options.privateRoot ?? tmpdir(),
      verificationTimeoutMs: options.verificationTimeoutMs ?? 5_000,
      verificationPollMs: options.verificationPollMs ?? 50,
    };
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
          rm(privateTarget, { recursive: true, force: true }),
          rm(cutoverMarker, { force: true }),
        ]);
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
  ): Promise<T> {
    const release = await this.acquireRelationship(identity.userId, identity.characterId);
    try {
      await this.purgeEphemeralRelationship(identity);
      return await this.replaceRelationshipLocked(identity, build);
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
  ): Promise<T> {
    const relationshipRoot = relationshipWorkspacePath(
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
      await mkdir(versionsRoot, { recursive: true });
      // A prior interrupted rebuild may have left transcripts outside .igrep.
      // The relationship lock makes it safe to clear them before retrying.
      await rm(rebuildsRoot, { recursive: true, force: true });
      await mkdir(workspace, { recursive: true });
      await mkdir(candidateMemory);
      assertWithin(relationshipRoot, rebuildRoot);
      assertWithin(versionsRoot, candidateVersion);
      priorVersion = await this.canonicalVersion(canonicalLink, versionsRoot);
      result = await build(workspace);
      // igrep 0.1.132 refuses a workspace whose .igrep resolves outside the
      // workspace. Build and verify in a real directory, then move that exact
      // certified directory into the version authority before pointer swap.
      await rename(candidateMemory, candidateVersion);
      nextLink = join(relationshipRoot, `.igrep.next-${randomUUID()}`);
      await symlink(relative(relationshipRoot, candidateVersion), nextLink, "dir");
      await rename(nextLink, canonicalLink);
      canonicalChanged = true;
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
    const relationshipRoot = privateRelationshipWorkspacePath(
      this.options.privateRoot,
      invocation.userId,
      invocation.characterId,
    );
    assertWithin(this.options.privateRoot, relationshipRoot);
    await mkdir(relationshipRoot, { recursive: true });
    const path = await mkdtemp(join(relationshipRoot, "attempt-"));
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
      const relationshipRoot = relationshipWorkspacePath(
        authorityRoot,
        invocation.userId,
        invocation.characterId,
      );
      const versionsRoot = join(relationshipRoot, ".igrep.versions");
      const attemptsRoot = join(relationshipRoot, ".attempts");
      const canonicalLink = join(relationshipRoot, ".igrep");
      await mkdir(versionsRoot, { recursive: true });
      await mkdir(attemptsRoot, { recursive: true });
      const canonicalVersion = await this.ensureCanonicalVersion(canonicalLink, versionsRoot);
      const ownedAttemptRoot = join(attemptsRoot, `${safeKey(invocation.attemptId)}-${randomUUID()}`);
      attemptRoot = ownedAttemptRoot;
      const workspace = join(ownedAttemptRoot, "workspace");
      const attemptMemory = join(workspace, ".igrep");
      assertWithin(relationshipRoot, ownedAttemptRoot);
      await mkdir(workspace, { recursive: true });
      await cp(canonicalVersion, attemptMemory, { recursive: true, force: false });
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
    await mkdir(initial);
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
      const maintainFinishedWithPendingRows = tracksMaintenance
        && latest.lastMaintainAt !== null
        && latest.lastMaintainAt !== before.lastMaintainAt
        && (latest.pendingProfileRows ?? 0) > 0;
      if (maintainFinishedWithPendingRows) {
        throw new Error(
          `igrep maintain left ${latest.pendingProfileRows} profile rows pending`,
        );
      }
      const maintainObserved = !tracksMaintenance || (
        latest.pendingProfileRows === 0
        && latest.lastMaintainAt !== null
        && (latest.lastMaintainAt !== before.lastMaintainAt
          || sawPendingProfileRows
          || (latest.processedProfileRows ?? 0) > (before.processedProfileRows ?? 0))
      );
      if (ingestObserved && maintainObserved) return;
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
