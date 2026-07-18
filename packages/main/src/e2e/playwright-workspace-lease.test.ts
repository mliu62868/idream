import { spawn, type ChildProcess } from "node:child_process";
import {
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { acquirePlaywrightWorkspaceLease } from "./playwright-workspace-lease";

const mainRoot = path.resolve(import.meta.dirname, "../..");
const adminRoot = path.resolve(mainRoot, "../admin");
const leasePath = path.resolve(
  mainRoot,
  "data/playwright-workspace-lease.json",
);
const mainNextEnvPath = path.resolve(mainRoot, "next-env.d.ts");
const adminNextEnvPath = path.resolve(adminRoot, "next-env.d.ts");

describe("Playwright workspace lease authority", () => {
  it("publishes exactly one complete ready record under contention", async () => {
    const attempts = await Promise.allSettled(
      [
        "01010101",
        "02020202",
        "03030303",
        "04040404",
        "05050505",
        "06060606",
      ].map((runId) => acquirePlaywrightWorkspaceLease(runId)),
    );
    const acquired = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<
        Awaited<ReturnType<typeof acquirePlaywrightWorkspaceLease>>
      > => attempt.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === "rejected",
    );

    try {
      expect(acquired).toHaveLength(1);
      expect(rejected).toHaveLength(5);
      for (const attempt of rejected) {
        expect(String(attempt.reason)).toMatch(
          /already owns|already owns or initializes/,
        );
        expect(String(attempt.reason)).not.toContain("incomplete or invalid");
      }
      expect(JSON.parse(await readFile(leasePath, "utf8"))).toMatchObject({
        schemaVersion: 2,
        state: "ready",
      });
    } finally {
      await acquired[0]?.value.release();
    }
  });

  it("never overwrites an incomplete recovery record", async () => {
    await writeFile(leasePath, "", { flag: "wx", mode: 0o600 });
    try {
      await expect(
        acquirePlaywrightWorkspaceLease("abcdef12"),
      ).rejects.toThrow("incomplete or invalid");
      expect(await readFile(leasePath, "utf8")).toBe("");
    } finally {
      await rm(leasePath, { force: true });
    }
  });

  it("restores a SIGKILLed owner's baseline before the successor snapshots", async () => {
    const originals = await snapshotNextEnvFiles();
    let child: ChildProcess | null = null;
    let successor:
      | Awaited<ReturnType<typeof acquirePlaywrightWorkspaceLease>>
      | null = null;
    try {
      child = startCrashableLeaseOwner();
      await waitForReady(child);
      child.kill("SIGKILL");
      await waitForExit(child);
      child = null;

      successor = await acquirePlaywrightWorkspaceLease("2222aaaa");
      expect(await readFile(mainNextEnvPath, "utf8")).toBe(
        originals.main.content,
      );
      expect(await readFile(adminNextEnvPath, "utf8")).toBe(
        originals.admin.content,
      );
    } finally {
      if (child) {
        child.kill("SIGKILL");
        await waitForExit(child).catch(() => undefined);
      }
      await successor?.release().catch(() => undefined);
      await restoreNextEnvFiles(originals);
      await rm(leasePath, { force: true });
    }
  });

  it("single-flights concurrent release and cannot delete a successor lease", async () => {
    const originals = await snapshotNextEnvFiles();
    const first = await acquirePlaywrightWorkspaceLease("3333aaaa");
    let successor:
      | Awaited<ReturnType<typeof acquirePlaywrightWorkspaceLease>>
      | null = null;
    try {
      await writePollutedNextEnv("first-owner");
      const successorPromise = eventuallyAcquire("4444bbbb");
      const releaseOne = first.release();
      const releaseTwo = first.release();
      expect(releaseOne).toBe(releaseTwo);

      await Promise.all([releaseOne, releaseTwo]);
      successor = await successorPromise;
      await writePollutedNextEnv("successor-owner");

      // A late release call is the same settled operation. It cannot re-run
      // validation/removal after the successor has published its own record.
      await first.release();
      expect(await readFile(mainNextEnvPath, "utf8")).toContain(
        "successor-owner",
      );
      await expect(
        acquirePlaywrightWorkspaceLease("5555cccc"),
      ).rejects.toThrow(/already owns|already owns or initializes/);

      await successor.release();
      successor = null;
      expect(await readFile(mainNextEnvPath, "utf8")).toBe(
        originals.main.content,
      );
      expect(await readFile(adminNextEnvPath, "utf8")).toBe(
        originals.admin.content,
      );
    } finally {
      await first.release().catch(() => undefined);
      await successor?.release().catch(() => undefined);
      await restoreNextEnvFiles(originals);
      await rm(leasePath, { force: true });
    }
  });
});

function startCrashableLeaseOwner() {
  const moduleUrl = pathToFileURL(
    path.resolve(import.meta.dirname, "playwright-workspace-lease.ts"),
  ).href;
  const script = `
    import { writeFile } from "node:fs/promises";
    const { acquirePlaywrightWorkspaceLease } = await import(${JSON.stringify(moduleUrl)});
    await acquirePlaywrightWorkspaceLease("1111aaaa");
    await Promise.all([
      writeFile(${JSON.stringify(mainNextEnvPath)}, "dead-owner-main\\n"),
      writeFile(${JSON.stringify(adminNextEnvPath)}, "dead-owner-admin\\n"),
    ]);
    process.stdout.write("READY\\n");
    await new Promise(() => {});
  `;
  return spawn(process.execPath, ["--eval", script], {
    cwd: mainRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForReady(child: ChildProcess) {
  let output = "";
  let errors = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Lease owner did not become ready: ${errors}`));
    }, 5_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (!output.includes("READY\n")) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Lease owner exited before ready (${code ?? signal ?? "unknown"}): ${errors}`,
        ),
      );
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function waitForExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
}

async function eventuallyAcquire(runId: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await acquirePlaywrightWorkspaceLease(runId);
    } catch (error) {
      lastError = error;
      if (!String(error).match(/already owns|already owns or initializes/)) {
        throw error;
      }
      await delay(5);
    }
  }
  throw lastError;
}

async function snapshotNextEnvFiles() {
  return {
    main: await snapshotFile(mainNextEnvPath),
    admin: await snapshotFile(adminNextEnvPath),
  };
}

async function snapshotFile(filePath: string) {
  try {
    return {
      exists: true as const,
      content: await readFile(filePath, "utf8"),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {
        exists: false as const,
        content: "",
      };
    }
    throw error;
  }
}

async function restoreNextEnvFiles(
  snapshots: Awaited<ReturnType<typeof snapshotNextEnvFiles>>,
) {
  await Promise.all([
    restoreFile(mainNextEnvPath, snapshots.main),
    restoreFile(adminNextEnvPath, snapshots.admin),
  ]);
}

async function restoreFile(
  filePath: string,
  snapshot: Awaited<ReturnType<typeof snapshotFile>>,
) {
  if (!snapshot.exists) {
    await rm(filePath, { force: true });
    return;
  }
  await writeFile(filePath, snapshot.content);
}

async function writePollutedNextEnv(owner: string) {
  await Promise.all([
    writeFile(mainNextEnvPath, `${owner}-main\n`),
    writeFile(adminNextEnvPath, `${owner}-admin\n`),
  ]);
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
