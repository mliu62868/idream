import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function functionBody(source: string, name: string, nextName: string): string {
  const start = source.indexOf(`export async function ${name}`);
  const end = source.indexOf(`export async function ${nextName}`, start + 1);
  expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
  expect(end, `${nextName} must follow ${name}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("runtime memory purge lock ordering", () => {
  it("keeps message/session purge under turn authority and account purge under the user lock", () => {
    const source = readFileSync(new URL("./privacy.ts", import.meta.url), "utf8");
    for (const [name, nextName] of [
      ["deleteMessage", "deleteSession"],
      ["deleteSession", "deleteAccount"],
    ] as const) {
      const body = functionBody(source, name, nextName);
      expect(body.indexOf("purgeRuntimeMemoryIfActive")).toBeGreaterThan(
        body.indexOf("withTurnAuthority"),
      );
    }
    const account = source.slice(source.indexOf("export async function deleteAccount"));
    expect(account.indexOf("purgeRuntimeMemoryIfActive")).toBeGreaterThan(
      account.indexOf("lockUser(tx"),
    );
  });

  it("keeps edit purge inside turn authority", () => {
    const source = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
    const start = source.indexOf("export async function editUserMessage");
    const end = source.indexOf("export async function regenerateMessage", start);
    const body = source.slice(start, end);
    expect(body.indexOf("purgeRuntimeMemoryIfActive")).toBeGreaterThan(
      body.indexOf("withTurnAuthority"),
    );
  });
});
