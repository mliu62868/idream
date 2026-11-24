import { creativeRunCreateRequestSchema, type CreativeRunFillSkip } from "@idream/shared/admin";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import {
  beginDurableMutationIntent,
  clearDurableMutationIntent,
  readActiveDurableMutationIntent,
  readDurableMutationIntent,
  updateDurableMutationIntent,
  withDurableMutationIntentLock,
  type DurableMutationIntent,
} from "@/lib/durable-mutation-intent";
import { reconcileDurableMutationIntent } from "@/lib/durable-mutation-recovery";

type CreateRequest = ReturnType<typeof creativeRunCreateRequestSchema.parse>;
type RecoveryReceipt = Awaited<ReturnType<typeof reconcileDurableMutationIntent>>;
type RecoveryPurpose = Extract<Parameters<typeof reconcileDurableMutationIntent>[0], {
  commandType: "creative.run.create";
}>["expectedPurpose"];

type CommittedRun = {
  readonly state: "committed";
  readonly runId: string;
  readonly request: CreateRequest;
  readonly replayed: boolean;
  readonly source: "submission" | "reconciliation" | "projection";
};
type SupersededRun = { readonly state: "superseded" };
type BlockedRun = { readonly state: "blocked"; readonly intent: DurableMutationIntent };
type SkippedRun = { readonly state: "skipped"; readonly skip: CreativeRunFillSkip };
type SubmissionResult = CommittedRun | SkippedRun | BlockedRun | SupersededRun;
type CreateResult = SubmissionResult
  | { readonly state: "cancelled" }
  | { readonly state: "pending"; readonly receipt: RecoveryReceipt };
type PreparedRun = {
  readonly action: "submit" | "reconcile";
  readonly intent: DurableMutationIntent;
  readonly request: CreateRequest | null;
  readonly firstSubmission: boolean;
  readonly persisted: boolean;
};

type CreateOptions = {
  readonly scope: string;
  readonly characterId: string;
  readonly expectedPurpose?: RecoveryPurpose;
  readonly intent: DurableMutationIntent | null;
  /** Editable input is ignored whenever an earlier intent exists. */
  readonly request: unknown;
  /** Each workspace keeps its own purpose/profile requirements. */
  readonly parseRequest: (snapshot: unknown) => CreateRequest | null;
  readonly signature: (request: CreateRequest) => string;
  readonly onIntentChange: (intent: DurableMutationIntent | null) => void;
  /** Video creation also coordinates a Character workspace refresh. */
  readonly commit?: (submit: () => Promise<SubmissionResult>) => Promise<SubmissionResult>;
};

export async function createOrRecoverCharacterRun(options: CreateOptions): Promise<Exclude<CreateResult, SkippedRun>> {
  const result = await executeCharacterRunIntent(options, false);
  if (result.state === "skipped") throw new Error("The receipt does not match this explicit Run request.");
  return result;
}

/**
 * SPEC: Own the complete Creative Run admission/recovery protocol. Callers provide
 * the creative request and verify its displayed projection; they never decide
 * when a rejected replay makes an earlier submission safe to forget.
 * INVARIANT: only a newly claimed intent can be released by a submission rejection.
 * Replay marking, response settlement and projection release share the claim lock.
 * HTTP stays outside that lock so a lost response cannot block another tab's recovery.
 */
