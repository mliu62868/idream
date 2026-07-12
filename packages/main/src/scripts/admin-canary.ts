import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runAdminCanary } from "@/server/admin/admin-canary-runner";

async function main() {
  const planPath = process.argv[2] ?? process.env.ADMIN_CANARY_PLAN_PATH;
  if (!planPath) {
    process.stderr.write("Usage: bun run admin:readiness:canary -- <production-canary-plan.json>\n");
    process.exitCode = 1;
    return;
  }
  try {
    const plan = JSON.parse(await readFile(resolve(planPath), "utf8")) as unknown;
    const report = await runAdminCanary(plan, {
      cookie: process.env.ADMIN_CANARY_COOKIE,
      authorization: process.env.ADMIN_CANARY_AUTHORIZATION,
      writeConfirmation: process.env.ADMIN_CANARY_WRITE_CONFIRMATION,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== "pass") process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

void main();
