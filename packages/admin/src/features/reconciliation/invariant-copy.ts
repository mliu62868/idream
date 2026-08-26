// SPEC: 前端 SSoT——把数据一致性不变式的 key 翻成运营看得懂的结论 + 下一步。
//       纯前端、不依赖后端返回结构；未收录的 key 走兜底，绝不让一条新不变式在界面上消失。
// INTENT: `GET /api/v2/admin/reconciliation/invariants` 已经算了 31 条检查，实测 17 条违规、
//         `decisionUse: "blocked"` —— 而 admin 前端零引用，运营看不到任何一条。后端给的
//         `description` 是不变式的**正式陈述**（和工程沟通用的同一句话），保留原文放进工程
//         详情；运营首屏要的是"什么坏了、我该做什么"。
// INTENT: 照抄 components/admin/generation/failureReasons.ts 的做法：只登记后端真的会发出的
//         key（取自 packages/main/src/server/modules/admin-v2/reconciliation/invariants.ts），
//         查不到就兜底。编一条不存在的不变式，等于给运营一个永远不会发生的解释。

export type InvariantOwner = "operations" | "engineering";

export type InvariantCopy = {
  /** i18n key —— 一句话说清什么坏了。 */
  title: string;
  /** i18n key —— 下一步该做什么。 */
  hint: string;
  /** 该找谁。运营能自己收口的极少，绝大多数只能带着 sampleIds 转工程。 */
  owner: InvariantOwner;
};

// 复用的下一步文案：绝大多数不变式的动作是同一个，没必要每条各写一句。
const ESCALATE = "Hand the sample IDs to engineering — this is a data-integrity break";
const REPUBLISH = "Re-run the release pipeline for the sampled Characters, then re-check";
const CASE_TRIAGE = "Open the missing Case from the sampled source, then re-check";
const SCHEMA = "A database constraint is missing — needs a migration, not an operator action";

