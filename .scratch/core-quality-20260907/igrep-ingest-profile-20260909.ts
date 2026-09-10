// Diagnostic only. Execute the installed official CLI unchanged, with Python's
// profiler around it. No maintain/search/model command is allowed here.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const igrep = execFileSync("which", ["igrep"], { encoding: "utf8" }).trim();
const firstLine = (await Bun.file(igrep).text()).split("\n")[0]!;
if (!firstLine.startsWith("#!/") || !firstLine.includes("python")) throw new Error("Cannot identify installed igrep interpreter");
const python = firstLine.slice(2).trim();
const root = await mkdtemp(join(tmpdir(), "idream-official-ingest-profile-"));
const output = resolve(".scratch/core-quality-20260907/igrep-ingest-profile-20260909.json");
const report: Record<string, unknown> = {
  sourceRevision: execFileSync("node", ["scripts/source-revision.cjs"], { encoding: "utf8" }).trim(),
  igrepVersion: execFileSync(igrep, ["--version"], { encoding: "utf8" }).trim(),
  python, igrep, samples: [],
  method: "Real unchanged installed CLI; cProfile on final no-change replay only; synthetic 1000-character visible messages. No PG, maintenance, recall, embedding, rerank, or network request. Profiling time is diagnostic overhead, not user latency.",
};
async function command(args: string[]) {
  const start = performance.now();
  const child = Bun.spawn([igrep, "mem", "ingest", ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw new Error("Official ingest failed");
  return { ms: performance.now() - start, result: JSON.parse(stdout) };
}
try {
  const workspace = join(root, "workspace");
  const sources = join(root, "transcripts");
  await mkdir(workspace); await mkdir(sources);
  const samples = report.samples as Array<Record<string, unknown>>;
  for (let session = 0; session < 4; session++) {
    const transcript = join(sources, `session-${session}.jsonl`);
    await writeFile(transcript, Array.from({ length: 2500 }, (_, index) => JSON.stringify({
      role: index % 2 ? "assistant" : "user",
      content: `Controlled notebook statement ${index}. ${"The cafe window catches warm evening light. ".repeat(30)}`.slice(0, 1000),
      source_at: new Date(1_700_000_000_000 + index * 1000).toISOString(), source_timezone: "UTC",
    })).join("\n") + "\n");
    const args = ["--transcript", transcript, "--workspace", workspace, "--agent", "deepseek-harness", "--session-id", `session-${session}`];
    const value = await command(args);
    if (value.result.events !== 2500 || value.result.newEvents !== 2500) throw new Error("Incomplete bootstrap");
    samples.push({ phase: "bootstrap", session, messagesInCorpus: (session + 1) * 2500, ms: value.ms, events: value.result.events, newEvents: value.result.newEvents });
  }
  const args = ["mem", "ingest", "--transcript", join(sources, "session-0.jsonl"), "--workspace", workspace, "--agent", "deepseek-harness", "--session-id", "session-0"];
  const unprofiled = await command(args.slice(2));
  if (unprofiled.result.newEvents !== 0) throw new Error("Replay duplicated source events");
  samples.push({ phase: "unprofiled-replay", ms: unprofiled.ms, events: unprofiled.result.events, newEvents: unprofiled.result.newEvents });
  const stats = join(root, "ingest.prof");
  const start = performance.now();
  const child = Bun.spawn([python, "-m", "cProfile", "-o", stats, igrep, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw new Error("Profiled official ingest failed");
  const value = JSON.parse(stdout);
  if (value.events !== 2500 || value.newEvents !== 0) throw new Error("Profiled replay changed source");
  const summary = execFileSync(python, ["-c", "import json,pstats,sys; s=pstats.Stats(sys.argv[1]); rows=[dict(file=k[0],line=k[1],name=k[2],primitiveCalls=v[0],calls=v[1],selfSeconds=v[2],cumulativeSeconds=v[3]) for k,v in s.stats.items()]; print(json.dumps(dict(totalCalls=s.total_calls,totalSeconds=s.total_tt,top=sorted(rows,key=lambda r:r['cumulativeSeconds'],reverse=True)[:35])))", stats], { encoding: "utf8" });
  samples.push({ phase: "profiled-replay", ms: performance.now() - start, events: value.events, newEvents: value.newEvents, profile: JSON.parse(summary) });
} finally {
  report.completedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  await rm(root, { recursive: true });
}
console.log(output);
