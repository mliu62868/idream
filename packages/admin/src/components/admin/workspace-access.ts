import {
  ADMIN_V2_API_OPERATIONS_BY_ID,
  type AdminV2DeclaredOperationId,
} from "@idream/shared/admin";
import type { AdminPermissionKey } from "@idream/shared/admin/permissions";

// SPEC: 一个入口的读权限，由它首屏必需请求的 operation 在 API manifest 里声明的权限推导出来。
// INTENT: 入口权限过去是手抄的权限键，和页面真正调用的接口各自演化 —— 实测漂移出三处
//         「菜单看得见、点进去整页 403」：Profile Diagnostics 挂在 analytics.metric.read 下却调
//         generation/model-profiles；后端诊断与生成健康写 ops.queue.read 却调 generation/*。
//         把手写的权限键换成 operation id，权限就只有 manifest 一个来源，改接口即改入口。
// INVARIANT: 只有 manifest 能确定回答"这个请求必须持有哪些权限"的授权形态才计入：
//            - all_of：整组都是必需的。
//            - all_of_and_one_of_by_resource：只有 always 是必需的，oneOf 取决于目标资源。
//            - one_of_by_resource：一个都不是无条件必需的，计入空集。
//            - bootstrap：不要求权限，计入空集。
export function operationRequiredPermissions(
  operationId: AdminV2DeclaredOperationId,
): readonly AdminPermissionKey[] {
  const operation = ADMIN_V2_API_OPERATIONS_BY_ID[operationId];
  const authorization = operation.authorization;
  if (authorization.kind === "all_of") return authorization.permissions;
  if (authorization.kind === "all_of_and_one_of_by_resource") return authorization.always;
  return [];
}

/** 首屏必需 operation 的权限并集，按首次出现顺序去重。 */
export function firstScreenPermissions(
  operationIds: readonly AdminV2DeclaredOperationId[],
): readonly AdminPermissionKey[] {
  const required: AdminPermissionKey[] = [];
  for (const operationId of operationIds) {
    for (const permission of operationRequiredPermissions(operationId)) {
      if (!required.includes(permission)) required.push(permission);
    }
  }
  return required;
}
