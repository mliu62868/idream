// SPEC: 生成报价握手（quote -> submit）的唯一权威实现。
//
// 公开 HTTP 契约分两步，客户端必须按顺序走：
//   1. POST generation/quote（或 media/:id/variation/quote、generation/jobs/:id/retry/quote）
//      → 服务端解析一次「生成计划」，算出两个指纹，返回一份报价；
//   2. POST generation/jobs（或对应的提交端点），带上从报价里投影出来的
//      六字段 quoteAuthority；服务端**重新**解析计划、**重新**算两个指纹，
//      与提交携带的六个字段逐一比对，任一不等即拒绝。
//
// INTENT: 防的是「报价之后、下单之前，定价或角色档案被改了」——用户看到的价格
// 与路线，必须就是真正执行并扣款的那一条。这里不做"就近价"、不做四舍五入、
// 不做降级：只有完全一致才放行。
//
// 为什么单独成模块：这条协议原本没有任何 interface 声明它的存在，唯一可执行的
// 表达在测试脚手架里（test/helpers.ts 自动补 quote 的补偿逻辑）。要读懂它得在
// 一个 12k 行的 service.ts 里靠行号来回跳 5 处。收进来之后，`quoteGeneration`
// 与 `assertQuoteStillValid` 就是这条协议的具名入口。
//
// 为什么还从 ./service 反向 import：计划解析依赖 service.ts 里的目录查询与路线
// 选择（selectGenerationProfile 一族，连同其传递依赖近 700 行，且在 service.ts
// 内另有多个调用者）。mega-module 形态是 docs/architecture/01、05 明文记录的
// 有意决策，把那一族一并拆出去等于重开已定决策。因此这里只收口「报价协议」，
// 计划所需的目录查询仍留在 service.ts —— 形成一个与仓库既有形态一致的循环
// import（service.ts <-> admin/characters/templates.ts 早已如此）。本模块只在
// 函数体内引用 service.ts 的符号，模块求值期不触碰，ESM 下安全。
import { createHash } from "node:crypto";
import { z } from "zod";
import { Errors } from "@/server/lib/errors";
import {
  generationCostFromAuthority,
  resolveGenerationPricingAuthority,
  type GenerationPricingAuthority,
} from "@/server/lib/generation-pricing";
import { dreamcoinBalance } from "@/server/modules/billing/ledger";
import {
  assertGenerationProfileCanDispatchReferences,
  entitlementMap,
  featureFlagEnabled,
  generationCharacter,
  generationReferenceRouteRequirements,
  isTrustedGenerationPromptSource,
  publishedGenerationVideoCharacter,
  resolveGenerationLook,
  resolveGenerationVisualProfile,
  selectGenerationProfile,
  selectRecipe,
  type GenerationCreateBody,
  type GenerationSource,
} from "./service";
import { generationWorkflowDescriptor } from "@/server/modules/generation/generation-catalog";

// SPEC: 报价令牌 —— 客户端从报价里投影出来、提交时原样回传的六个字段。
// INVARIANT: 六个字段**全部**参与比对，缺一不可，各自钉住一件事：
//   - profileId / profileVersion：执行这次生成的模型档案身份 + 版本。
//     运营改档案（换 workflow、改 maxCount）会 bump version，旧报价立即失效。
//   - routeFingerprint：整条执行路线的内容哈希，覆盖档案之外的一切可变输入
//     （workflow 版本、recipe 版本、visual profile 版本、参考图集合、look…）。
//     单看 profileVersion 抓不到这些。
//   - pricingFingerprint：计价规则的内容哈希。规则换代（改 baseCost、切
//     effectiveFrom）后旧报价必须失效，否则会按用户看到的旧价扣款。
//   - outputCount：张数是价格的自变量，必须与报价时选定的那一档一致，
//     否则用户按 1 张的价下 4 张的单。
//   - costDreamcoins：最终扣款额。前三个指纹都相等时它本应自然相等，
//     保留它是最后一道对账闸门 —— 计价公式若被改成同规则不同算法，
//     指纹不变而金额会变，只有这一项能抓住。
export const generationQuoteAuthoritySchema = z
  .object({
    profileId: z.string().trim().min(1).max(180),
    profileVersion: z.number().int().positive(),
    routeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    pricingFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    outputCount: z.number().int().min(1).max(8),
    costDreamcoins: z.number().int().nonnegative(),
  })
  .strict();

