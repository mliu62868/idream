import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/server/lib/db";

type ProbeOptions = {
  report: string | null;
  maxDuplicateImageRatio: number;
  maxPublicMetric: number;
  maxIssues: number;
};

type CatalogIssue = {
  severity: "fail" | "warn";
  entity: "character" | "creator" | "catalog";
  id: string;
  field: string;
  message: string;
  value?: string | number | null;
};

type PublicCatalogProbeReport = {
  ok: boolean;
  checkedAt: string;
  durationMs: number;
  counts: {
    publicCharacters: number;
    publicCreators: number;
    distinctImages: number;
  };
  thresholds: {
    maxDuplicateImageRatio: number;
    maxPublicMetric: number;
  };
  issueTotals: {
    total: number;
    fail: number;
    warn: number;
  };
  issues: CatalogIssue[];
  error: { code: string; message: string; retryable?: boolean } | null;
};

const fixturePatterns = [
  {
    label: "e2e/test fixture marker",
    regex: /\b(e2e|test fixture|integration tests|api tests)\b|e2e-|test\.local/i,
  },
  {
    label: "generated numeric dreamer name",
    regex: /\bdreamer\s+\d{8,}/i,
  },
  {
    label: "audit/test user marker",
    regex: /\bpm audit\b|audit user/i,
  },
  {
    label: "verification fixture copy",
    regex: /seeded for|used to verify|profile reporting|community dreamer/i,
  },
] as const;

function readArg(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readOptions(): ProbeOptions {
  return {
    report: readArg("report") ?? process.env.PUBLIC_CATALOG_PROBE_REPORT ?? null,
    maxDuplicateImageRatio: readNumberArg("max-duplicate-image-ratio", 0.4),
    maxPublicMetric: readNumberArg("max-public-metric", 10_000_000),
    maxIssues: Math.max(1, Math.floor(readNumberArg("max-issues", 100))),
  };
}

function readNumberArg(name: string, fallback: number) {
  const value = readArg(name) ?? process.env[toEnvName(name)];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toEnvName(name: string) {
  return `PUBLIC_CATALOG_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

async function main() {
  const options = readOptions();
  const report = await runProbe(options);

  if (options.report) {
    const reportPath = resolveWorkspacePath(options.report);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

async function runProbe(options: ProbeOptions): Promise<PublicCatalogProbeReport> {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();

  try {
    const characters = await prisma.character.findMany({
      where: {
        visibility: "public",
        status: "approved",
        deletedAt: null,
      },
      include: {
        creator: {
          select: {
            id: true,
            email: true,
            displayName: true,
            name: true,
          },
        },
        imageAsset: {
          select: {
            id: true,
            url: true,
            thumbnailUrl: true,
            prompt: true,
          },
        },
        stats: {
          select: {
            likesCount: true,
            chatsCount: true,
            viewsCount: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const issues: CatalogIssue[] = [];
    const creatorIds = new Set<string>();
    const imageCounts = new Map<string, number>();

    for (const character of characters) {
      if (character.creatorId) creatorIds.add(character.creatorId);
      const imageKey = character.imageAsset?.url ?? character.imageAsset?.thumbnailUrl ?? null;
      if (imageKey) imageCounts.set(imageKey, (imageCounts.get(imageKey) ?? 0) + 1);

      checkText(issues, "character", character.id, "id", character.id);
      checkText(issues, "character", character.id, "name", character.name);
      checkText(issues, "character", character.id, "description", character.description);
      checkText(issues, "character", character.id, "imagePrompt", character.imageAsset?.prompt ?? null);

      if (character.creator) {
        checkText(issues, "creator", character.creator.id, "email", character.creator.email);
        checkText(
          issues,
          "creator",
          character.creator.id,
          "displayName",
          character.creator.displayName ?? character.creator.name ?? null,
        );
      }

      checkMetric(
        issues,
        character.id,
        "likesCount",
        character.stats?.likesCount ?? 0,
        options.maxPublicMetric,
      );
      checkMetric(
        issues,
        character.id,
        "chatsCount",
        character.stats?.chatsCount ?? 0,
        options.maxPublicMetric,
      );
    }

    const duplicateImageIssue = duplicateImageConcentrationIssue(
      imageCounts,
      characters.length,
      options.maxDuplicateImageRatio,
    );
    if (duplicateImageIssue) issues.push(duplicateImageIssue);

    const failCount = issues.filter((issue) => issue.severity === "fail").length;
    const warnCount = issues.length - failCount;
    const ok = failCount === 0;

    return {
      ok,
      checkedAt,
      durationMs: Date.now() - startedAt,
      counts: {
        publicCharacters: characters.length,
        publicCreators: creatorIds.size,
        distinctImages: imageCounts.size,
      },
      thresholds: {
        maxDuplicateImageRatio: options.maxDuplicateImageRatio,
        maxPublicMetric: options.maxPublicMetric,
      },
      issueTotals: {
        total: issues.length,
        fail: failCount,
        warn: warnCount,
      },
      issues: issues.slice(0, options.maxIssues),
      error: ok
        ? null
        : {
            code: "public_catalog_probe_failed",
            message: `${failCount} launch-blocking public catalog issue(s) found.`,
            retryable: false,
          },
    };
  } catch (error) {
    return {
      ok: false,
      checkedAt,
      durationMs: Date.now() - startedAt,
      counts: {
        publicCharacters: 0,
        publicCreators: 0,
        distinctImages: 0,
      },
      thresholds: {
        maxDuplicateImageRatio: options.maxDuplicateImageRatio,
        maxPublicMetric: options.maxPublicMetric,
      },
      issueTotals: {
        total: 0,
        fail: 0,
        warn: 0,
      },
      issues: [],
      error: {
        code: "public_catalog_probe_error",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    };
  } finally {
    await prisma.$disconnect();
  }
}

function checkText(
  issues: CatalogIssue[],
  entity: "character" | "creator",
  id: string,
  field: string,
  value: string | null,
) {
  if (!value) return;
  for (const pattern of fixturePatterns) {
    if (!pattern.regex.test(value)) continue;
    issues.push({
      severity: "fail",
      entity,
      id,
      field,
      message: `Public catalog contains ${pattern.label}.`,
      value: truncate(value),
    });
  }
}

function checkMetric(
  issues: CatalogIssue[],
  id: string,
  field: "likesCount" | "chatsCount",
  value: number,
  max: number,
) {
  if (value <= max) return;
  issues.push({
    severity: "fail",
    entity: "character",
    id,
    field,
    message: `Public ${field} exceeds launch hygiene threshold.`,
    value,
  });
}

function duplicateImageConcentrationIssue(
  imageCounts: Map<string, number>,
  total: number,
  maxRatio: number,
): CatalogIssue | null {
  if (total < 8 || imageCounts.size === 0) return null;
  const [image, count] = [...imageCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  if (!image || count < 5) return null;
  const ratio = count / total;
  if (ratio <= maxRatio) return null;
  return {
    severity: "fail",
    entity: "catalog",
    id: "image-concentration",
    field: "imageAsset.url",
    message: `One image is reused by ${count}/${total} public characters.`,
    value: truncate(image),
  };
}

function truncate(value: string) {
  return value.length > 180 ? `${value.slice(0, 177)}...` : value;
}

function resolveWorkspacePath(filePath: string) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(workspaceRoot(), filePath);
}

function workspaceRoot() {
  let current = process.cwd();
  while (true) {
    if (
      existsSync(path.join(current, "package.json")) &&
      (existsSync(path.join(current, "turbo.json")) ||
        existsSync(path.join(current, "bun.lock")))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
