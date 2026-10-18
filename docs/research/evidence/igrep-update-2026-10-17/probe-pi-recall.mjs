/** Synthetic public-adapter probe. No igrep process, network, or model is used. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [bundlePath, version, outputPath] = process.argv.slice(2);
if (!bundlePath || !["0.1.157", "0.1.161"].includes(version) || !outputPath) {
  throw new Error("usage: node probe-pi-recall.mjs EXTRACTED_WHEEL/igrep/data/pi/igrep-memory VERSION OUTPUT_JSON");
}
const modulePath = resolve(bundlePath, "session-recall.mjs");
const { archivedChunks, archiveIndex, chunkText, recallSession } = await import(pathToFileURL(modulePath));
const message = (id, role, content, extra = {}) => ({ id, type: "message", message: { role, content, ...extra } });
const first = message("first", "user", "First synthetic request: amber otter.");
const second = message("second", "assistant", [{ type: "thinking", thinking: "hidden synthetic reasoning" }, { type: "text", text: "Second synthetic reply: cobalt fox." }]);
const third = message("third", "toolResult", "Third synthetic failure: mint whale.", { toolName: "lookup", isError: true });
const visible = message("visible", "user", "Still visible: violet owl.");
const branch = [first, second, third, visible, message("recursive", "toolResult", "do not archive recall itself", { toolName: "session_recall" })];
const ctx = { sessionManager: { getBranch: () => branch, buildSessionProjection: () => ({ entries: [{ sourceEntry: visible, messages: [visible.message] }], messages: [visible.message] }) } };
const checks = [];
const check = (name, condition, detail) => { assert.ok(condition, name); checks.push({ name, passed: true, detail }); };
const chunks = archivedChunks(ctx);
check("only_missing_current_branch_raw_messages", chunks.length === 3 && chunks.map(c => c.entryId).join(",") === "first,second,third", chunks.map(c => c.id));
check("reasoning_and_recall_results_omitted", !JSON.stringify(chunks).includes("hidden synthetic") && !JSON.stringify(chunks).includes("do not archive"));
const unicode = "🪷".repeat(5_100) + "\n" + "tail";
check("unicode_chunks_are_lossless_and_bounded", chunkText(unicode).map(c => c.content).join("") === unicode && chunkText(unicode).every(c => Array.from(c.content).length <= 2_000));
const reversed = ["entry:third#1", "entry:second#1", "entry:first#1"];
const byIds = await recallSession(ctx, { ids: reversed }, { run: () => { throw new Error("ID lookup must not invoke igrep"); } });
const renderedIds = [...byIds.text.matchAll(/^### (entry:\S+)/gm)].map(match => match[1]);
const expected = version === "0.1.161" ? [...reversed].reverse() : reversed;
check("version_specific_render_order", JSON.stringify(renderedIds) === JSON.stringify(expected), renderedIds);
await assert.rejects(() => recallSession(ctx, { ids: ["entry:other-branch#1"] }), /unavailable/);
check("other_branch_id_rejected", true);
let invocation;
const byQuery = await recallSession(ctx, { query: "synthetic earlier exchange" }, { run: async (options) => {
  invocation = options;
  return { results: reversed.map(ref => ({ ref, score: 0.9 })), complete: false, degrade_reasons: ["synthetic partial"] };
} });
check("query_uses_one_bounded_public_stdin_search", invocation.args.includes("--stdin-format") && invocation.args.includes("jsonl") && invocation.input.trim().split("\n").length === 3, invocation.args);
check("incomplete_search_is_visible", byQuery.text.includes("synthetic partial"));
await assert.rejects(() => recallSession(ctx, { query: "duplicate" }, { run: async () => ({ results: [{ ref: reversed[0] }, { ref: reversed[0] }] }) }), /repeated/);
check("duplicate_search_reference_rejected", true);
const index = archiveIndex(chunks);
check("archive_index_is_bounded", index.length <= 2_000, { characters: index.length, index });
await writeFile(outputPath, JSON.stringify({ version, moduleSha256: createHash("sha256").update(await readFile(modulePath)).digest("hex"), checks, network: "No process or network: query ranking is an explicit stub", limitations: ["Does not evaluate semantic relevance or real provider latency.", "Uses synthetic coding-agent context; does not prove pi-durable compatibility."] }, null, 2) + "\n");
console.log(`${version}: ${checks.length} checks passed; ${outputPath}`);
