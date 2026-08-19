export type CustomerQuery = {
  search: string;
  status: string;
  cursor?: string;
};

export type CustomerWorkspaceUrlState = {
  query: CustomerQuery;
  selectedId: string | null;
};

export const defaultCustomerQuery: CustomerQuery = { search: "", status: "" };

/** 页大小是请求参数与分页条读数共用的同一个数，只允许有一份。 */
export const CUSTOMER_PAGE_SIZE = 30;

export function buildCustomerWorkspaceParams(state: CustomerWorkspaceUrlState) {
  const params = new URLSearchParams();
  append(params, "search", state.query.search);
  append(params, "status", state.query.status);
  append(params, "cursor", state.query.cursor);
  append(params, "customer", state.selectedId ?? undefined);
  return params;
}

export function customerWorkspacePath(selectedId: string | null) {
  return selectedId ? `/admin/customers/${encodeURIComponent(selectedId)}` : "/admin/customers";
}

export function parseCustomerWorkspaceParams(params: URLSearchParams): CustomerWorkspaceUrlState {
  return {
    query: {
      search: params.get("search") ?? "",
      status: params.get("status") ?? "",
      cursor: normalized(params.get("cursor")),
    },
    selectedId: normalized(params.get("customer")) ?? null,
  };
}

function append(params: URLSearchParams, key: string, value: string | undefined) {
  const next = value?.trim();
  if (next) params.set(key, next);
}

function normalized(value: string | null) {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
