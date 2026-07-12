export type AdminCutoverDomain = "character" | "creative" | "incident" | "case" | "today";

export type AdminDomainReadAuthority = "canonical_v2" | "compatibility_http";

type AdminReadAuthorityFlag = AdminDomainReadAuthority | "deployment_rollback";

type DomainCutoverManifestEntry = {
  readonly displayName: string;
  readonly routeSegment: string;
  readonly readAuthorityEnv: string;
  readonly compatibilityBaseUrlEnv: string;
  readonly compatibilityContract: string;
};

export const ADMIN_DOMAIN_CUTOVER_MANIFEST = {
  character: {
    displayName: "Character",
    routeSegment: "characters",
    readAuthorityEnv: "ADMIN_CHARACTER_READ_AUTHORITY",
    compatibilityBaseUrlEnv: "ADMIN_CHARACTER_COMPATIBILITY_READ_URL",
    compatibilityContract: "admin-v2-character-read-v1",
  },
  creative: {
    displayName: "Creative",
    routeSegment: "creative",
    readAuthorityEnv: "ADMIN_CREATIVE_READ_AUTHORITY",
    compatibilityBaseUrlEnv: "ADMIN_CREATIVE_COMPATIBILITY_READ_URL",
    compatibilityContract: "admin-v2-creative-read-v1",
  },
  incident: {
    displayName: "Incident",
    routeSegment: "incidents",
    readAuthorityEnv: "ADMIN_INCIDENT_READ_AUTHORITY",
    compatibilityBaseUrlEnv: "ADMIN_INCIDENT_COMPATIBILITY_READ_URL",
    compatibilityContract: "admin-v2-incident-read-v1",
  },
  case: {
    displayName: "Case",
    routeSegment: "cases",
    readAuthorityEnv: "ADMIN_CASE_READ_AUTHORITY",
    compatibilityBaseUrlEnv: "ADMIN_CASE_COMPATIBILITY_READ_URL",
    compatibilityContract: "admin-v2-case-read-v1",
  },
  today: {
    displayName: "Today",
    routeSegment: "today",
    readAuthorityEnv: "ADMIN_TODAY_READ_AUTHORITY",
    compatibilityBaseUrlEnv: "ADMIN_TODAY_COMPATIBILITY_READ_URL",
    compatibilityContract: "admin-v2-today-read-v1",
  },
} as const satisfies Record<AdminCutoverDomain, DomainCutoverManifestEntry>;

type Environment = Readonly<Record<string, string | undefined>>;

type SelectedDomainReadRoute = {
  readonly kind: "selected";
  readonly domain: AdminCutoverDomain;
  readonly readAuthority: AdminDomainReadAuthority;
  readonly upstreamBaseUrl: string;
};

type UnavailableDomainReadRoute = {
  readonly kind: "unavailable";
  readonly domain: AdminCutoverDomain;
  readonly readAuthority: "unavailable";
  readonly code: string;
  readonly message: string;
};

type DomainReadRoute =
  | SelectedDomainReadRoute
  | UnavailableDomainReadRoute
  | { readonly kind: "not_read"; readonly domain: AdminCutoverDomain }
  | { readonly kind: "not_domain" };

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function adminCutoverDomainForPath(pathname: string): AdminCutoverDomain | null {
  for (const [domain, entry] of Object.entries(ADMIN_DOMAIN_CUTOVER_MANIFEST) as Array<
    [AdminCutoverDomain, DomainCutoverManifestEntry]
  >) {
    const prefix = `/api/v2/admin/${entry.routeSegment}`;
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return domain;
  }
  return null;
}

export function resolveAdminDomainReadRoute(input: {
  readonly method: string;
  readonly pathname: string;
  readonly environment: Environment;
}): DomainReadRoute {
  const domain = adminCutoverDomainForPath(input.pathname);
  if (!domain) return { kind: "not_domain" };
  if (!READ_METHODS.has(input.method.toUpperCase())) return { kind: "not_read", domain };

  const entry = ADMIN_DOMAIN_CUTOVER_MANIFEST[domain];
  const rawAuthority = input.environment[entry.readAuthorityEnv]?.trim();
  const authority: AdminReadAuthorityFlag = rawAuthority === undefined || rawAuthority === ""
    ? "canonical_v2"
    : rawAuthority as AdminReadAuthorityFlag;

  if (authority === "canonical_v2") {
    return {
      kind: "selected",
      domain,
      readAuthority: authority,
      upstreamBaseUrl: canonicalMainBaseUrl(input.environment),
    };
  }
  if (authority === "deployment_rollback") {
    return {
      kind: "unavailable",
      domain,
      readAuthority: "unavailable",
      code: `admin_${domain}_read_deployment_rollback_required`,
      message: `${entry.displayName} read authority requires an Admin deployment rollback`,
    };
  }
  if (authority !== "compatibility_http") {
    return {
      kind: "unavailable",
      domain,
      readAuthority: "unavailable",
      code: `admin_${domain}_read_authority_invalid`,
      message: `${entry.displayName} read authority is invalid`,
    };
  }

  const compatibilityBaseUrl = normalizeHttpBaseUrl(
    input.environment[entry.compatibilityBaseUrlEnv],
  );
  if (!compatibilityBaseUrl) {
    return {
      kind: "unavailable",
      domain,
      readAuthority: "unavailable",
      code: `admin_${domain}_compatibility_read_unconfigured`,
      message: `${entry.displayName} compatibility read authority is not configured`,
    };
  }
  return {
    kind: "selected",
    domain,
    readAuthority: authority,
    upstreamBaseUrl: compatibilityBaseUrl,
  };
}

export function canonicalMainBaseUrl(environment: Environment) {
  return normalizeHttpBaseUrl(environment.MAIN_WEB_URL) ?? "http://127.0.0.1:3000";
}

function normalizeHttpBaseUrl(value: string | undefined) {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    if (!url.protocol.match(/^https?:$/) || url.username || url.password) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}
