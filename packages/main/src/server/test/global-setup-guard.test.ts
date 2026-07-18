import { describe, expect, it } from "vitest";
import {
  acquireTestDatabaseLease,
  dedicatedTestDatabaseUrl,
  testDatabaseLeaseIdentity,
} from "./global-setup";

describe("test database reset guard", () => {
  it("accepts dedicated test database names", () => {
    expect(
      dedicatedTestDatabaseUrl(
        "postgresql://postgres:postgres@localhost:5433/idream_test_playwright_3110",
      ),
    ).toContain("idream_test_playwright_3110");
  });

  it("refuses a development database even when supplied explicitly", () => {
    expect(() =>
      dedicatedTestDatabaseUrl(
        "postgresql://postgres:postgres@localhost:5433/idream",
      ),
    ).toThrow(/Refusing to reset non-test database/);
  });

  it("refuses names that merely contain the letters test inside another word", () => {
    expect(() =>
      dedicatedTestDatabaseUrl(
        "postgresql://postgres:postgres@localhost:5433/idream_contest",
      ),
    ).toThrow(/Refusing to reset non-test database/);
  });

  it("refuses non-PostgreSQL database URLs", () => {
    expect(() =>
      dedicatedTestDatabaseUrl(
        "mysql://root:root@localhost:3306/idream_test",
      ),
    ).toThrow(/must use postgres/);
  });

  it("refuses a remote test database without exact reset authority", () => {
    const remoteUrl =
      "postgresql://postgres:postgres@postgres.internal:5432/idream_test_ci";

    expect(() => dedicatedTestDatabaseUrl(remoteUrl)).toThrow(
      /Refusing remote test database reset/,
    );
    expect(() =>
      dedicatedTestDatabaseUrl(remoteUrl, {
        allowRemoteReset: true,
        confirmedDatabaseName: "idream_test_other",
        ci: true,
      }),
    ).toThrow(/confirmation does not match/);
    expect(() =>
      dedicatedTestDatabaseUrl(remoteUrl, {
        allowRemoteReset: true,
        confirmedDatabaseName: "idream_test_ci",
      }),
    ).toThrow(/CI=true/);
  });

  it("accepts a remote test database only with exact reset authority", () => {
    const remoteUrl =
      "postgresql://postgres:postgres@postgres.internal:5432/idream_test_ci";

    expect(
      dedicatedTestDatabaseUrl(remoteUrl, {
        allowRemoteReset: true,
        confirmedDatabaseName: "idream_test_ci",
        ci: true,
      }),
    ).toBe(remoteUrl);
  });

  it("uses the database server and schema as the lease identity, not a hostname alias", () => {
    const localhost =
      "postgresql://postgres:secret@localhost:5433/idream_test?schema=public";
    const loopbackAlias =
      "postgresql://other:different@127.0.0.1:5433/idream_test?schema=public";

    expect(testDatabaseLeaseIdentity(localhost)).toBe(
      testDatabaseLeaseIdentity(loopbackAlias),
    );
    expect(testDatabaseLeaseIdentity(localhost)).not.toBe(
      testDatabaseLeaseIdentity(
        "postgresql://postgres:secret@localhost:5433/idream_test?schema=agent_b",
      ),
    );
  });

  it("holds a suite-lifetime lease that rejects a concurrent reset", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl).toBeTruthy();

    await expect(acquireTestDatabaseLease(databaseUrl ?? "")).rejects.toThrow(
      /another Main test run is active/,
    );
  });
});
