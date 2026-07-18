import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertPlaywrightCleanupPlan,
  type PlaywrightCleanupPlan,
} from "./playwright-cleanup";

const MAIN_PACKAGE_ROOT = process.cwd().endsWith(path.join("packages", "main"))
  ? process.cwd()
  : path.resolve(process.cwd(), "packages/main");

type PlaywrightLifecycleReceipt = {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly status: "passed" | "failed";
  readonly phase: "preparation" | "service" | "teardown";
  readonly message: string | null;
};

export async function writePlaywrightLifecycleReceipt(
  unsafePlan: PlaywrightCleanupPlan,
  receipt: Omit<PlaywrightLifecycleReceipt, "schemaVersion" | "runId">,
) {
  const plan = assertPlaywrightCleanupPlan(unsafePlan);
  const receiptPath = absoluteReceiptPath(plan);
  const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
  await mkdir(path.dirname(receiptPath), { recursive: true });
  await writeFile(
    temporaryPath,
    `${JSON.stringify({
      schemaVersion: 1,
      runId: plan.runId,
      ...receipt,
    } satisfies PlaywrightLifecycleReceipt)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  await rename(temporaryPath, receiptPath);
}

export function createPlaywrightLifecycleVerifier(
  unsafePlan: PlaywrightCleanupPlan,
) {
  const plan = assertPlaywrightCleanupPlan(unsafePlan);
  const receiptPath = absoluteReceiptPath(plan);
  const receiptDirectory = path.dirname(receiptPath);

  return {
    async setup() {
      await rm(receiptDirectory, { recursive: true, force: true });
    },
    async teardown() {
      let receipt: PlaywrightLifecycleReceipt;
      try {
        const rawReceipt = await readFile(receiptPath, "utf8");
        receipt = parseLifecycleReceipt(rawReceipt, plan.runId);
      } catch (error) {
        throw new Error(
          `Playwright lifecycle cleanup proof is missing or invalid for run ${plan.runId}`,
          { cause: error },
        );
      } finally {
        await rm(receiptDirectory, { recursive: true, force: true });
      }
      if (receipt.status !== "passed") {
        throw new Error(
          `Playwright lifecycle failed during ${receipt.phase}: ${receipt.message ?? "unknown failure"}`,
        );
      }
    },
  };
}

function parseLifecycleReceipt(rawValue: string, runId: string) {
  const value = JSON.parse(rawValue) as Partial<PlaywrightLifecycleReceipt>;
  if (
    value.schemaVersion !== 1 ||
    value.runId !== runId ||
    !["passed", "failed"].includes(value.status ?? "") ||
    !["preparation", "service", "teardown"].includes(value.phase ?? "") ||
    !(typeof value.message === "string" || value.message === null)
  ) {
    throw new Error("Playwright lifecycle receipt has an invalid shape");
  }
  return value as PlaywrightLifecycleReceipt;
}

function absoluteReceiptPath(plan: PlaywrightCleanupPlan) {
  return path.resolve(MAIN_PACKAGE_ROOT, plan.lifecycleReceiptPath);
}
