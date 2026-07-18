import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type Server,
} from "node:net";
import path from "node:path";

const MAIN_PACKAGE_ROOT = process.cwd().endsWith(path.join("packages", "main"))
  ? process.cwd()
  : path.resolve(process.cwd(), "packages/main");
const ADMIN_PACKAGE_ROOT = path.resolve(MAIN_PACKAGE_ROOT, "../admin");
const LEASE_PATH = path.resolve(
  MAIN_PACKAGE_ROOT,
  "data/playwright-workspace-lease.json",
);
const MAIN_NEXT_ENV_PATH = path.resolve(MAIN_PACKAGE_ROOT, "next-env.d.ts");
const ADMIN_NEXT_ENV_PATH = path.resolve(ADMIN_PACKAGE_ROOT, "next-env.d.ts");
const AUTHORITY_HOST = "127.0.0.1";
const AUTHORITY_PORT = workspaceAuthorityPort(MAIN_PACKAGE_ROOT);

type FileSnapshot = {
  readonly exists: boolean;
  readonly contentBase64: string | null;
};

type LegacyWorkspaceLeaseRecord = {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly runId: string;
  readonly mainNextEnv: FileSnapshot;
  readonly adminNextEnv: FileSnapshot;
};

type WorkspaceLeaseRecord = {
  readonly schemaVersion: 2;
  readonly state: "ready";
  readonly pid: number;
  readonly runId: string;
  readonly ownerId: string;
  readonly authorityPort: number;
  readonly mainNextEnv: FileSnapshot;
  readonly adminNextEnv: FileSnapshot;
};

type RecoverableWorkspaceLeaseRecord =
  | LegacyWorkspaceLeaseRecord
  | WorkspaceLeaseRecord;

type LeaseReadResult =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "ready";
      readonly record: RecoverableWorkspaceLeaseRecord;
    };

export type PlaywrightWorkspaceLease = {
  readonly release: () => Promise<void>;
};

/**
 * The kernel-owned loopback listener is the lease authority. It is acquired
 * before any next-env snapshot is read and is released automatically if the
 * process dies. The JSON file is only a complete, atomically-replaced recovery
 * record; it is never used as a compare-and-swap mutex.
 */
export async function acquirePlaywrightWorkspaceLease(
  runId: string,
): Promise<PlaywrightWorkspaceLease> {
  if (!/^[a-f0-9]{8}$/.test(runId)) {
    throw new Error("Playwright workspace lease run id is invalid");
  }
  await mkdir(path.dirname(LEASE_PATH), { recursive: true });

  const authority = await acquireKernelAuthority().catch(async (error) => {
    if (!isAddressInUseError(error)) throw error;
    const existing = await readLeaseRecord();
    if (existing.kind === "ready") throw workspaceOwnedError(existing.record);
    throw new Error(
      `Another Playwright process already owns or initializes this workspace through ${AUTHORITY_HOST}:${AUTHORITY_PORT}; use a separate worktree for concurrent browser runs`,
      { cause: error },
    );
  });

  try {
    const existing = await readLeaseRecord();
    if (existing.kind === "invalid") {
      throw new Error(
        "Playwright workspace recovery record is incomplete or invalid; refusing to overwrite it automatically",
      );
    }
    if (existing.kind === "ready") {
      assertRecoverableRecord(existing.record);
      await restoreNextEnvSnapshots(existing.record);
    }

    // The authority has already been claimed and any dead owner's snapshots
    // have already been restored. A new owner can therefore never persist the
    // previous run's generated next-env state as its own baseline.
    const snapshots = await Promise.all([
      snapshotFile(MAIN_NEXT_ENV_PATH),
      snapshotFile(ADMIN_NEXT_ENV_PATH),
    ]);
    const record: WorkspaceLeaseRecord = {
      schemaVersion: 2,
      state: "ready",
      pid: process.pid,
      runId,
      ownerId: randomUUID(),
      authorityPort: AUTHORITY_PORT,
      mainNextEnv: snapshots[0],
      adminNextEnv: snapshots[1],
    };
    await publishLeaseRecord(record);
    return {
      release: createLeaseRelease(record, authority),
    };
  } catch (error) {
    await closeAuthority(authority);
    throw error;
  }
}

async function acquireKernelAuthority() {
  const authority = createServer((socket) => {
    socket.destroy();
  });
  return await new Promise<Server>((resolve, reject) => {
    const handleError = (error: Error) => {
      reject(error);
    };
    authority.once("error", handleError);
    authority.listen(
      {
        host: AUTHORITY_HOST,
        port: AUTHORITY_PORT,
        exclusive: true,
      },
      () => {
        authority.removeListener("error", handleError);
        resolve(authority);
      },
    );
  });
}

