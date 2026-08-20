import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBoundedTextCommand } from "./bounded-command";
import { IgrepMemoryProbe, igrepVersion, runJsonCommand } from "./igrep";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

async function executable(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bounded-command-"));
  temporary.push(root);
  const path = join(root, "fixture.mjs");
  await writeFile(path, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

function expectContentFree(error: unknown, code: string, sentinel: string): void {
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toMatch(new RegExp(`code=${code} digest=[a-f0-9]{64}$`));
  expect(message).not.toContain(sentinel);
}

describe("content-free bounded child commands", () => {
  it("kills hung commands at the deadline without exposing child output", async () => {
    const sentinel = "timeout-secret-sentinel";
    const command = await executable(
      `process.stderr.write(${JSON.stringify(sentinel)}); setInterval(() => {}, 1_000);`,
    );
    const error = await runBoundedTextCommand({
      command,
      args: [],
      timeoutMs: 25,
    }).catch((caught) => caught);
    expectContentFree(error, "timeout", sentinel);
  });

  it("kills on AbortSignal without exposing its reason or child output", async () => {
    const sentinel = "abort-secret-sentinel";
    const command = await executable(
      `process.stderr.write(${JSON.stringify(sentinel)}); setInterval(() => {}, 1_000);`,
    );
    const controller = new AbortController();
    const running = runBoundedTextCommand({
      command,
      args: [],
      timeoutMs: 1_000,
      signal: controller.signal,
    }).catch((caught) => caught);
    controller.abort(new Error("abort-reason-secret"));
    const error = await running;
    expectContentFree(error, "aborted", sentinel);
    expect((error as Error).message).not.toContain("abort-reason-secret");
  });

  it("caps stdout at 4 MiB and stderr at 64 KiB with stable digests", async () => {
    const stdoutSentinel = "stdout-secret-sentinel";
    const stdoutCommand = await executable(
      `process.stdout.write(${JSON.stringify(stdoutSentinel)} + "x".repeat(4_194_304));`,
    );
    const stdoutError = await runJsonCommand({
      command: stdoutCommand,
      args: [],
    }).catch((caught) => caught);
    expectContentFree(stdoutError, "stdout_limit", stdoutSentinel);

    const stderrSentinel = "stderr-secret-sentinel";
    const stderrCommand = await executable(
      `process.stderr.write(${JSON.stringify(stderrSentinel)} + "x".repeat(65_536));`,
    );
    const stderrError = await runBoundedTextCommand({
      command: stderrCommand,
      args: [],
      timeoutMs: 1_000,
    }).catch((caught) => caught);
    expectContentFree(stderrError, "stderr_limit", stderrSentinel);
  });

  it("bounds igrep --version and never returns its raw stderr", async () => {
    const sentinel = "version-secret-sentinel";
    const command = await executable(
      `process.stderr.write(${JSON.stringify(sentinel)}); setInterval(() => {}, 1_000);`,
    );
    const timeoutError = await igrepVersion(command, { timeoutMs: 25 })
      .catch((caught) => caught);
    expectContentFree(timeoutError, "timeout", sentinel);

    const oversized = await executable(
      `process.stderr.write(${JSON.stringify(sentinel)} + "x".repeat(65_536));`,
    );
    const limitError = await igrepVersion(oversized, { timeoutMs: 1_000 })
      .catch((caught) => caught);
    expectContentFree(limitError, "stderr_limit", sentinel);
  });

  it("parses a bounded semantic version and JSON response", async () => {
    const version = await executable(`process.stdout.write("igrep 0.1.132\\n");`);
    await expect(igrepVersion(version)).resolves.toBe("0.1.132");
    const json = await executable(`process.stdout.write(JSON.stringify({ ok: true }));`);
    await expect(runJsonCommand({ command: json, args: [] })).resolves.toEqual({ ok: true });
  });

  it("does not echo invalid successful output in parse failures", async () => {
    const sentinel = "invalid-json-secret-sentinel";
    const json = await executable(`process.stdout.write(${JSON.stringify(sentinel)});`);
    const error = await runJsonCommand({ command: json, args: [] }).catch((caught) => caught);
    expectContentFree(error, "invalid_output", sentinel);

    const version = await executable(`process.stdout.write(${JSON.stringify(sentinel)});`);
    const versionError = await igrepVersion(version).catch((caught) => caught);
    expectContentFree(versionError, "invalid_output", sentinel);
  });

  it("digests a successful igrep error envelope without echoing its content", async () => {
    const sentinel = "igrep-envelope-secret-sentinel";
    const command = await executable(
      `process.stdout.write(JSON.stringify({ error: ${JSON.stringify(sentinel)} }));`,
    );
    const error = await new IgrepMemoryProbe(command).status("/tmp/workspace")
      .catch((caught) => caught);
    expectContentFree(error, "invalid_output", sentinel);
  });
});
