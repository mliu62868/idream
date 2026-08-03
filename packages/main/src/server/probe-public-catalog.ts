import path from "node:path";
import { pathToFileURL } from "node:url";
import { prisma } from "@/server/lib/db";
import {
  runPublicCatalogProbe,
  type PublicCatalogProbeOptions,
} from "@/server/public-catalog-probe";
import type { ProbeReportOf, PublicCatalogProbeEvidence } from "@/server/readiness/evidence";
import {
  probeCliArg,
  probeReportPath,
  writeProbeReport,
} from "./readiness/probe-report";

function readOptions(): PublicCatalogProbeOptions {
  return {
    report: probeReportPath("publicCatalogProbe"),
    maxDuplicateImageRatio: readNumberArg("max-duplicate-image-ratio", 0.4),
    maxPublicMetric: readNumberArg("max-public-metric", 10_000_000),
    maxIssues: Math.max(1, Math.floor(readNumberArg("max-issues", 100))),
  };
}

function readNumberArg(name: string, fallback: number) {
  const value = probeCliArg(name) ?? process.env[toEnvName(name)];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toEnvName(name: string) {
  return `PUBLIC_CATALOG_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

async function main() {
  const options = readOptions();
  // SPEC: 报告体归 public-catalog-probe.ts 所有（它导出自己的 PublicCatalogProbeReport），这里
  //       用**生产端**契约接住 —— 漏写/改名 launch gate 要读的 counts.* / issueTotals.* 是编译错误。
  // INTENT: 之前标的是消费端的 PublicCatalogProbeEvidence，而它每个字段都可选，`{}` 也能通过；
  //         注释声称的编译期保护当时并不存在。ProbeReportOf 把它收成必填，其余 10 个 probe 同款。
  const report: ProbeReportOf<PublicCatalogProbeEvidence> = await runPublicCatalogProbe(
    prisma,
    options,
  );

  if (options.report) {
    await writeProbeReport(options.report, report);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entryPath === import.meta.url) {
  main()
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
