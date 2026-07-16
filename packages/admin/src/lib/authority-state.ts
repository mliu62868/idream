export type AuthorityState<T> = {
  data: T | null;
  dataKey: string | null;
  loading: boolean;
  error: string | null;
  refreshedAt: string | null;
};

export function createAuthorityState<T>(): AuthorityState<T> {
  return {
    data: null,
    dataKey: null,
    loading: true,
    error: null,
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
    refreshedAt,
  };
}

export function authorityRequestFailed<T>(
  current: AuthorityState<T>,
  queryKey: string,
  error: string,
): AuthorityState<T> {
  const sameQuery = current.dataKey === queryKey;
  return {
    data: sameQuery ? current.data : null,
    dataKey: sameQuery ? current.dataKey : null,
    loading: false,
    error,
    refreshedAt: sameQuery ? current.refreshedAt : null,
  };
}