async function executeCharacterRunIntent(options: CreateOptions, allowFill: boolean): Promise<CreateResult> {
  const locked = <T>(transition: () => T) => withDurableMutationIntentLock(options.scope, transition);
  const remember = (next: DurableMutationIntent | null) => options.onIntentChange(next);
  const parseRequest = (snapshot: unknown) => {
    const request = options.parseRequest(snapshot);
    return request?.targetType === "character" && request.targetId === options.characterId &&
      (allowFill || !request.fillMissing) &&
      (!options.expectedPurpose || request.purpose === options.expectedPurpose)
      ? request : null;
  };
  const prepared = await locked((): PreparedRun | CreateResult => {
    const stored = readActiveDurableMutationIntent({ scope: options.scope });
    let intent = stored ?? (options.intent?.scope === options.scope ? options.intent : null);
    if (stored && options.intent?.idempotencyKey !== stored.idempotencyKey) {
      remember(stored);
      return { state: "blocked", intent: stored };
    }
    let firstSubmission = false;
    if (!stored) {
      const draft = intent ? null : parseRequest(options.request);
      if (!intent && !draft) throw new Error("The generation request does not match this Character workspace.");
      const signature = intent?.signature ?? options.signature(draft!);
      const orphan = readDurableMutationIntent({ scope: options.scope, signature });
      const previous = orphan ?? intent;
      const claimed = beginDurableMutationIntent({
        scope: options.scope, signature,
        requestSnapshot: previous?.requestSnapshot ?? draft ?? undefined,
        ...(previous ? { createIdempotencyKey: () => previous.idempotencyKey } : {}),
      });
      // A stale page or orphaned journal row must reattach its active pointer and
      // reconcile the original key. Never silently turn it into a fresh POST.
      firstSubmission = !previous;
      intent = previous
        ? updateDurableMutationIntent(claimed, { status: "reconciliation_required" })
        : claimed;
    }
    if (!intent) throw new Error("The generation request has no durable intent.");
    const request = parseRequest(intent.requestSnapshot);
    const reconcile = intent.status === "reconciliation_required" || !request ||
      (intent.status === "committed_projection_pending" && !intent.committedTargetId);
    if (!reconcile && request && intent.status === "committed_projection_pending" && intent.committedTargetId) {
      remember(intent);
      return { state: "committed", runId: intent.committedTargetId, request, replayed: true, source: "projection" };
    }
    intent = updateDurableMutationIntent(intent, {
      status: reconcile ? "reconciliation_required" : intent.status,
      ...(!firstSubmission ? { replayStarted: true as const } : {}),
    });
    remember(intent);
    return {
      action: reconcile ? "reconcile" : "submit", intent, request, firstSubmission,
      persisted: readActiveDurableMutationIntent({ scope: options.scope })?.idempotencyKey === intent.idempotencyKey,
    };
  });
  if ("state" in prepared) return prepared;

  // Every response rechecks journal ownership inside the same lock. A late reply
  // cannot resurrect a released key or overwrite the next request (even with the
  // same signature). Storage-denied pages retain their existing in-memory fallback.
  const settle = <T>(transition: (current: DurableMutationIntent) => T): Promise<T | BlockedRun | SupersededRun> => locked(() => {
    const current = readActiveDurableMutationIntent({ scope: options.scope });
    if (current && current.idempotencyKey !== prepared.intent.idempotencyKey) {
      remember(current);
      return { state: "blocked", intent: current };
    }
    if (!current && prepared.persisted) {
      remember(null);
      return { state: "superseded" };
    }
    return transition(current ?? prepared.intent);
  });

  if (prepared.action === "reconcile") {
    const receipt = await reconcileDurableMutationIntent({
      intent: prepared.intent,
      commandType: "creative.run.create",
      expectedCharacterId: options.characterId,
      ...(options.expectedPurpose ? { expectedPurpose: options.expectedPurpose } : {}),
    });
    return settle((current): CreateResult => {
      if (receipt.state === "cancelled") {
        // Another response may already have confirmed the exact committed Run.
        if (current.status === "committed_projection_pending") {
          remember(current);
          return { state: "blocked", intent: current };
        }
        clearDurableMutationIntent(current);
        remember(null);
        return { state: "cancelled" };
      }
      if (receipt.state !== "committed") return { state: "pending", receipt };
      if (receipt.verification?.kind === "creative_run_fill_skipped") {
        const request = parseRequest(receipt.verification.requestSnapshot);
        if (!request?.fillMissing || receipt.verification.projectId !== receipt.committedTargetId) {
          throw new Error("The receipt does not match this Character image fill.");
        }
        clearDurableMutationIntent(current);
        remember(null);
        return { state: "skipped", skip: receipt.verification.skip };
      }
      if (!receipt.committedTargetId || receipt.verification?.kind !== "creative_run" ||
        receipt.verification.runId !== receipt.committedTargetId) {
        throw new Error("The committed Run receipt is missing exact projection evidence. The workspace remains locked.");
      }
      const request = parseRequest(receipt.verification.requestSnapshot);
      if (!request) {
        throw new Error("The recovered Run receipt does not contain this Character workspace's exact request.");
      }
      remember(updateDurableMutationIntent(current, {
        status: "committed_projection_pending",
        committedTargetId: receipt.committedTargetId,
        requestSnapshot: request,
      }));
      return { state: "committed", runId: receipt.committedTargetId, request, replayed: true, source: "reconciliation" };
    });
  }
  const body = prepared.request;
  if (!body) throw new Error("The generation request does not match this Character workspace.");
  const submit = async (): Promise<SubmissionResult> => {
    let result;
    try {
      result = await adminV2Operation("POST /api/v2/admin/creative/runs", {
        replayIdempotencyKey: prepared.intent.idempotencyKey,
        body,
      });
    } catch (cause) {
      const superseded = await settle((current) => {
        if (["committed_projection_pending", "reconciliation_required"].includes(current.status)) {
          remember(current);
        } else if (prepared.firstSubmission && !current.replayStarted &&
          current.status !== "outcome_unknown" && isDefinitiveRejection(cause)) {
          clearDurableMutationIntent(current);
          remember(null);
        } else if (!prepared.firstSubmission && isDefinitiveRejection(cause)) {
          // A refused replay proves nothing about the earlier attempt, and replaying
          // can never succeed once the request itself stopped being valid. The key
          // stays; only the server's receipt can recover it or seal it as no-effect.
          remember(updateDurableMutationIntent(current, { status: "reconciliation_required" }));
        } else {
          remember(updateDurableMutationIntent(current, { status: "outcome_unknown" }));
        }
        return null;
      });
      if (superseded) return superseded;
      throw cause;
    }
    // Record the receipt before any workspace refresh can fail. From here on,
    // recovery must only read/verify this Run; it must never submit another POST.
    return settle((current): CommittedRun | SkippedRun => {
      if ("skip" in result) {
        if (!body.fillMissing) throw new Error("The Run creation receipt does not match the requested operation.");
        clearDurableMutationIntent(current);
        remember(null);
        return { state: "skipped", skip: result.skip };
      }
      remember(updateDurableMutationIntent(current, {
        status: "committed_projection_pending", committedTargetId: result.batch.id,
      }));
      return { state: "committed", runId: result.batch.id, request: body, replayed: result.replayed, source: "submission" };
    });
  };
  return options.commit ? options.commit(submit) : submit();
}