export type GenerationQuoteAuthority = z.infer<
  typeof generationQuoteAuthoritySchema
>;

export type GenerationProfileSelectionAuthority =
  | "public_generator"
  | "public_image_edit"
  | "specialized";

export type GenerationPlan = Awaited<ReturnType<typeof resolveGenerationPlan>>;

// SPEC: 把一次生成请求解析成一条可执行的「计划」：权益校验 + 目录查询
// （recipe / character / visual profile / look / 参考图 / 模型档案 / workflow）。
// INVARIANT: 报价与提交必须调用同一个解析器、同一组参数，否则两次算出的
// routeFingerprint 不可比 —— 那会把 fail-closed 退化成"永远拒绝"。
export async function resolveGenerationPlan(
  userId: string,
  body: GenerationCreateBody,
  options: {
    source?: GenerationSource;
    fallbackToActiveOnStaleVisualProfile?: boolean;
    profileSelectionAuthority?: GenerationProfileSelectionAuthority;
    bootstrapVisualProfile?: boolean;
  } = {},
) {
  const entitlements = await entitlementMap(userId);
  const selectedModel = body.model ?? body.controls.model;
  if (body.mode === "video" && !entitlements.video_generation) {
    throw Errors.paymentRequired("Video generation requires Deluxe entitlement");
  }
  if (body.mode === "video" && !(await featureFlagEnabled("video_gen"))) {
    throw Errors.forbidden("Video generation is disabled");
  }
  const systemPromptSource = isTrustedGenerationPromptSource(
    options.source?.sourceType,
  );
  const freeCharacterMoment =
    body.mode === "image" && Boolean(body.characterId) && Boolean(body.prompt);
  if (
    (body.negativePrompt || (body.prompt && !freeCharacterMoment)) &&
    !systemPromptSource &&
    !entitlements.premium_controls
  ) {
    throw Errors.paymentRequired("Custom prompt controls require Premium");
  }
  const recipe = await selectRecipe(
    body.mode,
    body.characterId ? "character" : "freeplay",
  );
  const character = body.characterId
    ? body.mode === "video"
      ? await publishedGenerationVideoCharacter(body.characterId)
      : await generationCharacter(body.characterId, userId)
    : null;
  const consistencyMode = body.consistencyMode ?? "balanced";
  const visualProfile =
    body.mode === "image" && character
      ? await resolveGenerationVisualProfile(character, body.visualProfileId, {
          fallbackToActiveOnStale:
            options.fallbackToActiveOnStaleVisualProfile,
          bootstrapIfMissing: options.bootstrapVisualProfile !== false,
        })
      : null;
  const selectedLook = await resolveGenerationLook(
    userId,
    character?.id ?? null,
    visualProfile?.id ?? null,
    body.controls.lookId,
  );
  const requestedLookReferenceAssetId =
    selectedLook?.referenceAssetId ?? null;
  const explicitSourceImageAssetId = (
    body.controls as Record<string, unknown>
  ).sourceImageAssetId;
  const requestedSourceImageAssetId =
    typeof explicitSourceImageAssetId === "string"
      ? explicitSourceImageAssetId
      : body.mode === "video"
        ? character?.imageAssetId ?? null
        : null;
  const referenceRequirements =
    body.mode === "image" && character && visualProfile
      ? await generationReferenceRouteRequirements(visualProfile.id)
      : [];
  const hasRequestedSourceImage =
    typeof requestedSourceImageAssetId === "string";
  if (body.mode === "video" && !hasRequestedSourceImage) {
    throw Errors.conflict(
      "Image-to-video generation requires a Character with an available primary image",
      { characterId: character?.id ?? null },
    );
  }
  const requiresReferenceRouting =
    (
      body.mode === "image" &&
      (
        referenceRequirements.length > 0 ||
        hasRequestedSourceImage ||
        requestedLookReferenceAssetId !== null
      )
    ) ||
    (body.mode === "video" && hasRequestedSourceImage);
  const requirePublicTextToImageProfile =
    body.mode === "image" &&
    (
      !requiresReferenceRouting ||
      (
        options.profileSelectionAuthority === "public_generator" &&
        Boolean(selectedModel)
      )
    );
  const requirePublicImageEditProfile =
    body.mode === "image" &&
    options.profileSelectionAuthority === "public_image_edit" &&
    Boolean(selectedModel);
  const profile = requiresReferenceRouting
    ? await selectGenerationProfile(
        body.mode,
        selectedModel,
        {
          pinnedReferences: referenceRequirements,
          sourceImageAssetId: hasRequestedSourceImage
            ? requestedSourceImageAssetId
            : null,
          lookReferenceAssetId: requestedLookReferenceAssetId,
        },
        requirePublicTextToImageProfile,
        entitlements,
        requirePublicImageEditProfile,
      )
    : body.mode === "image"
      ? await selectGenerationProfile(
          body.mode,
          selectedModel,
          {
            pinnedReferences: [],
            sourceImageAssetId: null,
            lookReferenceAssetId: null,
          },
          requirePublicTextToImageProfile,
          entitlements,
          requirePublicImageEditProfile,
        )
      : await selectGenerationProfile(
          body.mode,
          selectedModel,
          undefined,
          false,
          entitlements,
        );
  if (
    profile.requiredEntitlement &&
    !entitlements[profile.requiredEntitlement]
  ) {
    throw Errors.paymentRequired("Selected model requires entitlement", {
      entitlement: profile.requiredEntitlement,
    });
  }

  const workflowDescriptor = await generationWorkflowDescriptor(
    profile.workflowKey ?? profile.pipelineModel,
  );
  if (
    hasRequestedSourceImage &&
    referenceRequirements.length === 0
  ) {
    assertGenerationProfileCanDispatchReferences({
      profile,
      workflowDescriptor,
      pinnedReferences: [],
      sourceImageAssetId: requestedSourceImageAssetId,
      lookReferenceAssetId: requestedLookReferenceAssetId,
    });
  }

  return {
    character,
    consistencyMode,
    entitlements,
    hasRequestedSourceImage,
    profile,
    recipe,
    referenceRequirements,
    requestedLookReferenceAssetId,
    requestedSourceImageAssetId,
    selectedLook,
    selectedModel,
    visualProfile,
    workflowDescriptor,
  };
}

