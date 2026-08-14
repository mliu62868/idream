import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSafeChatTestDatabaseName,
  assertSafeChatTestDatabaseTarget,
  chatTestBullMqPrefix,
  chatTestDatabaseNameForWorkspace,
  provisionChatTestDb,
} from "./provision.mjs";
import {
  acquireChatTestDatabaseLease,
  dedicatedChatTestRedis,
} from "./global-setup.js";

describe("chat test database provisioning guard", () => {
  it("never lets the root Turbo entry cache the database boundary suite", () => {
    const repoRoot = path.resolve(process.cwd(), "../..");
    const turbo = JSON.parse(
      readFileSync(path.join(repoRoot, "turbo.json"), "utf8"),
    ) as {
      tasks?: Record<string, { cache?: boolean }>;
    };

    expect(turbo.tasks?.["@idream/chat#test"]?.cache).toBe(false);
  });

  it("refuses role bootstrap on the runtime PostgreSQL cluster before role mutation", () => {
    const fakeBin = mkdtempSync(path.join(tmpdir(), "idream-fake-psql-"));
    const fakePsql = path.join(fakeBin, "psql");
    const mutationMarker = path.join(fakeBin, "role-mutated");
    writeFileSync(
      fakePsql,
      `#!/bin/sh
input=$(cat)
case "$input" in
  *"WITH required_roles"*) printf 'f\\n'; exit 0 ;;
  *) printf mutated > "$IDREAM_ROLE_MUTATION_MARKER"; exit 1 ;;
esac
`,
    );
    chmodSync(fakePsql, 0o755);
    const names = [
      "CHAT_DATABASE_URL",
      "CHAT_PROJECTOR_DATABASE_URL",
      "CHAT_PROJECTOR_PASSWORD",
      "CHAT_SERVICE_PASSWORD",
      "CHAT_TEST_DB",
      "CHAT_TEST_DISPOSABLE_CLUSTER_CONFIRM",
      "IDREAM_ROLE_MUTATION_MARKER",
      "PATH",
      "PGHOST",
      "PGPASSWORD",
      "PGPORT",
    ] as const;
    const original = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );

    try {
      process.env.CHAT_DATABASE_URL =
        "postgresql://chat_service:must-not-leak-runtime@127.0.0.1:5433/idream_runtime";
      process.env.CHAT_PROJECTOR_PASSWORD = "must-not-leak-projector";
      process.env.CHAT_SERVICE_PASSWORD = "must-not-leak-service";
      process.env.CHAT_TEST_DB = "idream_chat_test_guard";
      process.env.CHAT_TEST_DISPOSABLE_CLUSTER_CONFIRM = "127.0.0.1:5433";
      process.env.IDREAM_ROLE_MUTATION_MARKER = mutationMarker;
      process.env.PATH = `${fakeBin}:${original.PATH ?? ""}`;
      process.env.PGHOST = "localhost";
      process.env.PGPASSWORD = "must-not-leak-super";
      process.env.PGPORT = "5433";

      let failure = "";
      try {
        provisionChatTestDb();
      } catch (error) {
        failure = String(error);
      }
      expect(failure).toContain(
        "Refusing Chat test role bootstrap while runtime PostgreSQL authority is configured",
      );
      expect(failure).not.toContain("must-not-leak");
      expect(existsSync(mutationMarker)).toBe(false);
    } finally {
      for (const name of names) {
        const value = original[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("treats an empty Chat URL as absent and still refuses the DATABASE_URL runtime fallback", () => {
    const fakeBin = mkdtempSync(path.join(tmpdir(), "idream-fake-psql-"));
    const fakePsql = path.join(fakeBin, "psql");
    const mutationMarker = path.join(fakeBin, "role-mutated");
    writeFileSync(
      fakePsql,
      `#!/bin/sh
input=$(cat)
case "$input" in
  *"WITH required_roles"*) printf 'f\\n'; exit 0 ;;
  *) printf mutated > "$IDREAM_ROLE_MUTATION_MARKER"; exit 1 ;;
esac
`,
    );
    chmodSync(fakePsql, 0o755);
    const names = [
      "CHAT_DATABASE_URL",
      "CHAT_PROJECTOR_DATABASE_URL",
      "CHAT_PROJECTOR_PASSWORD",
      "CHAT_SERVICE_PASSWORD",
      "CHAT_TEST_DB",
      "CHAT_TEST_DISPOSABLE_CLUSTER_CONFIRM",
      "DATABASE_URL",
      "IDREAM_ROLE_MUTATION_MARKER",
      "PATH",
      "PGHOST",
      "PGPASSWORD",
      "PGPORT",
    ] as const;
    const original = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );

    try {
      process.env.CHAT_DATABASE_URL = "";
      process.env.DATABASE_URL =
        "postgresql://chat_service:must-not-leak-runtime@127.0.0.1:5433/idream_runtime";
      process.env.CHAT_PROJECTOR_PASSWORD = "must-not-leak-projector";
      process.env.CHAT_SERVICE_PASSWORD = "must-not-leak-service";
      process.env.CHAT_TEST_DB = "idream_chat_test_guard";
      process.env.CHAT_TEST_DISPOSABLE_CLUSTER_CONFIRM = "loopback:5433";
      process.env.IDREAM_ROLE_MUTATION_MARKER = mutationMarker;
      process.env.PATH = `${fakeBin}:${original.PATH ?? ""}`;
      process.env.PGHOST = "localhost";
      process.env.PGPASSWORD = "must-not-leak-super";
      process.env.PGPORT = "5433";

      let failure = "";
      try {
        provisionChatTestDb();
      } catch (error) {
        failure = String(error);
      }
      expect(failure).toContain(
        "Refusing Chat test role bootstrap while runtime PostgreSQL authority is configured",
      );
      expect(failure).not.toContain("must-not-leak");
      expect(existsSync(mutationMarker)).toBe(false);
    } finally {
      for (const name of names) {
        const value = original[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("refuses bootstrap when a projector runtime URL could alias the target cluster", () => {
    const fakeBin = mkdtempSync(path.join(tmpdir(), "idream-fake-psql-"));
    const fakePsql = path.join(fakeBin, "psql");
    const mutationMarker = path.join(fakeBin, "role-mutated");
    writeFileSync(
      fakePsql,
      `#!/bin/sh
input=$(cat)
case "$input" in
  *"WITH required_roles"*) printf 'f\\n'; exit 0 ;;
  *) printf mutated > "$IDREAM_ROLE_MUTATION_MARKER"; exit 1 ;;
esac
`,
    );
    chmodSync(fakePsql, 0o755);
    const names = [
      "CHAT_DATABASE_URL",
      "CHAT_PROJECTOR_DATABASE_URL",
      "CHAT_PROJECTOR_PASSWORD",
      "CHAT_SERVICE_PASSWORD",
      "CHAT_TEST_DB",
      "CHAT_TEST_DISPOSABLE_CLUSTER_CONFIRM",
      "DATABASE_URL",
      "IDREAM_ROLE_MUTATION_MARKER",
      "PATH",
      "PGHOST",
      "PGPASSWORD",
      "PGPORT",
    ] as const;
    const original = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );

    try {
      delete process.env.CHAT_DATABASE_URL;
      process.env.CHAT_PROJECTOR_DATABASE_URL =
        "postgresql://chat_projector:must-not-leak-projector@postgres-alias.internal:5433/idream_runtime";
      delete process.env.DATABASE_URL;
      process.env.CHAT_PROJECTOR_PASSWORD = "must-not-leak-projector";
      process.env.CHAT_SERVICE_PASSWORD = "must-not-leak-service";
      process.env.CHAT_TEST_DB = "idream_chat_test_guard";
      process.env.CHAT_TEST_DISPOSABLE_CLUSTER_CONFIRM = "loopback:5433";
      process.env.IDREAM_ROLE_MUTATION_MARKER = mutationMarker;
      process.env.PATH = `${fakeBin}:${original.PATH ?? ""}`;
      process.env.PGHOST = "localhost";
      process.env.PGPASSWORD = "must-not-leak-super";
      process.env.PGPORT = "5433";

      let failure = "";
      try {
        provisionChatTestDb();
      } catch (error) {
        failure = String(error);
      }
      expect(failure).toContain(
        "Refusing Chat test role bootstrap while runtime PostgreSQL authority is configured",
      );
      expect(failure).not.toContain("must-not-leak");
      expect(existsSync(mutationMarker)).toBe(false);
    } finally {
      for (const name of names) {
        const value = original[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("checks runtime URL credentials before dropping the test database", () => {
    const fakeBin = mkdtempSync(path.join(tmpdir(), "idream-fake-psql-"));
    const fakePsql = path.join(fakeBin, "psql");
    const databaseMarker = path.join(fakeBin, "database-reset-attempted");
    const roleMarker = path.join(fakeBin, "role-mutated");
    writeFileSync(
      fakePsql,
      `#!/bin/sh
input=$(cat)
case "$input" in
  *"WITH required_roles"*) printf 't\\n'; exit 0 ;;
  *"session_user = 'chat_service'"*)
    if [ "$PGPASSWORD" = "must-not-leak-actual" ]; then printf 't\n'; else printf 'f\n'; fi
    exit 0
    ;;
  *"DROP DATABASE"*) printf attempted > "$IDREAM_DATABASE_RESET_MARKER"; exit 1 ;;
esac
exit 1
`,
    );
    chmodSync(fakePsql, 0o755);
    const names = [
      "CHAT_DATABASE_URL",
      "CHAT_PROJECTOR_PASSWORD",
      "CHAT_SERVICE_PASSWORD",
      "CHAT_TEST_DB",
      "CHAT_TEST_DISPOSABLE_CLUSTER_CONFIRM",
      "IDREAM_DATABASE_RESET_MARKER",
      "IDREAM_ROLE_MUTATION_MARKER",
      "PATH",
      "PGHOST",
      "PGPASSWORD",
      "PGPORT",
    ] as const;
    const original = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );

    try {
      process.env.CHAT_DATABASE_URL =
        "postgresql://chat_service:must-not-leak-stale-url@127.0.0.1:5433/idream_runtime";
      process.env.CHAT_PROJECTOR_PASSWORD = "must-not-leak-projector";
      process.env.CHAT_SERVICE_PASSWORD = "must-not-leak-actual";
      process.env.CHAT_TEST_DB = "idream_chat_test_guard";
      delete process.env.CHAT_TEST_DISPOSABLE_CLUSTER_CONFIRM;
      process.env.IDREAM_DATABASE_RESET_MARKER = databaseMarker;
      process.env.IDREAM_ROLE_MUTATION_MARKER = roleMarker;
      process.env.PATH = `${fakeBin}:${original.PATH ?? ""}`;
      process.env.PGHOST = "localhost";
      process.env.PGPASSWORD = "must-not-leak-super";
      process.env.PGPORT = "5433";

      let failure = "";
      try {
        provisionChatTestDb();
      } catch (error) {
        failure = String(error);
      }
      expect(failure).toContain(
        "chat_service credentials did not authenticate the exact runtime role",
      );
      expect(failure).not.toContain("must-not-leak");
      expect(existsSync(databaseMarker)).toBe(false);
      expect(existsSync(roleMarker)).toBe(false);
    } finally {
      for (const name of names) {
        const value = original[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("checks a projector DATABASE_URL credential before dropping the test database", () => {
    const fakeBin = mkdtempSync(path.join(tmpdir(), "idream-fake-psql-"));
    const fakePsql = path.join(fakeBin, "psql");
    const databaseMarker = path.join(fakeBin, "database-reset-attempted");
    writeFileSync(
      fakePsql,
      `#!/bin/sh
input=$(cat)
case "$input" in
  *"WITH required_roles"*) printf 't\\n'; exit 0 ;;
  *"session_user = 'chat_service'"*)
    if [ "$PGPASSWORD" = "must-not-leak-service" ]; then printf 't\n'; else printf 'f\n'; fi
    exit 0
    ;;
  *"session_user = 'chat_projector'"*)
    if [ "$PGPASSWORD" = "must-not-leak-projector-actual" ]; then printf 't\n'; else printf 'f\n'; fi
    exit 0
    ;;
  *"DROP DATABASE"*) printf attempted > "$IDREAM_DATABASE_RESET_MARKER"; exit 1 ;;
esac
exit 1
`,
    );
    chmodSync(fakePsql, 0o755);
    const names = [
      "CHAT_DATABASE_URL",
      "CHAT_PROJECTOR_DATABASE_URL",
      "CHAT_PROJECTOR_PASSWORD",
      "CHAT_SERVICE_PASSWORD",
      "CHAT_TEST_DB",
      "CHAT_TEST_DISPOSABLE_CLUSTER_CONFIRM",
      "DATABASE_URL",
      "IDREAM_DATABASE_RESET_MARKER",
      "PATH",
      "PGHOST",
      "PGPASSWORD",
      "PGPORT",
    ] as const;
    const original = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );

    try {
      delete process.env.CHAT_DATABASE_URL;
      delete process.env.CHAT_PROJECTOR_DATABASE_URL;
      process.env.CHAT_PROJECTOR_PASSWORD =
        "must-not-leak-projector-actual";
      process.env.CHAT_SERVICE_PASSWORD = "must-not-leak-service";
      process.env.CHAT_TEST_DB = "idream_chat_test_guard";
      delete process.env.CHAT_TEST_DISPOSABLE_CLUSTER_CONFIRM;
      process.env.DATABASE_URL =
        "postgresql://chat_projector:must-not-leak-projector-stale-url@127.0.0.1:5433/idream_runtime";
      process.env.IDREAM_DATABASE_RESET_MARKER = databaseMarker;
      process.env.PATH = `${fakeBin}:${original.PATH ?? ""}`;
      process.env.PGHOST = "localhost";
      process.env.PGPASSWORD = "must-not-leak-super";
      process.env.PGPORT = "5433";

      let failure = "";
      try {
        provisionChatTestDb();
      } catch (error) {
        failure = String(error);
      }
      expect(failure).toContain(
        "chat_projector credentials did not authenticate the exact runtime role",
      );
      expect(failure).not.toContain("must-not-leak");
      expect(existsSync(databaseMarker)).toBe(false);
    } finally {
      for (const name of names) {
        const value = original[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("requires explicit existing runtime-role credentials before invoking psql", () => {
    const fakeBin = mkdtempSync(path.join(tmpdir(), "idream-fake-psql-"));
    const fakePsql = path.join(fakeBin, "psql");
    const marker = path.join(fakeBin, "invoked");
    writeFileSync(
      fakePsql,
      `#!/bin/sh
printf invoked > "$IDREAM_PSQL_MARKER"
exit 1
`,
    );
    chmodSync(fakePsql, 0o755);
    const names = [
      "CHAT_DATABASE_URL",
      "CHAT_PROJECTOR_DATABASE_URL",
      "CHAT_PROJECTOR_PASSWORD",
      "CHAT_SERVICE_PASSWORD",
      "CHAT_TEST_DB",
      "DATABASE_URL",
      "IDREAM_PSQL_MARKER",
      "PATH",
      "PGHOST",
      "PGPASSWORD",
      "PGPORT",
    ] as const;
    const original = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );

    try {
      delete process.env.CHAT_DATABASE_URL;
      delete process.env.CHAT_PROJECTOR_DATABASE_URL;
      delete process.env.CHAT_PROJECTOR_PASSWORD;
      delete process.env.CHAT_SERVICE_PASSWORD;
      delete process.env.DATABASE_URL;
      process.env.CHAT_TEST_DB = "idream_chat_test_guard";
      process.env.IDREAM_PSQL_MARKER = marker;
      process.env.PATH = `${fakeBin}:${original.PATH ?? ""}`;
      process.env.PGHOST = "localhost";
      process.env.PGPASSWORD = "must-not-leak-super";
      process.env.PGPORT = "5433";

      expect(() => provisionChatTestDb()).toThrow(
        "CHAT_SERVICE_PASSWORD must be set explicitly for Chat test provisioning",
      );
      expect(existsSync(marker)).toBe(false);
    } finally {
      for (const name of names) {
        const value = original[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("authenticates both runtime roles before dropping the test database", () => {
    const fakeBin = mkdtempSync(path.join(tmpdir(), "idream-fake-psql-"));
    const fakePsql = path.join(fakeBin, "psql");
    const authMarker = path.join(fakeBin, "roles-authenticated");
    const databaseMarker = path.join(fakeBin, "database-reset-attempted");
    writeFileSync(
      fakePsql,
      `#!/bin/sh
input=$(cat)
case "$input" in
  *"WITH required_roles"*) printf 't\\n'; exit 0 ;;
  *"session_user = 'chat_service'"*)
    if [ "$PGPASSWORD" = "must-not-leak-service" ]; then
      printf 'chat_service\\n' >> "$IDREAM_ROLE_AUTH_MARKER"
      printf 't\\n'
    else
      printf 'f\\n'
    fi
    exit 0
    ;;
  *"session_user = 'chat_projector'"*)
    if [ "$PGPASSWORD" = "must-not-leak-projector" ]; then
      printf 'chat_projector\\n' >> "$IDREAM_ROLE_AUTH_MARKER"
      printf 't\\n'
    else
      printf 'f\\n'
    fi
    exit 0
    ;;
  *"DROP DATABASE"*) printf attempted > "$IDREAM_DATABASE_RESET_MARKER"; exit 1 ;;
esac
exit 1
`,
    );
    chmodSync(fakePsql, 0o755);
    const names = [
      "CHAT_DATABASE_URL",
      "CHAT_PROJECTOR_DATABASE_URL",
      "CHAT_PROJECTOR_PASSWORD",
      "CHAT_SERVICE_PASSWORD",
      "CHAT_TEST_DB",
      "IDREAM_DATABASE_RESET_MARKER",
      "IDREAM_ROLE_AUTH_MARKER",
      "PATH",
      "PGHOST",
      "PGPASSWORD",
      "PGPORT",
    ] as const;
    const original = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );

    try {
      process.env.CHAT_DATABASE_URL =
        "postgresql://chat_service:must-not-leak-service@127.0.0.1:5433/idream_runtime";
      process.env.CHAT_PROJECTOR_DATABASE_URL =
        "postgresql://chat_projector:must-not-leak-projector@localhost:5433/idream_runtime";
      delete process.env.CHAT_PROJECTOR_PASSWORD;
      delete process.env.CHAT_SERVICE_PASSWORD;
      process.env.CHAT_TEST_DB = "idream_chat_test_guard";
      process.env.IDREAM_DATABASE_RESET_MARKER = databaseMarker;
      process.env.IDREAM_ROLE_AUTH_MARKER = authMarker;
      process.env.PATH = `${fakeBin}:${original.PATH ?? ""}`;
      process.env.PGHOST = "localhost";
      process.env.PGPASSWORD = "must-not-leak-super";
      process.env.PGPORT = "5433";

      let failure = "";
      try {
        provisionChatTestDb();
      } catch (error) {
        failure = String(error);
      }
      expect(failure).toContain(
        "psql failed for postgres@localhost:5433/postgres",
      );
      expect(failure).not.toContain("must-not-leak");
      expect(existsSync(databaseMarker)).toBe(true);
      expect(readFileSync(authMarker, "utf8")).toBe(
        "chat_service\nchat_projector\n",
      );
    } finally {
      for (const name of names) {
        const value = original[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("rejects ambient libpq target overrides before destructive provisioning", () => {
    const fakeBin = mkdtempSync(path.join(tmpdir(), "idream-fake-psql-"));
    const fakePsql = path.join(fakeBin, "psql");
    const marker = path.join(fakeBin, "invoked");
    writeFileSync(
      fakePsql,
      `#!/bin/sh
printf invoked > "$IDREAM_PSQL_MARKER"
exit 1
`,
    );
    chmodSync(fakePsql, 0o755);
    const names = [
      "CHAT_TEST_DB",
      "IDREAM_PSQL_MARKER",
      "PATH",
      "PGHOST",
      "PGHOSTADDR",
      "PGPORT",
    ] as const;
    const original = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );

    try {
      process.env.CHAT_TEST_DB = "idream_chat_test_guard";
      process.env.IDREAM_PSQL_MARKER = marker;
      process.env.PATH = `${fakeBin}:${original.PATH ?? ""}`;
      process.env.PGHOST = "localhost";
      process.env.PGHOSTADDR = "203.0.113.10";
      process.env.PGPORT = "5433";

      expect(() => provisionChatTestDb()).toThrow(
        "ambient libpq target variable PGHOSTADDR is not allowed",
      );
      expect(existsSync(marker)).toBe(false);
    } finally {
      for (const name of names) {
        const value = original[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("requires exact disposable-cluster authority before creating or repairing roles", () => {
    const fakeBin = mkdtempSync(path.join(tmpdir(), "idream-fake-psql-"));
    const fakePsql = path.join(fakeBin, "psql");
    const mutationMarker = path.join(fakeBin, "role-mutated");
    writeFileSync(
      fakePsql,
      `#!/bin/sh
input=$(cat)
case "$input" in
  *"WITH required_roles"*) printf 'f\\n'; exit 0 ;;
  *) printf mutated > "$IDREAM_ROLE_MUTATION_MARKER"; exit 1 ;;
esac
`,
    );
    chmodSync(fakePsql, 0o755);
    const names = [
      "CHAT_DATABASE_URL",
      "CHAT_PROJECTOR_DATABASE_URL",
      "CHAT_PROJECTOR_PASSWORD",
      "CHAT_SERVICE_PASSWORD",
      "CHAT_TEST_DB",
      "CHAT_TEST_DISPOSABLE_CLUSTER_CONFIRM",
      "DATABASE_URL",
      "IDREAM_ROLE_MUTATION_MARKER",
      "PATH",
      "PGHOST",
      "PGPASSWORD",
      "PGPORT",
    ] as const;
    const original = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );

    try {
      delete process.env.CHAT_DATABASE_URL;
      delete process.env.CHAT_PROJECTOR_DATABASE_URL;
      delete process.env.DATABASE_URL;
      process.env.CHAT_PROJECTOR_PASSWORD = "must-not-leak-projector";
      process.env.CHAT_SERVICE_PASSWORD = "must-not-leak-service";
      process.env.CHAT_TEST_DB = "idream_chat_test_guard";
      delete process.env.CHAT_TEST_DISPOSABLE_CLUSTER_CONFIRM;
      process.env.IDREAM_ROLE_MUTATION_MARKER = mutationMarker;
      process.env.PATH = `${fakeBin}:${original.PATH ?? ""}`;
      process.env.PGHOST = "localhost";
      process.env.PGPASSWORD = "must-not-leak-super";
      process.env.PGPORT = "5433";

      let failure = "";
      try {
        provisionChatTestDb();
      } catch (error) {
        failure = String(error);
      }
      expect(failure).toContain(
        "CHAT_TEST_DISPOSABLE_CLUSTER_CONFIRM=loopback:5433",
      );
      expect(failure).not.toContain("must-not-leak");
      expect(existsSync(mutationMarker)).toBe(false);
    } finally {
      for (const name of names) {
        const value = original[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("serializes bootstrap and rechecks role state without repairing existing roles", () => {
    const fakeBin = mkdtempSync(path.join(tmpdir(), "idream-fake-psql-"));
    const fakePsql = path.join(fakeBin, "psql");
    const stdinFile = path.join(fakeBin, "stdin");
    writeFileSync(
      fakePsql,
      `#!/bin/sh
input=$(cat)
printf '%s\n' "$input" >> "$IDREAM_PSQL_STDIN"
case "$input" in
  *"WITH required_roles"*) printf 'f\\n'; exit 0 ;;
  *"pg_advisory_xact_lock"*) exit 1 ;;
esac
exit 1
`,
    );
    chmodSync(fakePsql, 0o755);
    const names = [
      "CHAT_DATABASE_URL",
      "CHAT_PROJECTOR_DATABASE_URL",
      "CHAT_PROJECTOR_PASSWORD",
      "CHAT_SERVICE_PASSWORD",
      "CHAT_TEST_DB",
      "CHAT_TEST_DISPOSABLE_CLUSTER_CONFIRM",
      "DATABASE_URL",
      "IDREAM_PSQL_STDIN",
      "PATH",
      "PGHOST",
      "PGPASSWORD",
      "PGPORT",
    ] as const;
    const original = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );

    try {
      delete process.env.CHAT_DATABASE_URL;
      delete process.env.CHAT_PROJECTOR_DATABASE_URL;
      delete process.env.DATABASE_URL;
      process.env.CHAT_PROJECTOR_PASSWORD = "must-not-leak-projector";
      process.env.CHAT_SERVICE_PASSWORD = "must-not-leak-service";
      process.env.CHAT_TEST_DB = "idream_chat_test_guard";
      process.env.CHAT_TEST_DISPOSABLE_CLUSTER_CONFIRM = "loopback:5433";
      process.env.IDREAM_PSQL_STDIN = stdinFile;
      process.env.PATH = `${fakeBin}:${original.PATH ?? ""}`;
      process.env.PGHOST = "localhost";
      process.env.PGPASSWORD = "must-not-leak-super";
      process.env.PGPORT = "5433";

      expect(() => provisionChatTestDb()).toThrow(
        "psql failed for postgres@localhost:5433/postgres",
      );
      const stdin = readFileSync(stdinFile, "utf8");
      expect(stdin).toContain("pg_advisory_xact_lock");
      expect(stdin).toContain("role state changed while waiting for the bootstrap lock");
      expect(stdin).toContain("role posture drift requires operator repair");
      expect(stdin).not.toContain("ALTER ROLE");
    } finally {
      for (const name of names) {
        const value = original[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("keeps test-role credentials off psql argv and invokes psql without startup files", () => {
    const fakeBin = mkdtempSync(path.join(tmpdir(), "idream-fake-psql-"));
    const fakePsql = path.join(fakeBin, "psql");
    const argsFile = path.join(fakeBin, "args");
    const stdinFile = path.join(fakeBin, "stdin");
    writeFileSync(
      fakePsql,
      `#!/bin/sh
printf '%s\\n' "$@" >> "$IDREAM_PSQL_ARGS"
input=$(cat)
printf '%s\\n' "$input" >> "$IDREAM_PSQL_STDIN"
case "$input" in
  *"WITH required_roles"*) printf 'f\\n'; exit 0 ;;
esac
exit 1
`,
    );
    chmodSync(fakePsql, 0o755);
    const names = [
      "CHAT_DATABASE_URL",
      "CHAT_PROJECTOR_DATABASE_URL",
      "CHAT_PROJECTOR_PASSWORD",
      "CHAT_SERVICE_PASSWORD",
      "CHAT_TEST_DB",
      "CHAT_TEST_DISPOSABLE_CLUSTER_CONFIRM",
      "DATABASE_URL",
      "IDREAM_PSQL_ARGS",
      "IDREAM_PSQL_STDIN",
      "PATH",
      "PGDATABASE",
      "PGHOST",
      "PGHOSTADDR",
      "PGOPTIONS",
      "PGPASSWORD",
      "PGPORT",
      "PGSERVICE",
      "PGSERVICEFILE",
      "PGUSER",
    ] as const;
    const original = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );

    try {
      delete process.env.CHAT_DATABASE_URL;
      delete process.env.CHAT_PROJECTOR_DATABASE_URL;
      delete process.env.DATABASE_URL;
      process.env.CHAT_PROJECTOR_PASSWORD = "must-not-leak-projector";
      process.env.CHAT_SERVICE_PASSWORD = "must-not-leak-service";
      process.env.CHAT_TEST_DB = "idream_chat_test_guard";
      process.env.CHAT_TEST_DISPOSABLE_CLUSTER_CONFIRM = "loopback:5433";
      process.env.IDREAM_PSQL_ARGS = argsFile;
      process.env.IDREAM_PSQL_STDIN = stdinFile;
      process.env.PATH = `${fakeBin}:${original.PATH ?? ""}`;
      process.env.PGHOST = "localhost";
      process.env.PGPASSWORD = "must-not-leak-super";
      process.env.PGPORT = "5433";
      for (const name of [
        "PGDATABASE",
        "PGHOSTADDR",
        "PGOPTIONS",
        "PGSERVICE",
        "PGSERVICEFILE",
        "PGUSER",
      ]) {
        delete process.env[name];
      }

      let failure = "";
      try {
        provisionChatTestDb();
      } catch (error) {
        failure = String(error);
      }
      expect(failure).toContain("psql failed for postgres@localhost:5433/postgres");
      const argv = readFileSync(argsFile, "utf8");
      const stdin = readFileSync(stdinFile, "utf8");
      expect(argv.split("\n")).toContain("-X");
      expect(stdin).toContain("must-not-leak-service");
      expect(stdin).toContain("must-not-leak-projector");
      for (const secret of [
        "must-not-leak-projector",
        "must-not-leak-service",
        "must-not-leak-super",
      ]) {
        expect(argv).not.toContain(secret);
        expect(failure).not.toContain(secret);
      }
    } finally {
      for (const name of names) {
        const value = original[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("rejects a runtime URL whose database path has multiple leading slashes", () => {
    const repoRoot = path.resolve(process.cwd(), "../..");
    const applyPath = path.join(repoRoot, "db/sql/apply-validate.sh");
    const fakeBin = mkdtempSync(path.join(tmpdir(), "idream-fake-psql-"));
    const fakePsql = path.join(fakeBin, "psql");
    writeFileSync(
      fakePsql,
      `#!/bin/sh
case "$*" in
  *"SELECT current_user,current_database();"*) printf 'postgres\\tidream_runtime\\n'; exit 0 ;;
esac
exit 1
`,
    );
    chmodSync(fakePsql, 0o755);

    try {
      const result = spawnSync("bash", [applyPath], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          CHAT_DATABASE_URL:
            "postgresql://chat_service:must-not-leak@127.0.0.1:5433//idream_runtime",
          DB: "idream_runtime",
          HOME: process.env.HOME ?? "",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          PGHOST: "127.0.0.1",
          PGPORT: "5433",
          SUPER: "postgres",
        },
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).not.toBe(0);
      expect(output).toContain("CHAT_DATABASE_URL authority does not match");
      expect(output).not.toContain("== applying boundary SQL");
      expect(output).not.toContain("must-not-leak");
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("admits an exact runtime URL only as far as the first fake DDL", () => {
    const repoRoot = path.resolve(process.cwd(), "../..");
    const applyPath = path.join(repoRoot, "db/sql/apply-validate.sh");
    const fakeBin = mkdtempSync(path.join(tmpdir(), "idream-fake-psql-"));
    const fakePsql = path.join(fakeBin, "psql");
    writeFileSync(
      fakePsql,
      `#!/bin/sh
case "$*" in
  *"SELECT current_user,current_database();"*) printf 'postgres\\tidream_runtime\\n'; exit 0 ;;
  *"inherited_schema_create"*) printf 't\\n'; exit 0 ;;
esac
exit 1
`,
    );
    chmodSync(fakePsql, 0o755);

    try {
      const result = spawnSync("bash", [applyPath], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          CHAT_DATABASE_URL:
            "postgresql://chat_service:must-not-leak@127.0.0.1:5433/idream_runtime",
          DB: "idream_runtime",
          HOME: process.env.HOME ?? "",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          PGHOST: "127.0.0.1",
          PGPORT: "5433",
          SUPER: "postgres",
        },
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).not.toBe(0);
      expect(output).toContain(
        "== applying boundary SQL to chat_service@127.0.0.1:5433/idream_runtime ==",
      );
      expect(output).not.toContain("must-not-leak");
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("blocks inherited PUBLIC capability before the first DDL", () => {
    const repoRoot = path.resolve(process.cwd(), "../..");
    const applyPath = path.join(repoRoot, "db/sql/apply-validate.sh");
    const fakeBin = mkdtempSync(path.join(tmpdir(), "idream-fake-psql-"));
    const fakePsql = path.join(fakeBin, "psql");
    writeFileSync(
      fakePsql,
      `#!/bin/sh
case "$*" in
  *"SELECT current_user,current_database();"*) printf 'postgres\\tidream_runtime\\n'; exit 0 ;;
  *"inherited_schema_create"*) printf 'f\\n'; exit 0 ;;
esac
exit 1
`,
    );
    chmodSync(fakePsql, 0o755);

    try {
      const result = spawnSync("bash", [applyPath], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          CHAT_DATABASE_URL:
            "postgresql://chat_service:must-not-leak@127.0.0.1:5433/idream_runtime",
          DB: "idream_runtime",
          HOME: process.env.HOME ?? "",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          PGHOST: "127.0.0.1",
          PGPORT: "5433",
          SUPER: "postgres",
        },
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).not.toBe(0);
      expect(output).toContain(
        "public schema/table/column ACL exposes inherited runtime capability",
      );
      expect(output).not.toContain("== applying boundary SQL");
      expect(output).not.toContain("must-not-leak");
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("refuses an implicit or mismatched operator database target before DDL", () => {
    const repoRoot = path.resolve(process.cwd(), "../..");
    const applyPath = path.join(repoRoot, "db/sql/apply-validate.sh");
    const baseEnv = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
    };

    const implicit = spawnSync("bash", [applyPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: baseEnv,
    });
    expect(implicit.status).not.toBe(0);
    expect(`${implicit.stdout}${implicit.stderr}`).toContain(
      "DB must be set explicitly",
    );

    const mismatched = spawnSync("bash", [applyPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...baseEnv,
        CHAT_DATABASE_URL:
          "postgresql://chat_service:must-not-leak@127.0.0.1:5432/idream_wrong",
        DB: "idream_runtime",
        PGHOST: "127.0.0.1",
        PGPORT: "5433",
        SUPER: "postgres",
      },
    });
    expect(mismatched.status).not.toBe(0);
    expect(`${mismatched.stdout}${mismatched.stderr}`).toContain(
      "CHAT_DATABASE_URL authority does not match",
    );
    expect(`${mismatched.stdout}${mismatched.stderr}`).not.toContain(
      "must-not-leak",
    );

    const implicitRuntimePort = spawnSync("bash", [applyPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...baseEnv,
        CHAT_DATABASE_URL:
          "postgresql://chat_service:must-not-leak@127.0.0.1/idream_runtime",
        DB: "idream_runtime",
        PGHOST: "127.0.0.1",
        PGPORT: "5433",
        SUPER: "postgres",
      },
    });
    expect(implicitRuntimePort.status).not.toBe(0);
    expect(`${implicitRuntimePort.stdout}${implicitRuntimePort.stderr}`).toContain(
      "CHAT_DATABASE_URL authority does not match",
    );
    expect(`${implicitRuntimePort.stdout}${implicitRuntimePort.stderr}`).not.toContain(
      "must-not-leak",
    );

    const overridden = spawnSync("bash", [applyPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...baseEnv,
        CHAT_DATABASE_URL:
          "postgresql://chat_service:must-not-leak@127.0.0.1:5433/idream_runtime?host=evil.example&port=6543&user=wrong_role",
        DB: "idream_runtime",
        PGHOST: "127.0.0.1",
        PGPORT: "5433",
        SUPER: "postgres",
      },
    });
    expect(overridden.status).not.toBe(0);
    expect(`${overridden.stdout}${overridden.stderr}`).toContain(
      "CHAT_DATABASE_URL authority does not match",
    );
    expect(`${overridden.stdout}${overridden.stderr}`).not.toContain(
      "must-not-leak",
    );

    const ambientOverride = spawnSync("bash", [applyPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...baseEnv,
        CHAT_DATABASE_URL:
          "postgresql://chat_service:must-not-leak@127.0.0.1:5433/idream_runtime",
        DB: "idream_runtime",
        PGHOST: "127.0.0.1",
        PGHOSTADDR: "203.0.113.10",
        PGPORT: "5433",
        SUPER: "postgres",
      },
    });
    expect(ambientOverride.status).not.toBe(0);
    expect(`${ambientOverride.stdout}${ambientOverride.stderr}`).toContain(
      "ambient libpq target variable PGHOSTADDR is not allowed",
    );
    expect(`${ambientOverride.stdout}${ambientOverride.stderr}`).not.toContain(
      "must-not-leak",
    );

    const databaseConnectionString = spawnSync("bash", [applyPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...baseEnv,
        CHAT_DATABASE_URL:
          "postgresql://chat_service:must-not-leak@127.0.0.1:5433/host%3Devil.example%20dbname%3Didream_runtime",
        DB: "host=evil.example dbname=idream_runtime",
        PGHOST: "127.0.0.1",
        PGPORT: "5433",
        SUPER: "postgres",
      },
    });
    expect(databaseConnectionString.status).not.toBe(0);
    expect(`${databaseConnectionString.stdout}${databaseConnectionString.stderr}`).toContain(
      "DB must be a plain PostgreSQL database name",
    );
    expect(`${databaseConnectionString.stdout}${databaseConnectionString.stderr}`).not.toContain(
      "must-not-leak",
    );

    const multiHost = spawnSync("bash", [applyPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...baseEnv,
        CHAT_DATABASE_URL:
          "postgresql://chat_service:must-not-leak@db1.example,db2.example:5433/idream_runtime",
        DB: "idream_runtime",
        PGHOST: "db1.example,db2.example",
        PGPORT: "5433",
        SUPER: "postgres",
      },
    });
    expect(multiHost.status).not.toBe(0);
    expect(`${multiHost.stdout}${multiHost.stderr}`).toContain(
      "PGHOST must name exactly one PostgreSQL host",
    );
    expect(`${multiHost.stdout}${multiHost.stderr}`).not.toContain(
      "must-not-leak",
    );

    const reservedDatabaseEscape = spawnSync("bash", [applyPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...baseEnv,
        CHAT_DATABASE_URL:
          "postgresql://chat_service:must-not-leak@127.0.0.1:5433/foo%2Fbar",
        DB: "foo/bar",
        PGHOST: "127.0.0.1",
        PGPORT: "5433",
        SUPER: "postgres",
      },
    });
    expect(reservedDatabaseEscape.status).not.toBe(0);
    expect(`${reservedDatabaseEscape.stdout}${reservedDatabaseEscape.stderr}`).toContain(
      "CHAT_DATABASE_URL authority does not match",
    );
    expect(`${reservedDatabaseEscape.stdout}${reservedDatabaseEscape.stderr}`).not.toContain(
      "must-not-leak",
    );
  });

  it("refuses inherited shell xtrace before any database command", () => {
    const repoRoot = path.resolve(process.cwd(), "../..");
    const applyPath = path.join(repoRoot, "db/sql/apply-validate.sh");
    const fakeBin = mkdtempSync(path.join(tmpdir(), "idream-fake-psql-"));
    const fakePsql = path.join(fakeBin, "psql");
    writeFileSync(
      fakePsql,
      `#!/bin/sh
case "$*" in
  *"SELECT current_user,current_database();"*) printf 'postgres\\tidream_runtime\\n'; exit 0 ;;
esac
exit 1
`,
    );
    chmodSync(fakePsql, 0o755);

    try {
      const traced = spawnSync("bash", ["-x", applyPath], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          CHAT_DATABASE_URL:
            "postgresql://chat_service:must-not-leak-chat@127.0.0.1:5433/idream_runtime",
          DB: "idream_runtime",
          HOME: process.env.HOME ?? "",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          PGHOST: "127.0.0.1",
          PGPORT: "5433",
          PS4: "idream-trace ",
          SUPER: "postgres",
          SUPER_PASSWORD: "must-not-leak-super",
        },
      });
      const output = `${traced.stdout}${traced.stderr}`;
      expect(traced.status).not.toBe(0);
      expect(output).toContain(
        "apply-validate.sh must not be invoked with shell xtrace",
      );
      expect(output).not.toContain("== applying boundary SQL");
      expect(output).not.toContain("must-not-leak-chat");
      expect(output).not.toContain("must-not-leak-super");
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("keeps the operator apply path portable and role posture fail closed", () => {
    const repoRoot = path.resolve(process.cwd(), "../..");
    const apply = readFileSync(
      path.join(repoRoot, "db/sql/apply-validate.sh"),
      "utf8",
    );
    const roles = readFileSync(
      path.join(repoRoot, "db/sql/01_schemas_roles.sql"),
      "utf8",
    );
    const chatTables = readFileSync(
      path.join(repoRoot, "db/sql/03_chat_tables.sql"),
      "utf8",
    );
    const grants = readFileSync(
      path.join(repoRoot, "db/sql/04_grants.sql"),
      "utf8",
    );

    expect(apply).not.toMatch(/\$\{?BASHPID\b/);
    expect(apply).toContain('if [[ "$-" == *x* ]]');
    expect(apply).toContain(
      "apply-validate.sh must not be invoked with shell xtrace",
    );
    expect(apply).toContain("command psql -X");
    expect(apply).toContain("PGHOSTADDR PGSERVICE PGSERVICEFILE");
    expect(apply).toContain("$(date -u +%Y%m%d%H%M%S)_$$_${RANDOM}");
    expect(apply.indexOf("VALIDATION_PREFIX=")).toBeLessThan(
      apply.indexOf("== applying boundary SQL"),
    );
    expect(roles).toContain("('core_owner', false)");
    expect(roles).toContain("('chat_owner', false)");
    expect(roles).toContain("('chat_service', true)");
    expect(roles).toContain("('chat_projector', true)");
    expect(roles).toContain("rolcanlogin IS DISTINCT FROM");
    expect(roles).toContain("pg_has_role(");
    expect(chatTables).toContain(
      "DROP TRIGGER IF EXISTS message_memory_authority_immutable",
    );
    expect(chatTables).toContain(
      "DROP INDEX IF EXISTS chat.messages_memory_reconcile_eligible_idx",
    );
    expect(chatTables).toContain(
      "DROP CONSTRAINT IF EXISTS chat_scene_revisions_snapshot_schema_check",
    );
    expect(chatTables).toContain(
      "ADD COLUMN IF NOT EXISTS response_status text",
    );
    expect(chatTables).toContain(
      "DROP CONSTRAINT IF EXISTS chat_send_receipts_response_status_check",
    );
    expect(chatTables).toContain(
      "DROP INDEX IF EXISTS chat.chat_send_receipts_user_idempotency_key",
    );
    expect(grants).toContain(
      "REVOKE ALL ON ALL TABLES IN SCHEMA public\n  FROM chat_service, chat_projector",
    );
    expect(grants).not.toContain(
      "REVOKE ALL ON ALL TABLES IN SCHEMA public\n  FROM PUBLIC",
    );
    expect(grants).not.toContain("REVOKE ALL ON SCHEMA public FROM PUBLIC");
    expect(grants).toContain(
      "REVOKE ALL ON ALL TABLES IN SCHEMA chat\n  FROM PUBLIC, chat_service, chat_projector",
    );
    expect(grants).toContain(
      "GRANT UPDATE (log_extracted_seq, updated_at)\n  ON chat.chat_sessions TO chat_projector",
    );
    expect(grants).toContain(
      "GRANT INSERT (\n  id,\n  event_type,",
    );
    expect(grants).toContain(
      "REVOKE ALL ON ALL FUNCTIONS IN SCHEMA chat",
    );
    expect(grants).toContain(
      "ALTER DEFAULT PRIVILEGES FOR ROLE chat_owner\n  REVOKE ALL ON TABLES FROM PUBLIC, chat_service, chat_projector",
    );
    expect(grants).toContain(
      "ALTER DEFAULT PRIVILEGES FOR ROLE chat_owner IN SCHEMA chat\n  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, chat_service, chat_projector",
    );
    expect(grants).not.toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE\s+ON ALL TABLES IN SCHEMA chat TO chat_projector/,
    );
    expect(apply).toContain("pg_get_triggerdef");
    expect(apply).toContain("pg_get_constraintdef");
    expect(apply).toContain("pg_get_indexdef");
    expect(apply).toContain("send receipt columns are complete");
    expect(apply).toContain("tgenabled IN ('O', 'A')");
    expect(apply).toContain("t.tgenabled IN ('O', 'A')");
    expect(apply).not.toContain("tgenabled <> 'D'");
    expect(apply).not.toContain("t.tgenabled <> 'D'");
    expect(apply).toContain("duplicate send idempotency receipt");
    expect(apply).toContain("invalid send response status");
    expect(apply).toContain('projector SELECT public.users');
    expect(apply).toContain('projector SELECT public.entitlements');
    expect(apply).toContain(
      "runtime roles have the exact least-privilege catalog matrix",
    );
    expect(apply).toContain(
      "public schema/table/column ACL exposes inherited runtime capability",
    );
    expect(apply).toContain("aclexplode(attribute.attacl)");
    expect(apply.indexOf("PUBLIC_POSTURE_READY=")).toBeLessThan(
      apply.indexOf("== applying boundary SQL"),
    );
    expect(apply).toContain('CREATE in chat schema');
    expect(apply).toContain('TRUNCATE chat table');
    expect(apply).toContain('REFERENCES chat table');
    expect(apply).toContain('TRIGGER on chat table');
    expect(apply).toContain('projector SELECT unrelated chat table');
    expect(apply).toContain('projector sequence usage');
    expect(apply).toContain('projector UPDATE session title');
    expect(apply).toContain('projector INSERT outbox delivered_at');
    expect(apply).toContain('EXECUTE legacy redactor');
  });

  it("refuses production-like database names before destructive provisioning", () => {
    expect(() => assertSafeChatTestDatabaseName("idream")).toThrow(
      "Refusing to recreate non-test chat database",
    );
    expect(() => assertSafeChatTestDatabaseName("production")).toThrow(
      "Refusing to recreate non-test chat database",
    );
  });

  it("can require the stronger Playwright marker", () => {
    expect(assertSafeChatTestDatabaseName("idream_chat_test")).toBe(
      "idream_chat_test",
    );
    expect(() => assertSafeChatTestDatabaseName(
      "idream_chat_test",
      { requirePlaywright: true },
    )).toThrow("both test and playwright");
    expect(assertSafeChatTestDatabaseName(
      "idream_test_playwright_3110",
      { requirePlaywright: true },
    )).toBe("idream_test_playwright_3110");
  });

  it("derives collision-resistant names for linked worktrees", () => {
    const first = chatTestDatabaseNameForWorkspace("/repo-a/idream", true);
    const second = chatTestDatabaseNameForWorkspace("/repo-b/idream", true);

    expect(first).toMatch(/^idream_chat_test_idream_[a-f0-9]{8}$/);
    expect(second).toMatch(/^idream_chat_test_idream_[a-f0-9]{8}$/);
    expect(first).not.toBe(second);
    expect(chatTestDatabaseNameForWorkspace("/repo/idream", false)).toBe(
      "idream_chat_test",
    );
  });

  it("requires exact CI authority before resetting a remote database", () => {
    const target = {
      database: "idream_chat_test_ci",
      host: "postgres.internal",
    };

    expect(() => assertSafeChatTestDatabaseTarget(target)).toThrow(
      /Refusing remote chat test database reset/,
    );
    expect(() => assertSafeChatTestDatabaseTarget(target, {
      allowRemoteReset: true,
      confirmedDatabaseName: "idream_chat_test_ci",
    })).toThrow(/CI=true/);
    expect(() => assertSafeChatTestDatabaseTarget(target, {
      allowRemoteReset: true,
      ci: true,
      confirmedDatabaseName: "idream_chat_test_other",
    })).toThrow(/confirmation does not match/);
    expect(assertSafeChatTestDatabaseTarget(target, {
      allowRemoteReset: true,
      ci: true,
      confirmedDatabaseName: "idream_chat_test_ci",
    })).toEqual(target);
    expect(() => assertSafeChatTestDatabaseTarget(
      { ...target, host: "postgres-a.internal,postgres-b.internal" },
      {
        allowRemoteReset: true,
        ci: true,
        confirmedDatabaseName: "idream_chat_test_ci",
      },
    )).toThrow(/exactly one PostgreSQL host/);
  });

  it("derives a secret-free Redis namespace from the database target", () => {
    const prefix = chatTestBullMqPrefix({
      database: "idream_chat_test",
      host: "localhost",
      port: "5433",
    });

    expect(prefix).toMatch(/^idream:chat:test:[a-f0-9]{64}$/);
    expect(prefix).not.toContain("postgres");
  });

  it("refuses unsafe Redis cleanup targets", () => {
    expect(() => dedicatedChatTestRedis({
      prefix: "idream:chat:test",
      url: "redis://127.0.0.1:6379/0",
    })).toThrow(/Redis DB 0/);
    expect(() => dedicatedChatTestRedis({
      prefix: "idream:chat:test",
      url: "redis://redis.internal:6379/14",
    })).toThrow(/external test Redis/);
    expect(() => dedicatedChatTestRedis({
      prefix: "idream:development",
      url: "redis://127.0.0.1:6379/14",
    })).toThrow(/non-test BullMQ prefix/);
  });

  it("holds a suite lease that rejects a concurrent destructive provision", async () => {
    await expect(acquireChatTestDatabaseLease({
      database: process.env.CHAT_TEST_DB ?? "idream_chat_test",
      host: process.env.PGHOST ?? "localhost",
      password:
        process.env.PGPASSWORD ??
        process.env.POSTGRES_PASSWORD ??
        "postgres",
      port: process.env.PGPORT ?? "5433",
      user: process.env.PG_SUPER ?? "postgres",
    })).rejects.toThrow(/another Chat test run is active/);
  });
});
