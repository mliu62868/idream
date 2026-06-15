export type AppErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "payment_required"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "internal";

const statusByCode: Record<AppErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  payment_required: 402,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: AppErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = statusByCode[code];
    this.details = details;
  }
}

export const Errors = {
  badRequest(message = "Bad request", details?: unknown) {
    return new AppError("bad_request", message, details);
  },
  unauthorized(message = "Unauthorized", details?: unknown) {
    return new AppError("unauthorized", message, details);
  },
  forbidden(message = "Forbidden", details?: unknown) {
    return new AppError("forbidden", message, details);
  },
  paymentRequired(message = "Payment required", details?: unknown) {
    return new AppError("payment_required", message, details);
  },
  notFound(message = "Not found", details?: unknown) {
    return new AppError("not_found", message, details);
  },
  conflict(message = "Conflict", details?: unknown) {
    return new AppError("conflict", message, details);
  },
  rateLimited(message = "Rate limited", details?: unknown) {
    return new AppError("rate_limited", message, details);
  },
  internal(message = "Internal error", details?: unknown) {
    return new AppError("internal", message, details);
  },
};