// SPEC: 整条执行路线的内容哈希。覆盖的输入：
//   mode / 模型档案(profileKey, version, workflowKey) / workflow(version, identity)
//   / recipe(recipeKey, version) / character id / visual profile(id, version)
//   / 参考图需求集合 / 源图 assetId / look(id, updatedAt, referenceAssetId)
//   / 允许的画幅 / maxCount / costMultiplier
//
// INVARIANT: **look.updatedAt 进了指纹** —— 后台或用户改一次 Look（哪怕只动了
// 与出图无关的字段），该 Look 上所有在途报价立即失效，客户端必须重新报价。
// 这是有意的：Look 的 appearanceDelta 与 referenceAsset 直接参与出图，
// 版本号又不存在，updatedAt 是唯一能钉住"用户当时看到的那个 Look"的东西。
// 代价是改 Look 会打断在途下单；收益是绝不会拿新 Look 去执行旧报价。
//
// INVARIANT: schemaVersion 一旦要改语义就必须改字符串 —— 新旧不可比，
// 让所有在途报价一次性失效，好过两边算出巧合相同的哈希。
export function generationPlanRouteFingerprint(plan: GenerationPlan) {
  return createHash("sha256")
    .update(JSON.stringify({
      schemaVersion: "generation-plan-v1",
      mode: plan.profile.mode,
      profileId: plan.profile.profileKey,
      profileVersion: plan.profile.version,
      workflowKey:
        plan.profile.workflowKey ?? plan.profile.pipelineModel,
      workflowVersion:
        plan.workflowDescriptor?.version ?? null,
      workflowIdentity:
        plan.workflowDescriptor?.identity ?? null,
      recipeId: plan.recipe.recipeKey,
      recipeVersion: plan.recipe.version,
      characterId: plan.character?.id ?? null,
      visualProfileId: plan.visualProfile?.id ?? null,
      visualProfileVersion: plan.visualProfile?.version ?? null,
      referenceRequirements: plan.referenceRequirements,
      sourceImageAssetId:
        typeof plan.requestedSourceImageAssetId === "string"
          ? plan.requestedSourceImageAssetId
          : null,
      lookId: plan.selectedLook?.id ?? null,
      lookUpdatedAt: plan.selectedLook?.updatedAt.toISOString() ?? null,
      lookReferenceAssetId:
        plan.selectedLook?.referenceAssetId ?? null,
      allowedOrientations: jsonStringArray(
        plan.profile.allowedOrientations,
      ),
      maxCount: plan.profile.maxCount,
      costMultiplier: plan.profile.costMultiplier,
    }))
    .digest("hex");
}