export async function createOrRecoverMissingCharacterImage(options: {
  readonly scope: string;
  readonly characterId: string;
  readonly purpose: RecoveryPurpose;
  readonly draft: () => object;
  readonly signature?: CreateOptions["signature"];
}) {
  // Keep intent scopes and pre-cutover signatures so existing local journals
  // replay their original payload byte-for-byte, including the absence of fillMissing.
  let intent = readActiveDurableMutationIntent({ scope: options.scope });
  const result = await executeCharacterRunIntent({
    scope: options.scope,
    characterId: options.characterId,
    expectedPurpose: options.purpose,
    intent,
    request: intent ? null : { ...options.draft(), fillMissing: true },
    parseRequest: (snapshot) => {
      const parsed = creativeRunCreateRequestSchema.safeParse(snapshot);
      return parsed.success ? parsed.data : null;
    },
    signature: options.signature ?? ((request) => {
      const base = { ...request };
      delete base.fillMissing;
      return JSON.stringify(base);
    }),
    onIntentChange: (next) => { intent = next; },
  }, true);
  return { result, intent };
}

export const characterImageFillSkipMessage: Readonly<Record<CreativeRunFillSkip["reason"], string>> = {
  slot_filled: "This placement already has an image.",
  candidate_available: "A selectable image already covers this placement.",
  run_pending: "An earlier image Run still covers this placement.",
};

function isDefinitiveRejection(cause: unknown) {
  return cause instanceof AdminV2RequestError && (
    (cause.outcome === "answered" && [400, 401, 403, 404, 409, 422].includes(cause.status)) ||
    (cause.status === 503 && cause.code === "unavailable" && cause.message.includes("No Run was created"))
  );
}

// SPEC: 展示位决定取景，角色自己的视觉方向决定场景与光线。
// INVARIANT: Asset Studio 和批量生成共用这一份，不各写一遍。
export function defaultCharacterImageBrief(
  purpose: "character_cover" | "character_hero" | "character_chat",
  name: string,
  referenceDirection?: unknown,
) {
  const framing = purpose === "character_cover"
    ? `Head-and-shoulders portrait of ${name}, with the face in sharp focus.`
    : purpose === "character_hero"
      ? `Wide, cinematic view of ${name} with a clear silhouette and space around the subject.`
      : `Natural close-up of ${name} making eye contact as if starting a conversation.`;
  const direction = typeof referenceDirection === "string" ? referenceDirection.trim() : "";
  const scene = direction
    ? `Keep the setting, lighting, and mood from the character's visual direction. Adapt the framing for this placement: ${direction}`
    : "Use soft natural light and a clean, unobtrusive background.";
  return `${framing} Show exactly one person. ${scene}`.slice(0, 2_000).trim();
}
