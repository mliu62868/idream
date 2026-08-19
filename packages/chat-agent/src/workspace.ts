import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
  releasedKnowledgeSnapshotSchema,
  type CompanionInvocation,
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
  readonly mode: "normal" | "private" | "shadow";
  commit(): Promise<void>;
  discard(): Promise<void>;
  settleAndDiscard(): Promise<void>;
}

export interface AttemptWorkspaceStoreOptions {
  canonicalRoot: string;
  shadowRoot?: string;
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

function legacyMemoryImportUserMetaPath(canonicalRoot: string, userId: string): string {
  return join(resolve(canonicalRoot), "_meta", `user-${safeKey(userId)}`);
}

export function legacyMemoryImportMarkerPath(
  canonicalRoot: string,
  userId: string,
  characterId: string,
): string {
  return join(
    legacyMemoryImportUserMetaPath(canonicalRoot, userId),
    `relationship-${safeKey(userId, characterId)}.json`,
  );
}

export interface LegacyMemoryImportMarker {
  checksum: string;
  igrepVersion: string;
  workspaceVersion: string;
  status: "cutover_ready";
  recallParity: LegacyRecallParityEvidence;
  completedAt: string;
}

export interface LegacyRecallParityProbeEvidence {
  probeId: string;
  queryHash: string;
  legacyExpectedHash: string;
  recallContextHash: string;
  hitCount: number;
}

export interface LegacyRecallParityEvidence {
  probeSetChecksum: string;
  total: number;
  passed: number;
  probes: LegacyRecallParityProbeEvidence[];
}

export interface VerifiedLegacyMemoryImport {
  entries: number;
  written: number;
  igrepVersion: string;
  recallParity: LegacyRecallParityEvidence;
}

type LegacyMemoryImportMarkerInput = Pick<LegacyMemoryImportMarker, "checksum" | "igrepVersion"> & {
  probeSetChecksum: string;
  completedAt?: string;
};

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
    Omit<AttemptWorkspaceStoreOptions, "privateRoot" | "shadowRoot">
  > & {
    privateRoot: string;
    shadowRoot: string;
  };

  constructor(options: AttemptWorkspaceStoreOptions) {
    this.options = {
      ...options,
      privateRoot: options.privateRoot ?? tmpdir(),
      shadowRoot: options.shadowRoot ?? `${resolve(options.canonicalRoot)}-shadow`,
      verificationTimeoutMs: options.verificationTimeoutMs ?? 5_000,
      verificationPollMs: options.verificationPollMs ?? 50,
    };
  }

  async prepare(invocation: CompanionInvocation): Promise<AttemptWorkspace> {
    if (invocation.memoryMode === "private") return this.preparePrivate(invocation);
    if (invocation.memoryMode === "shadow") {
      return this.prepareNormal(invocation, this.options.shadowRoot, "shadow");
    }
    return this.prepareNormal(invocation, this.options.canonicalRoot, "normal");
  }