// SPEC: 计价规则的内容哈希。覆盖规则身份、版本、baseCost 与生效时间。
// INVARIANT: 含 updatedAt —— 就地改一条 active 规则（不 bump version）
// 同样让在途报价失效，否则会按用户看到的旧价扣款。
export function generationPricingFingerprint(
  authority: GenerationPricingAuthority,
) {
  return createHash("sha256")
    .update(JSON.stringify({
      schemaVersion: "generation-pricing-v1",
      id: authority.id,
      ruleKey: authority.ruleKey,
      version: authority.version,
      baseCost: authority.baseCost,
      effectiveFrom: authority.effectiveFrom?.toISOString() ?? null,
      updatedAt: authority.updatedAt.toISOString(),
    }))
    .digest("hex");
}

export interface GenerationQuotePayload {
  readonly mode: "image" | "video";
  readonly profileId: string;
  readonly profileVersion: number;
  readonly routeFingerprint: string;
  readonly pricing: {
    readonly ruleId: string;
    readonly ruleKey: string;
    readonly version: number;
    readonly effectiveFrom: string | null;
    readonly fingerprint: string;
  };
  readonly orientations: string[];
  readonly defaultOrientation: string;
  readonly maxCount: number;
  readonly costs: { readonly outputCount: number; readonly costDreamcoins: number }[];
  readonly balance: number;
}

// SPEC: 握手的第一步 —— 解析计划、算两个指纹、给出各张数档位的价格与余额。
// 报价本身不落库、不预留额度：它是一份带指纹的快照，权威性由第二步的
// `assertQuoteStillValid` 重算兑现。
// INVARIANT: 返回的 plan / pricingAuthority 与 quote 中的指纹同源同刻，
// 调用方不得用别处解析出的 plan 去配这份 quote。
export async function quoteGeneration(input: {
  readonly userId: string;
  readonly body: GenerationCreateBody;
  readonly profileSelectionAuthority: GenerationProfileSelectionAuthority;
  readonly source?: GenerationSource;
}): Promise<{
  readonly plan: GenerationPlan;
  readonly pricingAuthority: GenerationPricingAuthority;
  readonly routeFingerprint: string;
  readonly pricingFingerprint: string;
  readonly quote: GenerationQuotePayload;
}> {
  const plan = await resolveGenerationPlan(input.userId, input.body, {
    source: input.source,
    profileSelectionAuthority: input.profileSelectionAuthority,
    // 报价绝不产生副作用：不给遗留 Character 补建 visual profile。
    bootstrapVisualProfile: false,
  });
  const routeFingerprint = generationPlanRouteFingerprint(plan);
  const pricingAuthority = await resolveGenerationPricingAuthority(
    input.body.mode,
  );
  const pricingFingerprint = generationPricingFingerprint(pricingAuthority);
  const costs = Array.from(
    { length: plan.profile.maxCount },
    (_, index) => {
      const outputCount = index + 1;
      return {
        outputCount,
        costDreamcoins: generationCostFromAuthority(
          pricingAuthority,
          outputCount,
          plan.profile.costMultiplier,
        ),
      };
    },
  );
  const balance = await dreamcoinBalance(input.userId);
  const orientations = jsonStringArray(plan.profile.allowedOrientations);
  const defaultOrientation = orientations[0];
  if (!defaultOrientation) {
    throw Errors.unavailable(
      "No executable orientation is configured for this generation route",
    );
  }

  return {
    plan,
    pricingAuthority,
    routeFingerprint,
    pricingFingerprint,
    quote: {
      mode: input.body.mode,
      profileId: plan.profile.profileKey,
      profileVersion: plan.profile.version,
      routeFingerprint,
      pricing: {
        ruleId: pricingAuthority.id,
        ruleKey: pricingAuthority.ruleKey,
        version: pricingAuthority.version,
        effectiveFrom:
          pricingAuthority.effectiveFrom?.toISOString() ?? null,
        fingerprint: pricingFingerprint,
      },
      orientations,
      defaultOrientation,
      maxCount: plan.profile.maxCount,
      costs,
      balance,
    },
  };
}

