export type AuthorityState<T> = {
  data: T | null;
  dataKey: string | null;
  loading: boolean;
  error: string | null;
  /** SPEC: 原始异常，给 ui/request-error-copy 按错误码挑运营文案用。
   * INTENT: `error` 只是 message 字符串，code / status / requestId 到这一层就没了，
   *         横幅只能把英文原文糊出去。可选参数，旧调用点不传就退回原来的行为。 */
  cause?: unknown;
  refreshedAt: string | null;
};

export function createAuthorityState<T>(): AuthorityState<T> {
  return {
    data: null,
    dataKey: null,
    loading: true,
    error: null,
    cause: undefined,
    refreshedAt: null,
  };
}

export function authorityRequestStarted<T>(
  current: AuthorityState<T>,
  queryKey: string,
): AuthorityState<T> {
  const sameQuery = current.dataKey === queryKey;
  return {
    data: sameQuery ? current.data : null,
    dataKey: sameQuery ? current.dataKey : null,
    loading: true,
    error: null,
    cause: undefined,
    refreshedAt: sameQuery ? current.refreshedAt : null,
  };
}

export function authorityRequestSucceeded<T>(
  queryKey: string,
  data: T,
  refreshedAt = new Date().toISOString(),
): AuthorityState<T> {
  return {
    data,
    dataKey: queryKey,
    loading: false,
    error: null,
    cause: undefined,
    refreshedAt,
  };
}

export function authorityRequestFailed<T>(
  current: AuthorityState<T>,
  queryKey: string,
  error: string,
  cause?: unknown,
): AuthorityState<T> {
  const sameQuery = current.dataKey === queryKey;
  return {
    data: sameQuery ? current.data : null,
    dataKey: sameQuery ? current.dataKey : null,
    loading: false,
    error,
    cause,
    refreshedAt: sameQuery ? current.refreshedAt : null,
  };
}