  async purge(request: WorkspacePurgeRequest): Promise<number> {
    if (request.scope === "relationship") {
      const releaseCanonical = await this.acquireRelationship(
        request.userId,
        request.characterId,
        this.options.canonicalRoot,
      );
      const releaseShadow = await this.acquireRelationship(
        request.userId,
        request.characterId,
        this.options.shadowRoot,
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
      const markerTarget = legacyMemoryImportMarkerPath(
        this.options.canonicalRoot,
        request.userId,
        request.characterId,
      );
      try {
        const shadowTarget = relationshipWorkspacePath(
          this.options.shadowRoot,
          request.userId,
          request.characterId,
        );
        assertWithin(this.options.canonicalRoot, canonicalTarget);
        assertWithin(this.options.canonicalRoot, markerTarget);
        assertWithin(this.options.privateRoot, privateTarget);
        assertWithin(this.options.shadowRoot, shadowTarget);
        const found = await Promise.all([
          exists(canonicalTarget),
          exists(privateTarget),
          exists(shadowTarget),
          exists(markerTarget),
        ]);
        await Promise.all([
          rm(canonicalTarget, { recursive: true, force: true }),
          rm(privateTarget, { recursive: true, force: true }),
          rm(shadowTarget, { recursive: true, force: true }),
          rm(markerTarget, { force: true }),
        ]);
        await rmdir(legacyMemoryImportUserMetaPath(this.options.canonicalRoot, request.userId))
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
          });
        await Promise.all([
          rmdir(userWorkspacePath(this.options.canonicalRoot, request.userId)),
          rmdir(privateUserWorkspacePath(this.options.privateRoot, request.userId)),
          rmdir(userWorkspacePath(this.options.shadowRoot, request.userId)),
        ].map((cleanup) => cleanup.catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
        })));
        return found.some(Boolean) ? 1 : 0;
      } finally {
        releaseShadow();
        releaseCanonical();
      }
    }
    const canonicalTarget = userWorkspacePath(this.options.canonicalRoot, request.userId);
    const privateTarget = privateUserWorkspacePath(this.options.privateRoot, request.userId);
    const shadowTarget = userWorkspacePath(this.options.shadowRoot, request.userId);
    const markerTarget = legacyMemoryImportUserMetaPath(this.options.canonicalRoot, request.userId);
    assertWithin(this.options.canonicalRoot, canonicalTarget);
    assertWithin(this.options.canonicalRoot, markerTarget);
    assertWithin(this.options.privateRoot, privateTarget);
    assertWithin(this.options.shadowRoot, shadowTarget);
    const relationshipNames = new Set<string>();
    for (const target of [canonicalTarget, privateTarget, shadowTarget]) {
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
      rm(shadowTarget, { recursive: true, force: true }),
      rm(markerTarget, { recursive: true, force: true }),
    ]);
    return relationshipNames.size;
  }

  async rebuildRelationship<T>(
    identity: { userId: string; characterId: string },
    build: (workspace: string) => Promise<T>,
  ): Promise<T> {
    const release = await this.acquireRelationship(identity.userId, identity.characterId);
    const releaseShadow = await this.acquireRelationship(
      identity.userId,
      identity.characterId,
      this.options.shadowRoot,
    );
    try {
      await this.purgeEphemeralRelationship(identity);
      return await this.replaceRelationshipLocked(identity, build);
    } finally {
      releaseShadow();
      release();
    }
  }

  async importLegacyMemory(
    identity: { userId: string; characterId: string },
    marker: LegacyMemoryImportMarkerInput,
    build: (workspace: string) => Promise<VerifiedLegacyMemoryImport>,
    signal?: AbortSignal,
  ): Promise<
    | { skipped: true; marker: LegacyMemoryImportMarker }
    | { skipped: false; result: VerifiedLegacyMemoryImport; marker: LegacyMemoryImportMarker }
  > {
    this.assertLegacyMemoryImportMarkerIdentity(marker);
    if (!/^[a-f0-9]{64}$/.test(marker.probeSetChecksum)) {
      throw new Error("legacy recall probe-set checksum is invalid");
    }
    if (marker.completedAt !== undefined && !Number.isFinite(Date.parse(marker.completedAt))) {
      throw new Error("legacy memory import marker completion time is invalid");
    }
    this.throwIfAborted(signal);
    const release = await this.acquireRelationship(identity.userId, identity.characterId);
    try {
      this.throwIfAborted(signal);
      const markerPath = legacyMemoryImportMarkerPath(
        this.options.canonicalRoot,
        identity.userId,
        identity.characterId,
      );
      const current = await this.readLegacyMemoryImportMarker(markerPath);
      const canonicalLink = join(
        relationshipWorkspacePath(
          this.options.canonicalRoot,
          identity.userId,
          identity.characterId,
        ),
        ".igrep",
      );
      const canonicalVersion = await this.canonicalVersion(
        canonicalLink,
        join(dirname(canonicalLink), ".igrep.versions"),
      );
      if (
        current?.checksum === marker.checksum
        && current.igrepVersion === marker.igrepVersion
        && current.recallParity.probeSetChecksum === marker.probeSetChecksum
        && current.workspaceVersion === basename(canonicalVersion ?? "")
      ) {
        return { skipped: true, marker: current };
      }
      let completedMarker: LegacyMemoryImportMarker | undefined;
      const result = await this.replaceRelationshipLocked(identity, build, {
        path: markerPath,
        value: (verified, workspaceVersion) => {
          if (verified.igrepVersion !== marker.igrepVersion) {
            throw new Error("igrep legacy memory import version drifted");
          }
          if (verified.recallParity.probeSetChecksum !== marker.probeSetChecksum) {
            throw new Error("legacy recall parity probe-set checksum drifted");
          }
          completedMarker = {
            checksum: marker.checksum,
            igrepVersion: marker.igrepVersion,
            workspaceVersion,
            status: "cutover_ready",
            recallParity: verified.recallParity,
            // INVARIANT: completion is recorded only after record, maintain,
            // strict doctor, and every recall parity probe have returned
            // successfully from build().
            completedAt: marker.completedAt ?? new Date().toISOString(),
          };
          this.assertLegacyMemoryImportMarker(completedMarker);
          return completedMarker;
        },
      }, signal);
      if (!completedMarker) throw new Error("legacy memory import marker was not completed");
      return { skipped: false, result, marker: completedMarker };
    } finally {
      release();
    }
  }

  private async replaceRelationshipLocked<T>(
    identity: { userId: string; characterId: string },
    build: (workspace: string) => Promise<T>,
    marker?: {
      path: string;
      value: LegacyMemoryImportMarker | (
        (result: T, workspaceVersion: string) => LegacyMemoryImportMarker
      );
    },
    signal?: AbortSignal,
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
    let nextMarker: string | undefined;
    let priorVersion: string | undefined;
    let result!: T;
    try {
      this.throwIfAborted(signal);
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
      this.throwIfAborted(signal);
      if (marker) {
        const markerValue = typeof marker.value === "function"
          ? marker.value(result, basename(candidateVersion))
          : marker.value;
        assertWithin(this.options.canonicalRoot, marker.path);
        await mkdir(dirname(marker.path), { recursive: true });
        nextMarker = `${marker.path}.next-${randomUUID()}`;
        await writeFile(nextMarker, `${JSON.stringify(markerValue)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      }
      // igrep 0.1.132 refuses a workspace whose .igrep resolves outside the
      // workspace. Build and verify in a real directory, then move that exact
      // certified directory into the version authority before pointer swap.
      await rename(candidateMemory, candidateVersion);
      this.throwIfAborted(signal);
      nextLink = join(relationshipRoot, `.igrep.next-${randomUUID()}`);
      await symlink(relative(relationshipRoot, candidateVersion), nextLink, "dir");
      this.throwIfAborted(signal);
      await rename(nextLink, canonicalLink);
      canonicalChanged = true;
      promoted = true;
      this.throwIfAborted(signal);
      await rm(rebuildRoot, { recursive: true, force: true });
      await this.garbageCollectVersions(versionsRoot, candidateVersion);
      if (marker && nextMarker) {
        await rename(nextMarker, marker.path);
        nextMarker = undefined;
      }
      return result;
    } finally {
      if (nextLink) await rm(nextLink, { recursive: true, force: true }).catch(() => undefined);
      if (nextMarker) await rm(nextMarker, { force: true }).catch(() => undefined);
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

  private assertLegacyMemoryImportMarker(marker: LegacyMemoryImportMarker): void {
    this.assertLegacyMemoryImportMarkerIdentity(marker);
    if (!/^(?:rebuild|migrated)-\d+-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
      .test(marker.workspaceVersion)) {
      throw new Error("legacy memory import marker workspace version is invalid");
    }
    if (marker.status !== "cutover_ready") {
      throw new Error("legacy memory import marker is not cutover-ready");
    }
    this.assertLegacyRecallParity(marker.recallParity);
    if (!Number.isFinite(Date.parse(marker.completedAt))) {
      throw new Error("legacy memory import marker completion time is invalid");
    }
  }

  private assertLegacyRecallParity(parity: LegacyRecallParityEvidence): void {
    if (!/^[a-f0-9]{64}$/.test(parity.probeSetChecksum)
      || !Number.isSafeInteger(parity.total)
      || parity.total <= 0
      || parity.passed !== parity.total
      || parity.probes.length !== parity.total) {
      throw new Error("legacy recall parity evidence is incomplete");
    }
    const probeIds = new Set<string>();
    for (const probe of parity.probes) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(probe.probeId)
        || probeIds.has(probe.probeId)
        || ![probe.queryHash, probe.legacyExpectedHash, probe.recallContextHash]
          .every((digest) => /^[a-f0-9]{64}$/.test(digest))
        || !Number.isSafeInteger(probe.hitCount)
        || probe.hitCount < 0) {
        throw new Error("legacy recall parity probe evidence is invalid");
      }
      probeIds.add(probe.probeId);
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("legacy memory import aborted");
  }

  private assertLegacyMemoryImportMarkerIdentity(
    marker: Pick<LegacyMemoryImportMarker, "checksum" | "igrepVersion">,
  ): void {
    if (!/^[a-f0-9]{64}$/.test(marker.checksum)) {
      throw new Error("legacy memory import marker checksum is invalid");
    }
    if (!/^\d+\.\d+\.\d+$/.test(marker.igrepVersion)) {
      throw new Error("legacy memory import marker igrep version is invalid");
    }
  }

  private async readLegacyMemoryImportMarker(
    path: string,
  ): Promise<LegacyMemoryImportMarker | null> {
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
      this.assertLegacyMemoryImportMarkerIdentity(
        value as unknown as Pick<LegacyMemoryImportMarker, "checksum" | "igrepVersion">,
      );
      if (!Number.isFinite(Date.parse(String(value.completedAt)))) {
        throw new Error("legacy memory import marker completion time is invalid");
      }
      return null;
    }
    if (fields === "checksum,completedAt,igrepVersion,recallParity,status") {
      const unbound = value as unknown as Omit<LegacyMemoryImportMarker, "workspaceVersion">;
      this.assertLegacyMemoryImportMarker({
        ...unbound,
        workspaceVersion: `rebuild-0-${randomUUID()}`,
      });
      return null;
    }
    if (fields
      !== "checksum,completedAt,igrepVersion,recallParity,status,workspaceVersion") {
      throw new Error("legacy memory import marker contains unexpected fields");
    }
    const marker = value as unknown as LegacyMemoryImportMarker;
    this.assertLegacyMemoryImportMarker(marker);
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
    authorityRoot: string,
    mode: "normal" | "shadow",
  ): Promise<AttemptWorkspace> {
    const release = await this.acquireRelationship(
      invocation.userId,
      invocation.characterId,
      authorityRoot,
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
        if (mode === "shadow") {
          throw new Error("shadow attempts cannot promote canonical memory");
        }
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
      return { path: workspace, mode, commit, discard, settleAndDiscard };
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
    const shadowTarget = relationshipWorkspacePath(
      this.options.shadowRoot,
      identity.userId,
      identity.characterId,
    );
    assertWithin(this.options.privateRoot, privateTarget);
    assertWithin(this.options.shadowRoot, shadowTarget);
    await Promise.all([
      rm(privateTarget, { recursive: true, force: true }),
      rm(shadowTarget, { recursive: true, force: true }),
    ]);
    await Promise.all([
      rmdir(privateUserWorkspacePath(this.options.privateRoot, identity.userId)),
      rmdir(userWorkspacePath(this.options.shadowRoot, identity.userId)),
    ].map((cleanup) => cleanup.catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
    })));
  }

  private async acquireRelationship(
    userId: string,
    characterId: string,
    authorityRoot = this.options.canonicalRoot,
  ): Promise<() => void> {
    const relationshipKey = safeKey(authorityRoot, userId, characterId);
    const previous = this.locks.get(relationshipKey) ?? Promise.resolve();
    const mine = deferredLock();
    const queued = previous.then(() => mine.promise);
    this.locks.set(relationshipKey, queued);
    await previous;
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
