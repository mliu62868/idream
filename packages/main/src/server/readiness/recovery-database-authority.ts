export type DatabaseAclEntry = {
  readonly grantor: string;
  readonly grantor_is_superuser: boolean;
  readonly grantee: string;
  readonly privilege: string;
  readonly grantable: boolean;
};

export type RecoveryDatabaseAuthority = {
  readonly database: {
    readonly owner: string;
    readonly encoding: string;
    readonly locale_provider: string;
    readonly collate: string;
    readonly ctype: string;
    readonly icu_locale: string | null;
    readonly icu_rules: string | null;
    readonly tablespace: string;
    readonly connection_limit: number;
    readonly comment: string | null;
    readonly acl_is_null: boolean;
    readonly acl: readonly DatabaseAclEntry[];
  };
  readonly database_role_settings: readonly {
    readonly role: string | null;
    readonly settings: readonly string[];
  }[];
};

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

// INVARIANT: a delegated GRANT can only be replayed after its grantor has the
// same privilege with grant option. Database owners and superusers are roots.
export function orderDatabaseAclEntries(
  owner: string,
  entries: readonly DatabaseAclEntry[],
) {
  const pending = [...entries];
  const ordered: DatabaseAclEntry[] = [];
  const delegated = new Map<string, Set<string>>();
  while (pending.length > 0) {
    const index = pending.findIndex((entry) =>
      entry.grantor === owner ||
      entry.grantor_is_superuser ||
      delegated.get(entry.privilege)?.has(entry.grantor)
    );
    if (index < 0) {
      throw new Error("database ACL grant chain is not replayable");
    }
    const [entry] = pending.splice(index, 1);
    ordered.push(entry!);
    if (entry!.grantable && entry!.grantee !== "PUBLIC") {
      const authorities = delegated.get(entry!.privilege) ?? new Set<string>();
      authorities.add(entry!.grantee);
      delegated.set(entry!.privilege, authorities);
    }
  }
  return ordered;
}

// SPEC: producer and read-only Gate share one byte-exact executable authority.
// Token/substring inspection is not sufficient because comments can spoof it.
export function renderRecoveryDatabaseAuthoritySql(
  authority: RecoveryDatabaseAuthority,
) {
  const database = authority.database;
  const lines = [
    "\\set ON_ERROR_STOP on",
    "\\if :{?target_database}",
    "\\else",
    "SELECT 1 / 0;",
    "\\endif",
    `SELECT format('ALTER DATABASE %I WITH CONNECTION LIMIT ${database.connection_limit}', :'target_database') \\gexec`,
    database.comment === null
      ? "SELECT format('COMMENT ON DATABASE %I IS NULL', :'target_database') \\gexec"
      : `SELECT format('COMMENT ON DATABASE %I IS %L', :'target_database', ${quoteLiteral(database.comment)}) \\gexec`,
  ];
  if (!database.acl_is_null) {
    const grantees = new Set(database.acl.map((entry) => entry.grantee));
    grantees.add("PUBLIC");
    for (const grantee of grantees) {
      const rendered = grantee === "PUBLIC" ? "PUBLIC" : quoteIdentifier(grantee);
      lines.push(
        `SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM ${rendered}', :'target_database') \\gexec`,
      );
    }
    for (const entry of orderDatabaseAclEntries(database.owner, database.acl)) {
      const grantee = entry.grantee === "PUBLIC"
        ? "PUBLIC"
        : quoteIdentifier(entry.grantee);
      lines.push(`SET SESSION AUTHORIZATION ${quoteIdentifier(entry.grantor)};`);
      lines.push(
        `SELECT format('GRANT ${entry.privilege} ON DATABASE %I TO ${grantee}${entry.grantable ? " WITH GRANT OPTION" : ""}', :'target_database') \\gexec`,
      );
      lines.push("RESET SESSION AUTHORIZATION;");
    }
  }
  for (const entry of authority.database_role_settings) {
    for (const setting of entry.settings) {
      const separator = setting.indexOf("=");
      if (separator <= 0) throw new Error("database role setting is malformed");
      const name = quoteIdentifier(setting.slice(0, separator));
      const value = quoteLiteral(setting.slice(separator + 1));
      if (entry.role === null) {
        lines.push(
          `SELECT format('ALTER DATABASE %I SET ${name} TO %L', :'target_database', ${value}) \\gexec`,
        );
      } else {
        lines.push(
          `SELECT format('ALTER ROLE ${quoteIdentifier(entry.role)} IN DATABASE %I SET ${name} TO %L', :'target_database', ${value}) \\gexec`,
        );
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
