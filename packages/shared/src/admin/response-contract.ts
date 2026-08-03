import { findAdminV2ApiOperation, type AdminV2ApiOperation } from "./api-manifest";
import { requireExecutableAdminV2Contract } from "./contract-registry";

/**
 * SPEC: why a response is outside the contract its operation declares.
 * INTENT: the producer turns this into a 500 (its own bug) and the BFF into a 502 (its
 * upstream's bug). They disagree about the status code and about nothing else, so the
 * judgement itself is shared and only the disposition is local.
 */
export type AdminV2ResponseViolation = {
  readonly operationId: string;
  readonly contractRef: string;
  readonly reason:
    | "undeclared_operation"
    | "unparsable_body"
    | "envelope_shape"
    | "contract";
};

export type AdminV2ResponseNarrowing =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly violation: AdminV2ResponseViolation };

/**
 * SPEC: the only answer to "is this Admin v2 success payload inside the contract its
 * operation declares", and the narrowed value when it is.
 *
 * INTENT: this judgement had one implementation, in the Admin BFF proxy, which meant a
 * response only met its contract *after* crossing a process boundary — the process that
 * produced it never checked. Putting the judgement in `shared` lets the producing route
 * apply it before the bytes leave, without the two ends growing separate opinions about
 * what "inside the contract" means.
 *
 * INVARIANT: returns the *narrowed* value, not the input. A declared contract that does not
 * govern what actually ships is a description, not an authority.
 */
export function narrowAdminV2ResponseData(
  operation: AdminV2ApiOperation,
  data: unknown,
): AdminV2ResponseNarrowing {
  const contractRef = operation.contract.response;
  const parsed = requireExecutableAdminV2Contract(contractRef).schema.safeParse(data);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, violation: { operationId: operation.id, contractRef, reason: "contract" } };
}

/**
 * SPEC: the same judgement for a serialized `{ ok: true, data }` envelope observed on the wire.
 * INTENT: a consumer sees bytes and a URL, never an operation object. Resolving the operation
 * here keeps "which contract governs this response" a single manifest lookup on both sides.
 */
export function narrowAdminV2ResponseEnvelope(
  method: string,
  pathname: string,
  rawBody: string,
): AdminV2ResponseNarrowing {
  const operation = findAdminV2ApiOperation(method, pathname);
  if (!operation) {
    return {
      ok: false,
      violation: {
        operationId: `${method} ${pathname}`,
        contractRef: "undeclared",
        reason: "undeclared_operation",
      },
    };
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(rawBody) as unknown;
  } catch {
    return { ok: false, violation: violationOf(operation, "unparsable_body") };
  }
  if (!isRecord(envelope) || envelope.ok !== true || !("data" in envelope)) {
    return { ok: false, violation: violationOf(operation, "envelope_shape") };
  }
  return narrowAdminV2ResponseData(operation, envelope.data);
}

function violationOf(
  operation: AdminV2ApiOperation,
  reason: AdminV2ResponseViolation["reason"],
): AdminV2ResponseViolation {
  return { operationId: operation.id, contractRef: operation.contract.response, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
