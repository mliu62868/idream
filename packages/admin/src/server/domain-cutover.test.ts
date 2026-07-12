import { describe, expect, it } from "vitest";
import {
  ADMIN_DOMAIN_CUTOVER_MANIFEST,
  adminCutoverDomainForPath,
  resolveAdminDomainReadRoute,
} from "./domain-cutover";

describe("Admin domain read cutover manifest", () => {
  it("owns the five workflow domains with explicit, type-safe controls", () => {
    expect(Object.keys(ADMIN_DOMAIN_CUTOVER_MANIFEST)).toEqual([
      "character",
      "creative",
      "incident",
      "case",
      "today",
    ]);
    expect(ADMIN_DOMAIN_CUTOVER_MANIFEST.character).toMatchObject({
      routeSegment: "characters",
      readAuthorityEnv: "ADMIN_CHARACTER_READ_AUTHORITY",
      compatibilityBaseUrlEnv: "ADMIN_CHARACTER_COMPATIBILITY_READ_URL",
    });
  });

  it("selects canonical v2 independently by domain", () => {
    expect(resolveAdminDomainReadRoute({
      method: "GET",
      pathname: "/api/v2/admin/characters/portfolio",
      environment: {},
    })).toEqual({
      kind: "selected",
      domain: "character",
      readAuthority: "canonical_v2",
      upstreamBaseUrl: "http://127.0.0.1:3000",
    });
    expect(resolveAdminDomainReadRoute({
      method: "GET",
      pathname: "/api/v2/admin/incidents",
      environment: { ADMIN_CHARACTER_READ_AUTHORITY: "deployment_rollback" },
    })).toMatchObject({
      kind: "selected",
      domain: "incident",
      readAuthority: "canonical_v2",
    });
  });

  it.each([
    ["/api/v2/admin/characters", "character"],
    ["/api/v2/admin/creative/runs", "creative"],
    ["/api/v2/admin/incidents/incident-1", "incident"],
    ["/api/v2/admin/cases/case-1", "case"],
    ["/api/v2/admin/today", "today"],
  ] as const)("classifies %s as the %s domain", (pathname, domain) => {
    expect(adminCutoverDomainForPath(pathname)).toBe(domain);
  });

  it("uses only an explicitly configured same-contract HTTP compatibility authority", () => {
    expect(resolveAdminDomainReadRoute({
      method: "HEAD",
      pathname: "/api/v2/admin/creative/runs/run-1",
      environment: {
        ADMIN_CREATIVE_READ_AUTHORITY: "compatibility_http",
        ADMIN_CREATIVE_COMPATIBILITY_READ_URL: "https://previous-main.internal/",
      },
    })).toEqual({
      kind: "selected",
      domain: "creative",
      readAuthority: "compatibility_http",
      upstreamBaseUrl: "https://previous-main.internal",
    });
  });

  it("does not invent a legacy DTO mapping when compatibility is absent", () => {
    expect(resolveAdminDomainReadRoute({
      method: "GET",
      pathname: "/api/v2/admin/cases",
      environment: { ADMIN_CASE_READ_AUTHORITY: "compatibility_http" },
    })).toEqual({
      kind: "unavailable",
      domain: "case",
      readAuthority: "unavailable",
      code: "admin_case_compatibility_read_unconfigured",
      message: "Case compatibility read authority is not configured",
    });
    expect(resolveAdminDomainReadRoute({
      method: "GET",
      pathname: "/api/v2/admin/today",
      environment: { ADMIN_TODAY_READ_AUTHORITY: "legacy_v1" },
    })).toMatchObject({
      kind: "unavailable",
      domain: "today",
      code: "admin_today_read_authority_invalid",
    });
  });

  it("fails closed instead of silently replacing an invalid canonical authority", () => {
    expect(resolveAdminDomainReadRoute({
      method: "GET",
      pathname: "/api/v2/admin/characters",
      environment: { MAIN_WEB_URL: "not-a-valid-authority" },
    })).toEqual({
      kind: "unavailable",
      domain: "character",
      readAuthority: "unavailable",
      code: "admin_character_canonical_read_unconfigured",
      message: "Character canonical read authority is not configured",
    });
  });

  it("requires deployment rollback explicitly and never routes writes through a read flag", () => {
    expect(resolveAdminDomainReadRoute({
      method: "GET",
      pathname: "/api/v2/admin/incidents",
      environment: { ADMIN_INCIDENT_READ_AUTHORITY: "deployment_rollback" },
    })).toEqual({
      kind: "unavailable",
      domain: "incident",
      readAuthority: "unavailable",
      code: "admin_incident_read_deployment_rollback_required",
      message: "Incident read authority requires an Admin deployment rollback",
    });
    expect(resolveAdminDomainReadRoute({
      method: "POST",
      pathname: "/api/v2/admin/incidents/incident-1/commands/resolve",
      environment: {
        ADMIN_INCIDENT_READ_AUTHORITY: "compatibility_http",
        ADMIN_INCIDENT_COMPATIBILITY_READ_URL: "https://previous-main.internal",
      },
    })).toEqual({ kind: "not_read", domain: "incident" });
  });
});