const TABLE: Record<string, InvariantCopy> = {
  // —— 角色项目 / 素材 ——
  character_project_orphan: {
    title: "Character project points at a Character that no longer exists",
    hint: ESCALATE,
    owner: "engineering",
  },
  official_seed_asset_character_mismatch: {
    title: "Official seed image is attached to the wrong Character",
    hint: ESCALATE,
    owner: "engineering",
  },

  // —— 上线与发布链路 ——
  official_public_character_without_current_serving_release: {
    title: "Public Character has no current serving Release",
    hint: REPUBLISH,
    owner: "operations",
  },
  official_public_character_not_live: {
    title: "Public Character has a Release but is not live",
    hint: REPUBLISH,
    owner: "operations",
  },
  live_public_current_release_not_ready: {
    title: "A live Character's current Release is not published and ready",
    hint: REPUBLISH,
    owner: "operations",
  },
  live_serving_legacy_projection_mismatch: {
    title: "Live serving authority disagrees with the runtime projection",
    hint: ESCALATE,
    owner: "engineering",
  },
  serving_validation_stale: {
    title: "A Release is serving without a valid public qualification",
    hint: REPUBLISH,
    owner: "operations",
  },
  // INVARIANT: 这条只能转工程。实测后台**没有任何**重新资质化的写入口——
  //            `POST /characters/route-qualifications/commands/evaluate` 是唯一能写入实测身份
  //            一致性证据的端点（route-qualification.ts:397），而 packages/admin 里零引用；
  //            角色工作台的「Image generation route」工作台（VisualIdentityPanel.tsx:1004）通篇只读，
  //            唯一的按钮是跳到素材页生成一张图。也没有"改用另一条路由"的命令。
  //            我最初把它标成 operations 并写着「去 Profiles & Rollout 重新资质化」——
  //            那是指着一个不存在的按钮，比不给下一步更糟：运营会以为是自己没找到。
  serving_default_route_unqualified: {
    title: "Default generation route no longer satisfies its qualification",
    hint: ESCALATE,
    owner: "engineering",
  },
  editorial_import_authority_mismatch: {
    title: "Editorial import is missing part of its authority chain",
    hint: ESCALATE,
    owner: "engineering",
  },
  editorial_import_route_qualification_misclassified: {
    title: "Editorial import still carries a stale route action",
    hint: ESCALATE,
    owner: "engineering",
  },
  serving_character_pointer_orphan: {
    title: "Serving row points at a Character that no longer exists",
    hint: ESCALATE,
    owner: "engineering",
  },
  serving_release_pointer_orphan: {
    title: "Serving row points at a Release that no longer exists",
    hint: ESCALATE,
    owner: "engineering",
  },
  serving_release_cross_character: {
    title: "Serving row points at another Character's Release",
    hint: ESCALATE,
    owner: "engineering",
  },
  serving_release_revision_content_join_invalid: {
    title: "Serving Release cannot be joined back to its project and content version",
    hint: ESCALATE,
    owner: "engineering",
  },
  current_release_missing_exact_identity_or_reference: {
    title: "Current Release is missing its identity or reference snapshot",
    hint: REPUBLISH,
    owner: "operations",
  },
  scheduled_release_missing_exact_identity_or_reference: {
    title: "Scheduled Release is missing its identity or reference snapshot",
    hint: REPUBLISH,
    owner: "operations",
  },
  current_release_incomplete_manifest: {
    title: "Current Release manifest is incomplete",
    hint: REPUBLISH,
    owner: "operations",
  },
  scheduled_release_incomplete_manifest: {
    title: "Scheduled Release manifest is incomplete",
    hint: REPUBLISH,
    owner: "operations",
  },

  // —— 生成执行与结算 ——
  terminal_attempt_without_unique_terminal_event: {
    title: "A finished attempt has no single matching terminal event",
    hint: ESCALATE,
    owner: "engineering",
  },
  // INVARIANT: 交付计数这两条是 operations 不可能收口的。运营手上唯一沾边的命令是
  //            `jobs/:id/commands/reconcile-unknown`，而它在 unknown-reconciliation.ts:146
  //            硬性要求最新 Attempt 的 status 是 unknown —— 对一个 succeeded / partial 的请求
  //            直接抛 conflict。把它们标成"运营可自行收口"，等于叫人去按一个不存在的按钮。
  succeeded_request_delivery_count_mismatch: {
    title: "A succeeded request delivered the wrong number of outputs",
    hint: ESCALATE,
    owner: "engineering",
  },
  partial_request_delivery_count_mismatch: {
    title: "A partial request's delivery count is out of range",
    hint: ESCALATE,
    owner: "engineering",
  },
  // INVARIANT: 只能转工程。孤儿证据在后台没有入口 —— 案件页按 caseId 取，而那个 Case 不存在；
  //            成因在账号擦除的手写级联漏了 case_evidence/admin_cases（这两张表没有 FK），
  //            属数据模型问题，运营做什么都收不了口。
  case_evidence_without_case: {
    title: "Review evidence lost the Case it was filed under",
    hint: ESCALATE,
    owner: "engineering",
  },
  // 6 小时是队友在后端定的阈值（invariants.ts:731）；这里不复述数字——阈值改了这句不该跟着过期。
  open_request_exceeds_settlement_deadline: {
    title: "A charged request never reached a terminal state",
    hint: "Open it in Generation Jobs and either abort it or reconcile the unknown outcome",
    owner: "operations",
  },
  // INVARIANT: 只能转工程。`generation_attempts."requestId"` 是裸 String，没有外键；
  //            孤儿 Attempt 在后台没有任何入口——作业详情按 requestId 取，而那行 Request 不存在。
  attempt_without_request: {
    title: "An execution record points at a Request that no longer exists",
    hint: ESCALATE,
    owner: "engineering",
  },
  refund_encoded_as_execution_outcome: {
    title: "A refund overwrote the generation's execution outcome",
    hint: ESCALATE,
    owner: "engineering",
  },
  generation_refund_exceeds_captured_spend: {
    title: "Refunded more than was ever captured",
    hint: ESCALATE,
    owner: "engineering",
  },
  generation_settlement_link_mismatch: {
    title: "Settlement links and the coin ledger disagree",
    hint: ESCALATE,
    owner: "engineering",
  },

  // —— 创意批次 ——
  creative_succeeded_without_successful_item: {
    title: "Creative Run reports success with zero successful items",
    hint: "Reopen the sampled Runs in Creative Runs and confirm what actually shipped",
    owner: "operations",
  },
  creative_run_child_projection_mismatch: {
    title: "Creative Run counters disagree with its own items",
    hint: ESCALATE,
    owner: "engineering",
  },

  // —— 工单 / 举报 / 事故 ——
  open_source_without_case: {
    title: "An open report, appeal, or support request has no Case",
    hint: CASE_TRIAGE,
    owner: "operations",
  },
  occurrence_in_multiple_active_incidents: {
    title: "One occurrence belongs to several active Incidents",
    hint: "Merge or close the duplicate Incidents, then re-check",
    owner: "operations",
  },

  // —— 事件投递 ——
  outbox_event_never_dispatched: {
    // INTENT: 标题只说检查确证的事实（到期、pending、attempts=0），不写"没有消费者"。
    //         没人订阅这个 eventType 是最可能的原因，但不是唯一的：dispatcher 没在跑、
    //         worker 崩了、或者 BULLMQ_PREFIX / REDIS_URL 两边对不上（这一条本仓踩过），
    //         症状与"无人订阅"完全相同而消费者其实存在。把猜测写进标题，运营就会去找一个
    //         明明存在的订阅方，然后得出"检查报错了"的结论。
    title: "Outbox events are due but were never dispatched",
    hint: ESCALATE,
    owner: "engineering",
  },

  // —— 数据库层保障 ——
  active_identity_constraint_missing: {
    title: "Case/Incident lifecycle is no longer enforced by the database",
    hint: SCHEMA,
    owner: "engineering",
  },
  projection_dedupe_constraint_missing: {
    title: "Projector dedupe is no longer enforced by the database",
    hint: SCHEMA,
    owner: "engineering",
  },
  payload_hash_conflict_not_quarantined: {
    title: "A conflicting payload was reused instead of quarantined",
    hint: ESCALATE,
    owner: "engineering",
  },
};

