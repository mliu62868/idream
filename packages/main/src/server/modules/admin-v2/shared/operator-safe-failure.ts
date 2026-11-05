import { AppError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";

/**
 * SPEC: The message a durable failure record may carry to an operator.
 * INTENT: command and outbox rows are read back through Admin APIs, so whatever is persisted is
 * effectively published. An AppError's message was written for that reader. Any other exception
 * text was not: a Prisma error quotes the query, the columns, and sometimes the values.
 * INVARIANT: the original is logged here before it is discarded, so diagnosis moves to server logs
 * rather than disappearing.
 */
export function operatorSafeFailureMessage(
  error: unknown,
  genericMessage: string,
  context: Readonly<Record<string, unknown>>,
): string {
  if (error instanceof AppError) return error.message;
  logger.error({ err: error, ...context }, genericMessage);
  return genericMessage;
}
