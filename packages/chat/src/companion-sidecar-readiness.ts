import {
  companionReadinessSchema,
  type CompanionReadiness,
} from "@idream/shared/chat/companion-runtime";

export async function probeCompanionSidecar(input: {
  baseUrl: string;
  token: string;
  expectedProvider: string;
  expectedModel: string;
  fetchImpl?: typeof fetch;
}): Promise<CompanionReadiness> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${input.baseUrl.replace(/\/$/, "")}/readyz`,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.token}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`companion sidecar readiness failed with HTTP ${response.status}`);
  }
  const readiness = companionReadinessSchema.parse(await response.json());
  if (
    readiness.provider.name !== input.expectedProvider ||
    readiness.provider.model !== input.expectedModel
  ) {
    throw new Error("companion sidecar resolved a different provider profile");
  }
  return readiness;
}
