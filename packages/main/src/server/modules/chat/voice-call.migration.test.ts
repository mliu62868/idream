import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { expect, it } from "vitest";
import { env } from "@/server/lib/env";

it("rehearses the additive Call SQL and preserves old Voice authority", async () => {
  const schema = `call_migration_${randomUUID().replaceAll("-", "")}`;
  const client = new pg.Client({ connectionString: env.DATABASE_URL }); await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET search_path TO "${schema}"`);
    await client.query(`CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE characters(id TEXT PRIMARY KEY);
      CREATE TABLE recent_chats("sessionId" TEXT PRIMARY KEY); CREATE TABLE voice_clip_requests(id TEXT PRIMARY KEY, "requestFingerprint" TEXT NOT NULL);
      INSERT INTO users VALUES ('owner'); INSERT INTO characters VALUES ('character'); INSERT INTO recent_chats VALUES ('session');
      INSERT INTO voice_clip_requests VALUES ('existing', 'accepted-old-fingerprint');`);
    const sql = await readFile(new URL("../../../../prisma/migrations/20261001020000_voice_calls/migration.sql", import.meta.url), "utf8");
    await client.query(sql);
    expect((await client.query('SELECT * FROM voice_clip_requests')).rows).toEqual([{ id: "existing", requestFingerprint: "accepted-old-fingerprint", voiceCallUtteranceId: null }]);
    const insert = `INSERT INTO voice_calls (id,"userId","sessionId","characterId","activeKey","requestHash","providerPayload","billingAuthority","maxCostDreamcoins","leaseToken","leaseExpiresAt","deadlineAt","lastHeartbeatAt","updatedAt")
      VALUES ($1,'owner','session','character','owner','hash','{}','{}',4,'lease',now()+interval '15 seconds',now()+interval '3 minutes',now(),now())`;
    await client.query(insert, ["call"]);
    await expect(client.query(insert, ["second-call"])).rejects.toThrow(/unique/);
    await expect(client.query(`UPDATE voice_calls SET "maxCostDreamcoins"=100 WHERE id='call'`)).rejects.toThrow(/immutable/);
    await client.query(`INSERT INTO voice_call_utterances (id,"callId","audioDigest","updatedAt") VALUES ('recording','call','audio-hash',now());`);
    await expect(client.query(`UPDATE voice_call_utterances SET "audioDigest"='changed' WHERE id='recording'`)).rejects.toThrow(/immutable/);
    await client.query(`UPDATE voice_call_utterances SET status='delivered',"settledAt"=now(),"durationMs"=500 WHERE id='recording'`);
    await expect(client.query(`UPDATE voice_call_utterances SET "costDreamcoins"=2 WHERE id='recording'`)).rejects.toThrow(/immutable/);
    await expect(client.query(`UPDATE voice_clip_requests SET "voiceCallUtteranceId"='recording' WHERE id='existing'`)).rejects.toThrow(/immutable/);
    await client.query(`UPDATE voice_calls SET status='ended',"endedAt"=now(),"settledAt"=now(),"activeKey"=null WHERE id='call'`);
    await expect(client.query(`UPDATE voice_calls SET "connectedMs"=1000 WHERE id='call'`)).rejects.toThrow(/immutable/);
    await client.query(insert, ["next-call"]);
  } finally { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await client.end(); }
});

it("grants the actual application connection access and covers future migration-owner tables", async () => {
  const suffix = randomUUID().replaceAll("-", ""), role = `call_app_${suffix}`, table = `call_grants_${suffix}`, secret = randomUUID();
  const owner = new pg.Client({ connectionString: env.DATABASE_URL }); await owner.connect();
  let app: pg.Client | undefined;
  try {
    await owner.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${secret}'`);
    const appUrl = new URL(env.DATABASE_URL); appUrl.username = role; appUrl.password = secret;
    app = new pg.Client({ connectionString: appUrl.toString() }); await app.connect();
    await expect(app.query("SELECT count(*) FROM public.voice_calls")).rejects.toThrow(/permission denied/);
    await owner.query("SELECT set_config('idream.main_runtime_role',$1,false)", [role]);
    await owner.query(await readFile(new URL("../../../../../../db/sql/2026-10-01-voice-call-runtime-grants.sql", import.meta.url), "utf8"));
    await app.query("SELECT count(*) FROM public.voice_calls"); await app.query("SELECT count(*) FROM public.voice_call_utterances");
    const rights = (await app.query("SELECT has_table_privilege(current_user,'public.voice_calls','SELECT,INSERT,UPDATE,DELETE') calls,has_table_privilege(current_user,'public.voice_call_utterances','SELECT,INSERT,UPDATE,DELETE') utterances")).rows[0];
    expect(rights).toEqual({ calls: true, utterances: true });
    await owner.query(`CREATE TABLE public."${table}" (id INTEGER PRIMARY KEY, value TEXT)`);
    await app.query(`INSERT INTO public."${table}" VALUES(1,'original')`);
    await app.query(`UPDATE public."${table}" SET value='updated' WHERE id=1`);
    expect((await app.query(`SELECT value FROM public."${table}"`)).rows).toEqual([{ value: "updated" }]);
    await app.query(`DELETE FROM public."${table}" WHERE id=1`);
    expect((await app.query(`SELECT count(*)::int count FROM public."${table}"`)).rows[0].count).toBe(0);
  } finally {
    await app?.end(); await owner.query(`DROP TABLE IF EXISTS public."${table}"`);
    await owner.query(`DROP OWNED BY "${role}"`); await owner.query(`DROP ROLE "${role}"`); await owner.end();
  }
});
