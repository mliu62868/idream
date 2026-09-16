import type { GenerationRouteStaleReason } from "@idream/shared/admin";

// SPEC: 把权威算出来的失效原因翻成运营能执行的下一步，并诚实标出谁能收口。
// INTENT: 这一格此前写死一句「重新资质化需要工程介入」。权威其实算了 11 种原因并写进
//   `release_monitors.observed.reason`，其中六种运营自己就能收口——最典型的是
//   `generation_profile_unavailable`（有人在 Profiles & Rollout 点了 Disable）。
//   把它们一律推给工程，等于让一次本可以自己修的下架在队列里烂掉。
// INVARIANT: 恢复手段是「发一个新的 Release」，不是「把 profile 重新启用」——
//   非草稿 profile 的 PATCH 只接受 `enabled:false`（model-profiles.ts:305-314），
//   被禁用的版本永远回不来。发新 Release 时 findOperationalGenerationRoute 会
//   重新绑定当下合格的线路（release-lifecycle.ts:177），这才是真能走通的那条路。
// INVARIANT: 键集由 GenerationRouteStaleReason 穷举，权威新增一个原因这里就编译不过。

/** 原因各不相同，收口动作只有两种，所以分成「是什么」和「怎么办」两句。 */
const REPUBLISH =
  "Publish a new Release for this Character: it re-pins to the generation route that is qualified today. Re-enabling the old profile version is not possible.";
const ESCALATE =
  "This judgement lives in code, so it needs engineering; the raw reason above is what to hand over.";

export const ROUTE_STALE_REASON_COPY: Record<
  GenerationRouteStaleReason,
  {
    readonly cause: string;
    readonly recovery: string;
    readonly owner: "operations" | "engineering";
  }
> = {
  missing_qualification: {
    cause: "This Release is pinned to a generation route that no longer has a qualification record.",
    recovery: REPUBLISH,
    owner: "operations",
  },
  qualification_expired: {
    cause: "The qualification behind this route has passed its expiry.",
    recovery: REPUBLISH,
    owner: "operations",
  },
  policy_version_changed: {
    cause: "The Character Release policy moved on, so this route's qualification no longer counts.",
    recovery: REPUBLISH,
    owner: "operations",
  },
  evaluator_version_changed: {
    cause: "The identity evaluator moved on, so this route's evidence no longer counts.",
    recovery: REPUBLISH,
    owner: "operations",
  },
  generation_profile_unavailable: {
    cause: "The generation profile behind this route is disabled, archived, or rolled out to nobody — check it under Profiles & Rollout.",
    recovery: REPUBLISH,
    owner: "operations",
  },
  generation_profile_workflow_changed: {
    cause: "The profile now runs a different workflow than the one this route was qualified on.",
    recovery: REPUBLISH,
    owner: "operations",
  },
  qualification_threshold_failed: {
    cause: "The route's measured identity match is below the bar, and re-evaluating a route has no console entry.",
    recovery: ESCALATE,
    owner: "engineering",
  },
  generation_workflow_unavailable: {
    cause: "The workflow this route was qualified on is gone, or is running a different version.",
    recovery: ESCALATE,
    owner: "engineering",
  },
  generation_route_reference_role_unsupported: {
    cause: "The reference roles this Release needs are not accepted by the current workflow.",
    recovery: ESCALATE,
    owner: "engineering",
  },
  generation_route_reference_capacity_insufficient: {
    cause: "The current workflow cannot take as many identity references as this Release carries.",
    recovery: ESCALATE,
    owner: "engineering",
  },
  generation_route_reference_slot_assignment_unsupported: {
    cause: "The current workflow has no slot arrangement for this Release's references.",
    recovery: ESCALATE,
    owner: "engineering",
  },
};

// SPEC: 认不出来的原因不编下一步，只说「照上面那行原文转工程」。
// INTENT: 原样退回权威自己的措辞，比编一个听起来合理的动作诚实——运营读到的是真话，
//   工程读到的是可搜索的原码。
export function routeStaleReasonCopy(reason: unknown) {
  return typeof reason === "string" && reason in ROUTE_STALE_REASON_COPY
    ? ROUTE_STALE_REASON_COPY[reason as GenerationRouteStaleReason]
    : {
        cause: "This route no longer meets its qualification.",
        recovery: ESCALATE,
        owner: "engineering" as const,
      };
}
