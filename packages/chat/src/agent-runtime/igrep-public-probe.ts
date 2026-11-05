import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BoundedCommandError } from "./bounded-command";
import { createIgrepEnvironment } from "./config";
import { igrepSearchResults, runJsonCommand } from "./igrep";

/** Setup must exercise the production child environment, not just CLI help. */
export async function probeIgrepPublicCli(command: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "idream-igrep-public-"));
  const cli = { command, env: createIgrepEnvironment({ llm: null, embedding: null, rerank: null }, process.env) };
  const marker = `idreambeacon${randomUUID().replaceAll("-", "")}`;
  const source = `${marker} 星舟🪶 e\u0301\r\nSecond original line.\nFinal original line.\n`;
  const sourcePath = join(root, "evidence.txt");
  const searchArgs = ["search", "--mode", "fast", "--strict", "--json", "--no-cache"];
  const complete = (value: unknown) => igrepSearchResults(value) as Array<Record<string, unknown>>;
  try {
    await writeFile(sourcePath, source, { mode: 0o600 });
    const hits = complete(await runJsonCommand({ ...cli, args: [...searchArgs, "--", marker, root] }));
    const hit = hits.find(value => typeof value.content === "string" && value.content.includes(marker));
    assert(hit, "igrep public file search missed its source");
    const location = hit.location as { root?: string; path?: string; start_line?: number; end_line?: number };
    assert(typeof location?.root === "string" && typeof location.path === "string"
      && await realpath(resolve(location.root, location.path)) === await realpath(sourcePath)
      && location.start_line === 1 && Number(location.end_line) >= 1, "igrep public file location is unverifiable");

    const recordId = "probe-original";
    const records = complete(await runJsonCommand({ ...cli,
      args: [...searchArgs, "--stdin-format", "jsonl", "--", marker],
      stdin: `${JSON.stringify({ id: recordId, ref: recordId, title: "Original record", content: source })}\n`,
    }));
    // Search renders a normalized snippet; recall resolves this ID from its
    // immutable source rather than treating that snippet as verbatim text.
    assert(records.some(value => (value.record as { id?: string })?.id === recordId
      && value.ref === recordId && typeof value.content === "string" && value.content.includes(marker)
      && value.content.includes("星舟🪶 e\u0301")), "igrep public JSONL source identity changed");
    // Requiring exit 1 distinguishes a complete miss from success or failure.
    const empty = complete(await runJsonCommand({ ...cli,
      args: [...searchArgs, "--", `absent${randomUUID().replaceAll("-", "")}`, root], acceptedExitCodes: [1],
    }));
    assert(empty.length === 0, "igrep public no-match exit returned evidence");

    let offset = 0, restored = "", fingerprint: string | undefined;
    for (let pages = 0; pages < 16; pages++) {
      const value = await runJsonCommand({ ...cli,
        args: ["read-source", location.path!, "--root", location.root!, "--offset", String(offset), "--max-bytes", "32",
          ...(fingerprint ? ["--expected-fingerprint", fingerprint] : [])],
      }) as { schema_version: number; path: string; content: string; fingerprint: string; source_sha256: string;
        content_kind: string; coverage: string; encoding: string; lossy: boolean; warnings: unknown[];
        range: { byte_start: number; byte_end: number }; line_space: string; truncated: boolean; next_offset: number | null };
      assert(value.schema_version === 1 && await realpath(value.path) === await realpath(sourcePath)
        && value.content_kind === "text" && value.coverage === "complete" && value.encoding === "utf-8"
        && value.lossy === false && value.line_space === "original" && value.warnings.length === 0
        && /^sha256:[a-f0-9]{64}$/u.test(value.fingerprint)
        && value.source_sha256 === createHash("sha256").update(source).digest("hex")
        && (!fingerprint || value.fingerprint === fingerprint)
        && value.range.byte_start === offset && value.range.byte_end === offset + Buffer.byteLength(value.content)
        && value.content.isWellFormed() && Buffer.byteLength(value.content) <= 32, "igrep public source page lost its source or UTF-8 boundary");
      fingerprint = value.fingerprint;
      restored += value.content;
      if (!value.truncated) {
        assert(value.next_offset === null, "igrep public source final page has a cursor");
        break;
      }
      assert(value.next_offset === value.range.byte_end && value.next_offset > offset, "igrep public source cursor did not advance");
      offset = value.next_offset;
    }
    assert(restored === source && (await readFile(sourcePath, "utf8")) === source, "igrep public source paging changed the original");
    await writeFile(sourcePath, `${source}Changed revision.\n`);
    await assert.rejects(runJsonCommand({ ...cli, args: ["read-source", location.path!, "--root", location.root!, "--expected-fingerprint", fingerprint!] }),
      error => error instanceof BoundedCommandError && error.code === "exit_nonzero", "igrep public source accepted a stale fingerprint");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
