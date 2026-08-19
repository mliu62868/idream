import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, readlink, rename, rm, rmdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { CompanionInvocation } from "@idream/shared/chat/companion-runtime";

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
  private readonly options: Required<Omit<AttemptWorkspaceStoreOptions, "privateRoot">> & {
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

  async prepare(invocation: CompanionInvocation): Promise<AttemptWorkspace> {
    if (invocation.memoryMode === "private") return this.preparePrivate(invocation);
    return this.prepareNormal(invocation);
  }

  async purge(request: WorkspacePurgeRequest): Promise<number> {
    if (request.scope === "relationship") {
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
      assertWithin(this.options.canonicalRoot, canonicalTarget);
      assertWithin(this.options.privateRoot, privateTarget);
      const found = await Promise.all([exists(canonicalTarget), exists(privateTarget)]);
      await Promise.all([
        rm(canonicalTarget, { recursive: true, force: true }),
        rm(privateTarget, { recursive: true, force: true }),
      ]);
      return found.some(Boolean) ? 1 : 0;
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
    ]);
    return relationshipNames.size;
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

  private async prepareNormal(invocation: CompanionInvocation): Promise<AttemptWorkspace> {
    const relationshipKey = safeKey(invocation.userId, invocation.characterId);
    const previous = this.locks.get(relationshipKey) ?? Promise.resolve();
    const mine = deferredLock();
    const queued = previous.then(() => mine.promise);
    this.locks.set(relationshipKey, queued);
    await previous;
    const release = () => {
      mine.release();
      if (this.locks.get(relationshipKey) === queued) this.locks.delete(relationshipKey);
    };
    let attemptRoot: string | undefined;
    try {
      const relationshipRoot = relationshipWorkspacePath(
        this.options.canonicalRoot,
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
      const before = await this.options.memoryProbe.status(workspace);
      let finished = false;

      const discard = async () => {
        if (finished) return;
        finished = true;
        try {
          await rm(ownedAttemptRoot, { recursive: true, force: true });
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
          await rm(ownedAttemptRoot, { recursive: true, force: true }).catch(() => undefined);
          if (canonicalVersion !== nextVersion) {
            await rm(canonicalVersion, { recursive: true, force: true }).catch(() => undefined);
          }
        } finally {
          if (!finished) {
            await Promise.all([
              rm(ownedAttemptRoot, { recursive: true, force: true }),
              ...(nextLink ? [rm(nextLink, { recursive: true, force: true })] : []),
              ...(nextVersion ? [rm(nextVersion, { recursive: true, force: true })] : []),
            ]);
          }
          release();
        }
      };
      return { path: workspace, mode: "normal", commit, discard, settleAndDiscard };
    } catch (error) {
      if (attemptRoot) await rm(attemptRoot, { recursive: true, force: true }).catch(() => undefined);
      release();
      throw error;
    }
  }

  private async ensureCanonicalVersion(canonicalLink: string, versionsRoot: string): Promise<string> {
    if (await exists(canonicalLink)) {
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
