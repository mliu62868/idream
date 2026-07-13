import { describe, expect, it } from "vitest";
import {
  ADMIN_V2_API_OPERATIONS,
  ADMIN_V2_PENDING_CONTRACTS,
  requireExecutableAdminV2Contract,
} from "@idream/shared/admin";

const contractClasses = {
  query: [
    "customerListQuerySchema",
    "experimentAnalysisQuerySchema",
    "experimentDefinitionListQuerySchema",
    "globalAdminSearchQuerySchema",
    "metricDashboardQuerySchema",
    "metricQualityQuerySchema",
    "metricReconciliationQuerySchema",
    "savedViewListQuerySchema",
    "todayProjectionQuerySchema",
  ],
  command: [
    "adminGrantBundleWriteSchema",
    "adminGrantBundleRevokeSchema",
    "generationRequestCancelSchema",
  ],
  listResponse: [
    "adminGrantBundleListSchema",
    "experimentDefinitionListSchema",
    "globalAdminSearchResponseSchema",
  ],
  detailResponse: [
    "incidentDetailSchema",
    "operationsCaseDetailSchema",
  ],
  mutationResponse: [
    "adminBackfillResultSchema",
    "adminGrantBundleMutationSchema",
    "caseMutationResultSchema",
    "caseReopenResultSchema",
    "creativeRunCreateResultSchema",
    "generationRequestCancelResultSchema",
    "incidentCloseResultSchema",
    "incidentRecoveryVerificationResultSchema",
    "incidentMergeResultSchema",
    "incidentSplitResultSchema",
    "incidentTriageResultSchema",
    "savedViewDeleteSchema",
  ],
} as const;

const refs = [...new Set(ADMIN_V2_API_OPERATIONS.flatMap((operation) => [
  operation.contract.request.split("+")[0]!,
  operation.contract.response.split("+")[0]!,
]))];

describe("Admin v2 shared contract HTTP/in-process parity", () => {
  it("keeps the entire manifest executable with no pending escape hatch", () => {
    expect(Object.keys(ADMIN_V2_PENDING_CONTRACTS)).toHaveLength(0);
    expect(refs).toHaveLength(132);
    for (const ref of refs) expect(requireExecutableAdminV2Contract(ref).fixtureKey).toBe(ref);
  });

  for (const [contractClass, classRefs] of Object.entries(contractClasses)) {
    it(`round-trips every ${contractClass} contract through the real JSON transport boundary`, async () => {
      for (const ref of classRefs) {
        expect(refs, `${ref} must be bound by the manifest`).toContain(ref);
        const binding = requireExecutableAdminV2Contract(ref);
        const inProcess = binding.schema.parse(binding.fixtures.valid);
        const response = Response.json({ ok: true, data: inProcess });
        const envelope = await response.json() as { data: unknown };
        const overHttp = binding.schema.parse(envelope.data);

        expect(JSON.parse(JSON.stringify(overHttp)), `${ref} HTTP parity`)
          .toEqual(JSON.parse(JSON.stringify(inProcess)));
        expect(binding.schema.safeParse(binding.fixtures.invalid).success, `${ref} negative`)
          .toBe(false);
      }
    });
  }
});
