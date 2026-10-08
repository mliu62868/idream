import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The worker runs in Bun. Exercise the native lock in real Bun child processes;
// Vitest's Node runtime must not replace it with a second locking algorithm.
const leaseModule = new URL("./generation-accelerator-lease.ts", import.meta.url).pathname;

describe("generation accelerator lease", () => {
  let dir: string | undefined;
  const children: Array<{ child: ChildProcess; done: Promise<{ code: number | null; stdout: string; stderr: string }> }> = [];

  function launch(code: string) {
    const child = spawn("bun", ["-e", `import { withGenerationAcceleratorLease as lease } from ${JSON.stringify(leaseModule)}; ${code}`], {
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", chunk => { stdout += chunk; });
    child.stderr!.on("data", chunk => { stderr += chunk; });
    const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve({ code, stdout, stderr }));
    });
    const result = { child, done };
    children.push(result);
    return result;
  }

  async function hold(lockPath: string) {
    const holder = launch(`await lease("video", async () => {
      console.log("entered"); setInterval(() => {}, 1000); await new Promise(() => {});
    }, { lockPath: ${JSON.stringify(lockPath)}, pollMs: 2 });`);
    await new Promise<void>((resolve, reject) => {
      holder.child.stdout!.on("data", chunk => { if (String(chunk).includes("entered")) resolve(); });
      holder.done.then(result => reject(new Error(`Holder exited before acquisition: ${result.stderr}`)), reject);
    });
    return holder;
  }

  afterEach(async () => {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.allSettled(children.map(child => child.done));
    children.length = 0;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("serializes native image/video processes on the same permanent inode", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "idream-accelerator-"));
    const lockPath = path.join(dir, "device.lock");
    const eventPath = path.join(dir, "events");
    await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, token: "old-owner" }));
    const inode = (await stat(lockPath)).ino;
    const work = Array.from({ length: 8 }, (_, index) => launch(`
      import { appendFile } from "node:fs/promises";
      await lease(${JSON.stringify(index % 2 ? "image" : "video")}, async () => {
        await appendFile(${JSON.stringify(eventPath)}, "${index}:enter\\n");
        await new Promise(resolve => setTimeout(resolve, 20));
        await appendFile(${JSON.stringify(eventPath)}, "${index}:exit\\n");
      }, { lockPath: ${JSON.stringify(lockPath)}, pollMs: 2, waitTimeoutMs: 3000 });
    `));
    for (const result of await Promise.all(work.map(worker => worker.done))) {
      expect(result.stderr).toBe(""); expect(result.code).toBe(0);
    }
    const events = (await readFile(eventPath, "utf8")).trim().split("\n");
    expect(events).toHaveLength(16);
    for (let index = 0; index < events.length; index += 2) expect(events[index + 1]).toBe(events[index].replace(":enter", ":exit"));
    expect((await stat(lockPath)).ino).toBe(inode);
  }, 10_000);

  it("recovers after a killed native owner without deleting the inode or waiting for a stale clock", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "idream-accelerator-"));
    const lockPath = path.join(dir, "device.lock");
    const holder = await hold(lockPath);
    const inode = (await stat(lockPath)).ino;
    holder.child.kill("SIGKILL"); await holder.done;
    const next = await launch(`console.log(await lease("image", async () => "recovered", {
      lockPath: ${JSON.stringify(lockPath)}, pollMs: 2, waitTimeoutMs: 250
    }));`).done;
    expect(next.stderr).toBe(""); expect(next.code).toBe(0); expect(next.stdout.trim()).toBe("recovered");
    expect((await stat(lockPath)).ino).toBe(inode);
  });

  it.each(["deadline", "revoked"] as const)("stops resource waiting on %s without entering the live owner's device", async reason => {
    dir = await mkdtemp(path.join(tmpdir(), "idream-accelerator-"));
    const lockPath = path.join(dir, "device.lock");
    await hold(lockPath);
    const result = await launch(`
      let calls = 0;
      try {
        await lease("image", async () => { console.log("MUST_NOT_ENTER"); }, {
          lockPath: ${JSON.stringify(lockPath)}, pollMs: 2, waitTimeoutMs: 40, heartbeatMs: 5,
          onWait: async () => { calls += 1; ${reason === "revoked" ? 'throw new Error("Main authority revoked");' : ""} }
        });
      } catch (error) { console.log(JSON.stringify({ message: error.message, calls })); }
    `).done;
    expect(result.stderr).toBe(""); expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.message).toContain(reason === "deadline" ? "resource wait timed out" : "Main authority revoked");
    expect(output.calls).toBeGreaterThan(0);
  });

  it("releases the native descriptor after a failed protected callback", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "idream-accelerator-"));
    const lockPath = path.join(dir, "device.lock");
    const failed = await launch(`try { await lease("image", async () => { throw new Error("render failed"); }, {
      lockPath: ${JSON.stringify(lockPath)}
    }); } catch (error) { console.log(error.message); }`).done;
    expect(failed.code).toBe(0); expect(failed.stdout.trim()).toBe("render failed");
    const inode = (await stat(lockPath)).ino;
    const next = await launch(`console.log(await lease("video", async () => "acquired", {
      lockPath: ${JSON.stringify(lockPath)}, waitTimeoutMs: 250
    }));`).done;
    expect(next.code).toBe(0); expect(next.stdout.trim()).toBe("acquired");
    expect((await stat(lockPath)).ino).toBe(inode);
  });

  it("fails closed when the native library cannot load", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "idream-accelerator-"));
    const lockPath = path.join(dir, "device.lock");
    const result = await launch(`
      // The other host's library is absent here. Exercise actual dlopen failure,
      // not a mock lock implementation or a permissive runtime fallback.
      Object.defineProperty(process, "platform", { value: process.platform === "darwin" ? "linux" : "darwin" });
      let entered = false;
      try {
        await lease("image", async () => { entered = true; }, { lockPath: ${JSON.stringify(lockPath)} });
      } catch (error) { console.log(JSON.stringify({ entered, message: error.message })); }
    `).done;
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ entered: false });
    expect(JSON.parse(result.stdout).message.length).toBeGreaterThan(0);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
