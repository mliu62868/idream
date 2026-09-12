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
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  companionWorkspaceRebuildFenceSchema,
  type CompanionWorkspaceRebuildFence,
} from "@idream/shared/chat/companion-runtime";
import type { CompanionInvocation } from "./contracts";
import { assertNotFenced, fenceUser } from "../fence.js";

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
  discard(): Promise<void>;
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
  private readonly options: {
    canonicalRoot: string;
    privateRoot: string;
  };

  constructor(options: AttemptWorkspaceStoreOptions) {
    this.options = {
      ...options,
      privateRoot: options.privateRoot ?? tmpdir(),
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
    await assertNotFenced([
      { scope: "user", userId: invocation.userId },
      {
        scope: "relationship",
        userId: invocation.userId,
        characterId: invocation.characterId,
      },
    ]);
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
      try {
        assertWithin(this.options.canonicalRoot, canonicalTarget);
        assertWithin(this.options.privateRoot, privateTarget);
        const found = await Promise.all([
          exists(canonicalTarget),
          exists(privateTarget),
        ]);
        await rm(canonicalTarget, { recursive: true, force: true });
        // Private attempts hold no memory; there is nothing to analyse.
        await rm(privateTarget, { recursive: true, force: true });
        await Promise.all([
          rmdir(userWorkspacePath(this.options.canonicalRoot, request.userId)),
          rmdir(privateUserWorkspacePath(this.options.privateRoot, request.userId)),
        ].map((cleanup) => cleanup.catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
        })));
        return found.some(Boolean) ? 1 : 0;
      } finally {
        releaseCanonical();
      }
    }
    const releaseUser = await this.acquireUser(request.userId);
    try {
      // INVARIANT: a user-scope workspace purge is account erasure. Fence the
      // user durably before removing bytes, so no later admission, event append
      // or workspace prepare can recreate what this purge is deleting.
      await fenceUser(request.userId);
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
      ]);
      return relationshipNames.size;
    } finally {
      releaseUser();
    }
  }

  async prepareRelationshipRebuild(
    identity: { userId: string; characterId: string },
    fence: CompanionWorkspaceRebuildFence,
    options: { seed: "empty" | "canonical" },
    build: (workspace: string) => Promise<{ sessions: number; messages: number }>,
    signal?: AbortSignal,
  ): Promise<PreparedRelationshipRebuild> {
    const parsedFence = companionWorkspaceRebuildFenceSchema.parse(fence);
    const releaseUser = await this.acquireUser(identity.userId, signal);
    let candidateRoot: string | undefined;
    try {
      await assertNotFenced([{ scope: "user", userId: identity.userId }]);
      const relationshipRoot = await this.ensurePrivateRelationshipDirectory(
        this.options.canonicalRoot,
        identity.userId,
        identity.characterId,
      );
      const candidatesRoot = join(relationshipRoot, ".rebuild-candidates");
      const rebuildId = randomUUID();
      candidateRoot = join(candidatesRoot, rebuildId);
      const workspace = join(candidateRoot, "workspace");
      const memory = join(workspace, ".igrep");
      signal?.throwIfAborted();
      // Each durable claim owns one candidate directory. Removing the shared
      // root here would let a second process destroy a live prepare between
      // Main lease heartbeats.
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      if (options.seed === "canonical") {
        const releaseRelationship = await this.acquireRelationship(
          identity.userId,
          identity.characterId,
          this.options.canonicalRoot,
          signal,
        );
        try {
          const versionsRoot = join(relationshipRoot, ".igrep.versions");
          const canonicalLink = join(relationshipRoot, ".igrep");
          await mkdir(versionsRoot, { recursive: true, mode: 0o700 });
          const canonicalVersion = await this.ensureCanonicalVersion(canonicalLink, versionsRoot);
          await cp(canonicalVersion, memory, { recursive: true, force: false });
        } finally {
          releaseRelationship();
        }
      } else {
        await mkdir(memory, { recursive: true, mode: 0o700 });
      }
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
      if (candidateRoot) {
        await rm(candidateRoot, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    } finally {
      releaseUser();
    }
  }

  async promoteRelationshipRebuild(input: {
    userId: string;
    characterId: string;
    rebuildId: string;
    fence: CompanionWorkspaceRebuildFence;
  }, signal?: AbortSignal): Promise<{ sessions: number; messages: number; superseded?: true }> {
    const fence = companionWorkspaceRebuildFenceSchema.parse(input.fence);
    const releaseUser = await this.acquireUser(input.userId, signal);
    let releaseRelationship: (() => void) | undefined;
    let candidateMoved = false;
    let canonicalChanged = false;
    let priorVersion: string | undefined;
    let relationshipRoot: string | undefined;
    let versionsRoot: string | undefined;
    let canonicalLink: string | undefined;
    let candidateRoot: string | undefined;
    let candidateMemory: string | undefined;
    let candidateVersion: string | undefined;
    try {
      await assertNotFenced([{ scope: "user", userId: input.userId }]);
      releaseRelationship = await this.acquireRelationship(
        input.userId,
        input.characterId,
        this.options.canonicalRoot,
        signal,
      );
      relationshipRoot = await this.ensurePrivateRelationshipDirectory(
        this.options.canonicalRoot,
        input.userId,
        input.characterId,
      );
      versionsRoot = join(relationshipRoot, ".igrep.versions");
      canonicalLink = join(relationshipRoot, ".igrep");
      candidateRoot = join(relationshipRoot, ".rebuild-candidates", input.rebuildId);
      candidateMemory = join(candidateRoot, "workspace", ".igrep");
      candidateVersion = join(
        versionsRoot,
        `projection-${fence.authorityVersion}-${input.rebuildId}`,
      );
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
      if (current && currentAuthority !== undefined && currentAuthority > requestedAuthority) {
        const garbage = await this.quarantineRebuildGarbage(
          relationshipRoot,
          versionsRoot,
          current,
          candidateRoot,
        );
        this.removeRebuildGarbage(garbage);
        return {
          sessions: manifest.sessions,
          messages: manifest.messages,
          superseded: true,
        };
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
      if (canonicalChanged && relationshipRoot && canonicalLink) {
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
      if (candidateMoved && candidateVersion && candidateMemory) {
        await rename(candidateVersion, candidateMemory).catch(() => undefined);
      }
      throw error;
    } finally {
      releaseRelationship?.();
      releaseUser();
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
    return { path, mode: "private", discard };
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
    let relationshipReleased = false;
    let attemptRoot: string | undefined;
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
      // The attempt owns an immutable copy. Holding the relationship lock for
      // model latency would make an unrelated Main projection wait for a turn.
      release();
      relationshipReleased = true;
      let finished = false;

      const discard = async () => {
        if (finished) return;
        finished = true;
        await rm(ownedAttemptRoot, { recursive: true, force: true });
      };
      return { path: workspace, mode: "normal", discard };
    } catch (error) {
      if (attemptRoot) {
        await rm(attemptRoot, { recursive: true, force: true }).catch(() => undefined);
      }
      if (!relationshipReleased) release();
      throw error;
    }
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

  private async acquireRelationship(
    userId: string,
    characterId: string,
    authorityRoot = this.options.canonicalRoot,
    signal?: AbortSignal,
  ): Promise<() => void> {
    return this.acquireLock(
      `relationship:${safeKey(authorityRoot, userId, characterId)}`,
      "relationship workspace",
      signal,
    );
  }

  private async acquireUser(userId: string, signal?: AbortSignal): Promise<() => void> {
    return this.acquireLock(
      `user:${safeKey(this.options.canonicalRoot, userId)}`,
      "user workspace",
      signal,
    );
  }

  private async acquireLock(
    key: string,
    label: string,
    signal?: AbortSignal,
  ): Promise<() => void> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const mine = deferredLock();
    const queued = previous.then(() => mine.promise);
    this.locks.set(key, queued);
    try {
      if (signal) {
        const aborted = Promise.withResolvers<never>();
        const onAbort = () => aborted.reject(
          signal.reason ?? new Error(`${label} wait aborted`),
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
        if (this.locks.get(key) === queued) this.locks.delete(key);
      });
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      mine.release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
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

}