async function publishLeaseRecord(record: WorkspaceLeaseRecord) {
  const candidatePath = `${LEASE_PATH}.${record.ownerId}.tmp`;
  const handle = await open(candidatePath, "wx", 0o600);
  let closed = false;
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    closed = true;
    // rename is the only visible transition: observers see either the complete
    // previous recovery record or the complete new ready record.
    await rename(candidatePath, LEASE_PATH);
  } finally {
    if (!closed) await handle.close().catch(() => undefined);
    await rm(candidatePath, { force: true }).catch(() => undefined);
  }
}

function workspaceOwnedError(record: RecoverableWorkspaceLeaseRecord) {
  return new Error(
    `Playwright run ${record.runId} (pid ${record.pid}) already owns this workspace; use a separate worktree for concurrent browser runs`,
  );
}

function createLeaseRelease(
  record: WorkspaceLeaseRecord,
  authority: Server,
) {
  let releasePromise: Promise<void> | null = null;
  const performRelease = async () => {
    try {
      const current = await readLeaseRecord();
      const stillOwnsRecord =
        current.kind === "ready" &&
        current.record.schemaVersion === 2 &&
        current.record.ownerId === record.ownerId &&
        current.record.pid === record.pid &&
        current.record.runId === record.runId;

      // The socket remains the exclusive authority until both files have been
      // restored. Keep the recovery record when ownership metadata is damaged
      // so a later run fails closed instead of snapshotting polluted state.
      await restoreNextEnvSnapshots(record);
      if (!stillOwnsRecord) {
        throw new Error("Playwright workspace recovery record changed");
      }
      await rm(LEASE_PATH);
    } finally {
      await closeAuthority(authority);
    }
  };

  return () => {
    releasePromise ??= performRelease();
    return releasePromise;
  };
}

async function closeAuthority(authority: Server) {
  if (!authority.listening) return;
  await new Promise<void>((resolve, reject) => {
    authority.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function readLeaseRecord(): Promise<LeaseReadResult> {
  let rawValue: string;
  try {
    rawValue = await readFile(LEASE_PATH, "utf8");
  } catch (error) {
    if (isFileMissingError(error)) return { kind: "missing" };
    throw error;
  }
  try {
    const value = JSON.parse(rawValue) as Record<string, unknown>;
    if (
      !Number.isInteger(value.pid) ||
      Number(value.pid) < 1 ||
      typeof value.runId !== "string" ||
      !/^[a-f0-9]{8}$/.test(value.runId) ||
      !isFileSnapshot(value.mainNextEnv) ||
      !isFileSnapshot(value.adminNextEnv)
    ) {
      return { kind: "invalid" };
    }
    if (value.schemaVersion === 1) {
      return {
        kind: "ready",
        record: value as LegacyWorkspaceLeaseRecord,
      };
    }
    if (
      value.schemaVersion !== 2 ||
      value.state !== "ready" ||
      typeof value.ownerId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(value.ownerId) ||
      value.authorityPort !== AUTHORITY_PORT
    ) {
      return { kind: "invalid" };
    }
    return {
      kind: "ready",
      record: value as WorkspaceLeaseRecord,
    };
  } catch {
    return { kind: "invalid" };
  }
}

function assertRecoverableRecord(record: RecoverableWorkspaceLeaseRecord) {
  if (record.schemaVersion === 1 && processIsAlive(record.pid)) {
    throw workspaceOwnedError(record);
  }
}

async function snapshotFile(filePath: string): Promise<FileSnapshot> {
  try {
    const content = await readFile(filePath);
    return {
      exists: true,
      contentBase64: content.toString("base64"),
    };
  } catch (error) {
    if (isFileMissingError(error)) {
      return {
        exists: false,
        contentBase64: null,
      };
    }
    throw error;
  }
}

async function restoreNextEnvSnapshots(
  record: RecoverableWorkspaceLeaseRecord,
) {
  await Promise.all([
    restoreFile(MAIN_NEXT_ENV_PATH, record.mainNextEnv),
    restoreFile(ADMIN_NEXT_ENV_PATH, record.adminNextEnv),
  ]);
}

async function restoreFile(filePath: string, snapshot: FileSnapshot) {
  if (!snapshot.exists) {
    await rm(filePath, { force: true });
    return;
  }
  await writeFile(
    filePath,
    Buffer.from(snapshot.contentBase64 ?? "", "base64"),
  );
}

function isFileSnapshot(value: unknown): value is FileSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FileSnapshot>;
  return (
    typeof candidate.exists === "boolean" &&
    (typeof candidate.contentBase64 === "string" ||
      candidate.contentBase64 === null) &&
    (candidate.exists
      ? typeof candidate.contentBase64 === "string"
      : candidate.contentBase64 === null)
  );
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function workspaceAuthorityPort(packageRoot: string) {
  const digest = createHash("sha256").update(packageRoot).digest();
  return 42_000 + (digest.readUInt32BE(0) % 6_000);
}

function isAddressInUseError(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "EADDRINUSE"
  );
}

function isFileMissingError(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
