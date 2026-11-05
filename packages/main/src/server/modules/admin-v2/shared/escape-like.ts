/**
 * SPEC: Escape a user-supplied term before it reaches SQL LIKE / ILIKE, including Prisma's
 * `contains`, which binds the term without escaping `%` or `_`.
 * INTENT: an operator searching for "100%" or "user_1" means those literal characters. Unescaped,
 * "%" and "_" match every row, so a filter silently stops filtering. Postgres' default LIKE escape
 * character is backslash, so no `ESCAPE` clause is needed at either the Prisma or the raw SQL site.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, "\\$&");
}
