import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import {
  adminReleaseGateEvidenceSchema,
  adminUnsignedReleaseGateEvidenceSchema,
  evaluateAdminReleaseGate,
  type AdminReleaseGateEvidence,
  type AdminUnsignedReleaseGateEvidence,
} from "@idream/shared/admin";
import { canonicalJson } from "@idream/shared/contracts";

const SIGNATURE_DOMAIN = "idream.admin.release-gate.v3\0";

type SignatureErrorCode =
  | "evidence_signature_missing"
  | "evidence_signature_key_untrusted"
  | "evidence_signature_invalid"
  | "evidence_signature_trust_unconfigured";

class ReleaseEvidenceSignatureError extends Error {
  constructor(readonly code: SignatureErrorCode, message: string) {
    super(message);
    this.name = "ReleaseEvidenceSignatureError";
  }
}

interface ProvenancePayload {
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  readonly signedAt: string;
}

function signingBytes(
  evidence: AdminUnsignedReleaseGateEvidence,
  provenance: ProvenancePayload,
) {
  return Buffer.from(`${SIGNATURE_DOMAIN}${canonicalJson({ evidence, provenance })}`, "utf8");
}

function assertEd25519Key(key: ReturnType<typeof createPrivateKey> | ReturnType<typeof createPublicKey>) {
  if (key.asymmetricKeyType !== "ed25519") {
    throw new ReleaseEvidenceSignatureError("evidence_signature_invalid", "Admin release evidence requires an Ed25519 key");
  }
}

export function signAdminReleaseEvidence(
  input: unknown,
  options: {
    readonly privateKeyPem: string | Buffer;
    readonly keyId: string;
    readonly signedAt?: Date;
  },
): AdminReleaseGateEvidence {
  const evidence = adminUnsignedReleaseGateEvidenceSchema.parse(input);
  const provenance: ProvenancePayload = {
    algorithm: "Ed25519",
    keyId: options.keyId.trim(),
    signedAt: (options.signedAt ?? new Date()).toISOString(),
  };
  if (!provenance.keyId) throw new Error("A trusted release evidence key ID is required");
  const privateKey = createPrivateKey(options.privateKeyPem);
  assertEd25519Key(privateKey);
  const signature = sign(null, signingBytes(evidence, provenance), privateKey).toString("base64url");
  return adminReleaseGateEvidenceSchema.parse({ ...evidence, provenance: { ...provenance, signature } });
}

export function verifyAdminReleaseEvidence(
  input: unknown,
  options: {
    readonly publicKeyPem?: string | Buffer;
    readonly expectedKeyId?: string;
  },
) {
  if (!options.publicKeyPem || !options.expectedKeyId?.trim()) {
    throw new ReleaseEvidenceSignatureError(
      "evidence_signature_trust_unconfigured",
      "Trusted Admin release public key and key ID are required",
    );
  }
  const raw = input as { provenance?: { signature?: unknown } } | null;
  if (!raw || typeof raw !== "object" || typeof raw.provenance?.signature !== "string") {
    throw new ReleaseEvidenceSignatureError("evidence_signature_missing", "Admin release evidence signature is missing");
  }

  let manifest: AdminReleaseGateEvidence;
  try {
    manifest = adminReleaseGateEvidenceSchema.parse(input);
  } catch {
    throw new ReleaseEvidenceSignatureError("evidence_signature_invalid", "Admin release evidence or signature envelope is malformed");
  }
  if (manifest.provenance.keyId !== options.expectedKeyId.trim()) {
    throw new ReleaseEvidenceSignatureError("evidence_signature_key_untrusted", "Admin release evidence key ID is not trusted by this gate");
  }
  const publicKey = createPublicKey(options.publicKeyPem);
  assertEd25519Key(publicKey);
  const { provenance, ...evidence } = manifest;
  const { signature, ...provenancePayload } = provenance;
  const payload = signingBytes(evidence, provenancePayload);
  if (!verify(null, payload, publicKey, Buffer.from(signature, "base64url"))) {
    throw new ReleaseEvidenceSignatureError("evidence_signature_invalid", "Admin release evidence signature verification failed");
  }
  return {
    manifest,
    verification: {
      verified: true as const,
      algorithm: "Ed25519" as const,
      keyId: provenance.keyId,
      manifestDigest: createHash("sha256").update(payload).digest("hex"),
    },
  };
}

function blockedSignatureReport(error: ReleaseEvidenceSignatureError) {
  return {
    status: "blocked" as const,
    decisionUse: "blocked" as const,
    blockers: [{ code: error.code, message: error.message, path: "provenance.signature" }],
    evidence: null,
  };
}

export function evaluateSignedAdminReleaseGate(
  input: unknown,
  options: {
    readonly publicKeyPem?: string | Buffer;
    readonly expectedKeyId?: string;
    readonly now?: Date;
  },
) {
  try {
    const { manifest, verification } = verifyAdminReleaseEvidence(input, options);
    return evaluateAdminReleaseGate(manifest, options.now ?? new Date(), verification);
  } catch (error) {
    if (error instanceof ReleaseEvidenceSignatureError) return blockedSignatureReport(error);
    return blockedSignatureReport(new ReleaseEvidenceSignatureError(
      "evidence_signature_invalid",
      error instanceof Error ? error.message : "Admin release evidence verification failed",
    ));
  }
}