/** 提交端重算出来的、要与客户端回传的六字段逐一比对的当前事实。 */
export interface GenerationQuoteFacts {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly routeFingerprint: string;
  readonly pricingFingerprint: string;
  readonly outputCount: number;
  readonly costDreamcoins: number;
}

// SPEC: 握手的第二步 —— 提交前用重算出来的事实校验客户端回传的报价令牌。
// INVARIANT: fail closed。任一字段不等即 409 抛出，绝不降级：不按新价放行、
// 不按旧价放行、不四舍五入、不"就近选一个档位"。客户端唯一的出路是重新报价。
// 错误 details 同时回带 quoted 与 current，好让客户端一眼看出是路线变了
// 还是价格变了。
// INVARIANT: 令牌缺失不由本函数处理 —— 公开写入路径在调用本函数之前就必须
// 因为"没有报价"而拒绝，否则未带令牌的请求会静默绕过整条协议。
export function assertQuoteStillValid(
  submitted: GenerationQuoteAuthority,
  current: GenerationQuoteFacts,
  kind: "submit" | "retry" = "submit",
): void {
  if (
    submitted.profileId === current.profileId &&
    submitted.profileVersion === current.profileVersion &&
    submitted.routeFingerprint === current.routeFingerprint &&
    submitted.pricingFingerprint === current.pricingFingerprint &&
    submitted.outputCount === current.outputCount &&
    submitted.costDreamcoins === current.costDreamcoins
  ) {
    return;
  }
  throw Errors.conflict(
    kind === "retry"
      ? "Generation retry quote changed. Refresh the exact quote before retrying."
      : "Generation quote changed. Refresh the exact quote before submitting.",
    {
      quoted: submitted,
      current: {
        profileId: current.profileId,
        profileVersion: current.profileVersion,
        routeFingerprint: current.routeFingerprint,
        pricingFingerprint: current.pricingFingerprint,
        outputCount: current.outputCount,
        costDreamcoins: current.costDreamcoins,
      },
    },
  );
}

// SPEC: 握手的客户端半边 —— 把一份报价投影成提交要回传的六字段令牌。
// INTENT: `assertQuoteStillValid` 只校验不构造，只有一半协议；把构造也具名，
// 才能保证两端对"哪六个字段、从报价的哪里取"有同一份定义。
// INVARIANT: 两种报价形状都要吃 —— 提交类报价带 `costs` 张数阶梯（用户可选
// 1..maxCount），重试类报价没有阶梯、只带一个钉死的 `costDreamcoins`
// （重试不许改张数）。取不到对应档位即 null，调用方必须重新报价而不是猜价。
// NOTE: 浏览器端另有一份同形状投影（src/lib/generation-write-client.ts
// 的 exactGenerationQuoteForCount）—— 那是客户端 bundle，不共享服务端模块。
export function quoteAuthorityFor(
  quote: {
    readonly profileId: string;
    readonly profileVersion: number;
    readonly routeFingerprint: string;
    readonly pricing: { readonly fingerprint: string };
    readonly costs?: readonly {
      readonly outputCount: number;
      readonly costDreamcoins: number;
    }[];
    readonly costDreamcoins?: number;
  },
  outputCount: number,
): GenerationQuoteAuthority | null {
  const costDreamcoins =
    typeof quote.costDreamcoins === "number"
      ? quote.costDreamcoins
      : quote.costs?.find((cost) => cost.outputCount === outputCount)
          ?.costDreamcoins;
  if (typeof costDreamcoins !== "number") return null;
  return {
    profileId: quote.profileId,
    profileVersion: quote.profileVersion,
    routeFingerprint: quote.routeFingerprint,
    pricingFingerprint: quote.pricing.fingerprint,
    outputCount,
    costDreamcoins,
  };
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