const FALLBACK: InvariantCopy = {
  // INVARIANT: 兜底不猜结论。新增的不变式在这里出现，说明字典该补了；在那之前运营看到的
  //            仍是后端那句正式陈述（调用点会把 description 显示在标题下面），不会开天窗。
  title: "Data-integrity check failed",
  hint: ESCALATE,
  owner: "engineering",
};

export function invariantCopy(key: string): InvariantCopy {
  return TABLE[key] ?? FALLBACK;
}

/** 字典是否已经收录这条不变式 —— 调用点据此决定要不要把后端原文提到首屏。 */
export function hasInvariantCopy(key: string) {
  return key in TABLE;
}

/**
 * 按「该找谁」分组统计，用来一眼看出这批违规是运营能收口的还是必须转工程的。
 * INVARIANT: 只数 failed。`unavailable` 是"没查成"，不是一条违规 —— 把它算进 engineering，
 *            结论条那行「N 条你能自己收口 · M 条需要工程 · K 条没能检查」就会把 K 数两遍。
 */
export function invariantOwnerBreakdown(
  checks: readonly { readonly key: string; readonly status: string }[],
) {
  let operations = 0;
  let engineering = 0;
  for (const check of checks) {
    if (check.status !== "failed") continue;
    if (invariantCopy(check.key).owner === "operations") operations += 1;
    else engineering += 1;
  }
  return { operations, engineering };
}
