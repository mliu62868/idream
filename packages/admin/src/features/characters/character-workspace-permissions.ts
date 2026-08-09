import type { AdminPermissionKey } from "@idream/shared/admin";
import { adminV2OperationAllowed } from "@/lib/admin-v2-operation";

/**
 * SPEC: 角色运营台每一个受写入门控的能力 → 它需要的 effective permission key。
 * INTENT: shell 曾经在 nav 的 render 里手拼这 11 个键传下来，那层拼装没有任何编译期约束；
 *         下游又把其中 8 个逐条与 `!writesLocked` 相与，漏掉的 manageVoiceDefaults 让「保存
 *         系统语音默认」在 durable command 待决期间仍然可点 —— 运营点下去得到的是一个抛出的
 *         错误而不是禁用态。键集和写入锁各自只剩一处，这一类漏项不再可表达。
 */
export const CHARACTER_WORKSPACE_WRITES = {
  writeProject: "character.project.write",
  proposeRelease: "character.release.propose",
  publishRelease: "character.release.publish",
  reviewRelease: "character.release.review",
  writeVisual: "content.official.write",
  evaluateRoute: "content.production.write",
  createAssets: "creative.run.write",
  reviewAssets: "creative.run.review",
  manageVoiceDefaults: "generation.config.write",
} as const satisfies Record<string, AdminPermissionKey>;

type CharacterWorkspaceWrite = keyof typeof CHARACTER_WORKSPACE_WRITES;

export type CharacterWorkspacePermissions =
  & { readonly read: boolean; readonly readAssets: boolean }
  & { readonly [Capability in CharacterWorkspaceWrite]: boolean };

export function characterWorkspacePermissions(
  granted: ReadonlySet<AdminPermissionKey>,
  writesLocked: boolean,
): CharacterWorkspacePermissions {
  const writes = Object.fromEntries(
    Object.entries(CHARACTER_WORKSPACE_WRITES).map(([capability, permission]) => [
      capability,
      granted.has(permission) && !writesLocked,
    ]),
  ) as { [Capability in CharacterWorkspaceWrite]: boolean };
  return {
    read: adminV2OperationAllowed("GET /api/v2/admin/characters/:id", granted),
    readAssets: granted.has("creative.run.read"),
    ...writes,
  };
}

/**
 * SPEC: 面板发起一次写入的唯一通道 —— 提交、等权威投影刷新、拿回「刷没刷上」。
 * INTENT: 写入锁与命令日志归 shell 的 journal 管，面板只表达业务动作，因此这个签名是
 *         面板与 shell 之间的契约，不属于任何单个面板。
 */
export type RunCommittedCharacterMutation = <T>(input: {
  readonly action: string;
  readonly commit: () => Promise<T>;
  readonly afterRefresh?: () => void;
}) => Promise<{ readonly result: T; readonly refreshed: boolean }>;
