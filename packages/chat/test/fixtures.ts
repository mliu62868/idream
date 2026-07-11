import type { Pool } from "pg";

/** Explicitly satisfy the product's age-gate precondition for chat integration fixtures. */
export async function acceptAgeGate(pool: Pool, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  await pool.query(
    `INSERT INTO public.age_gate_acceptances (id, "userId", "acceptedAt")
     SELECT 'age_test_' || md5(user_id), user_id, now()
     FROM unnest($1::text[]) AS user_id
     ON CONFLICT (id) DO NOTHING`,
    [userIds],
  );
}
