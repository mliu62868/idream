// SPEC: liveness answers "is the process alive"; readiness answers "may this
// process accept a real turn". Readiness requires DB, Redis and an actual model
// warm-up through the production adapter.
import Redis from "ioredis";
import {
  OpenAICompatibleChatModel,
  resolveChatMemoryExtractProfile,
  resolveChatModelProfile,
  type ChatModelProfile,
} from "@idream/shared";
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma, chatProjectorPrisma } from "./db.js";
import type { ChatModel } from "./providers.js";
import { providers } from "./providers.js";
import { redisOptions } from "./queue.js";

export interface RuntimeReadinessSnapshot {
  live: boolean;
  ready: boolean;
  accepting: boolean;
  warming: boolean;
  lastError: string | null;
  warmedAt: string | null;
  dependencyCheckedAt: string | null;
  warmedProfiles: string[];
}

export const RUNTIME_READINESS_FRESHNESS_MS = 5_000;
export const RUNTIME_REDIS_PING_TIMEOUT_MS = 5_000;
export const RUNTIME_RECOVERY_INITIAL_BACKOFF_MS = 5_000;
export const RUNTIME_RECOVERY_MAX_BACKOFF_MS = 60_000;

type DependencyProbe = () => Promise<void>;
type FullWarmup = () => Promise<void>;

export class RuntimeReadiness {
  private state: RuntimeReadinessSnapshot = {
    live: true,
    ready: false,
    accepting: true,
    warming: false,
    lastError: null,
    warmedAt: null,
    dependencyCheckedAt: null,
    warmedProfiles: [],
  };
  private dependencyProbe: DependencyProbe | null = null;
  private dependencyProbeInFlight: Promise<void> | null = null;
  private nextDependencyProbeAt = 0;
  private invalidated = false;
  private invalidationEpoch = 0;
  private nextWarmupAttempt = 0;
  private activeWarmupAttempt = 0;
  private activeWarmupInvalidationEpoch = 0;
  private fullWarmup: FullWarmup | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryInFlight: Promise<void> | null = null;
  private recoveryFailures = 0;

  snapshot(): RuntimeReadinessSnapshot {
    return { ...this.state };
  }

  beginWarmup(): number {
    const warmupAttempt = ++this.nextWarmupAttempt;
    this.activeWarmupAttempt = warmupAttempt;
    this.activeWarmupInvalidationEpoch = this.invalidationEpoch;
    this.dependencyProbe = null;
    this.dependencyProbeInFlight = null;
    this.nextDependencyProbeAt = 0;
    this.state = {
      ...this.state,
      ready: false,
      warming: true,
      lastError: this.invalidated ? this.state.lastError : null,
      dependencyCheckedAt: null,
    };
    return warmupAttempt;
  }

  warmed(
    profiles: string[] = [],
    dependencyProbe: DependencyProbe | null = null,
    warmupAttempt = this.activeWarmupAttempt,
  ): boolean {
    // A successful probe only supersedes failures that existed when this exact
    // warmup attempt began. Another admitted worker can observe a newer provider
    // failure while recovery is in flight; that stronger evidence owns the next
    // recovery attempt and must not be erased by this stale completion.
    if (
      warmupAttempt !== this.activeWarmupAttempt ||
      this.activeWarmupInvalidationEpoch !== this.invalidationEpoch
    ) {
      return false;
    }
    const checkedAt = new Date();
    this.invalidated = false;
    this.recoveryFailures = 0;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.dependencyProbe = dependencyProbe;
    this.nextDependencyProbeAt = checkedAt.getTime() + RUNTIME_READINESS_FRESHNESS_MS;
    this.state = {
      ...this.state,
      ready: this.state.accepting,
      warming: false,
      lastError: null,
      warmedAt: checkedAt.toISOString(),
      dependencyCheckedAt: checkedAt.toISOString(),
      warmedProfiles: profiles,
    };
    return true;
  }

  failed(error: unknown): void {
    this.state = {
      ...this.state,
      ready: false,
      warming: false,
      lastError: error instanceof Error ? error.message : String(error),
    };
  }

  invalidate(error: unknown): void {
    // INVARIANT: a real admitted turn observed the provider after warmup. Do not
    // let a cheaper DB/Redis probe overwrite that stronger negative evidence;
    // only a full warmRuntime call may re-admit the process.
    this.invalidationEpoch += 1;
    this.invalidated = true;
    this.failed(error);
    this.scheduleFullWarmupRecovery();
  }

  configureFullWarmupRecovery(fullWarmup: FullWarmup): void {
    this.fullWarmup = fullWarmup;
    if (this.invalidated) this.scheduleFullWarmupRecovery();
  }

  stopAccepting(): void {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.state = { ...this.state, accepting: false, ready: false };
  }

  canAcceptTurns(): boolean {
    return this.state.live && this.state.ready && this.state.accepting;
  }

  async refreshDependencies(): Promise<boolean> {
    if (this.invalidated) return false;
    if (!this.state.accepting || !this.dependencyProbe) {
      return this.canAcceptTurns();
    }
    if (Date.now() < this.nextDependencyProbeAt) {
      return this.canAcceptTurns();
    }
    if (!this.dependencyProbeInFlight) {
      const probe = this.dependencyProbe;
      this.dependencyProbeInFlight = (async () => {
        try {
          await probe();
          if (
            this.invalidated ||
            !this.state.accepting ||
            this.dependencyProbe !== probe
          ) return;
          const checkedAt = new Date();
          this.nextDependencyProbeAt =
            checkedAt.getTime() + RUNTIME_READINESS_FRESHNESS_MS;
          this.state = {
            ...this.state,
            ready: true,
            warming: false,
            lastError: null,
            dependencyCheckedAt: checkedAt.toISOString(),
          };
        } catch (error) {
          if (this.invalidated || this.dependencyProbe !== probe) return;
          this.nextDependencyProbeAt =
            Date.now() + RUNTIME_READINESS_FRESHNESS_MS;
          this.failed(error);
        }
      })().finally(() => {
        this.dependencyProbeInFlight = null;
      });
    }
    await this.dependencyProbeInFlight;
    return this.canAcceptTurns();
  }

  private scheduleFullWarmupRecovery(): void {
    if (
      !this.state.accepting ||
      !this.invalidated ||
      !this.fullWarmup ||
      this.recoveryTimer ||
      this.recoveryInFlight
    ) {
      return;
    }
    const delay = Math.min(
      RUNTIME_RECOVERY_INITIAL_BACKOFF_MS * (2 ** this.recoveryFailures),
      RUNTIME_RECOVERY_MAX_BACKOFF_MS,
    );
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.runFullWarmupRecovery();
    }, delay);
    this.recoveryTimer.unref();
  }

  private async runFullWarmupRecovery(): Promise<void> {
    if (
      !this.state.accepting ||
      !this.invalidated ||
      !this.fullWarmup ||
      this.recoveryInFlight
    ) {
      return;
    }
    const fullWarmup = this.fullWarmup;
    const recoveryInvalidationEpoch = this.invalidationEpoch;
    this.recoveryInFlight = (async () => {
      try {
        await fullWarmup();
        if (!this.state.accepting) return;
        if (!this.canAcceptTurns()) {
          if (
            this.invalidated &&
            this.invalidationEpoch !== recoveryInvalidationEpoch
          ) {
            return;
          }
          throw new Error("chat full warmup completed without restoring readiness");
        }
      } catch (error) {
        this.recoveryFailures += 1;
        this.failed(error);
        this.invalidated = true;
      }
    })().finally(() => {
      this.recoveryInFlight = null;
      if (this.invalidated) this.scheduleFullWarmupRecovery();
    });
    await this.recoveryInFlight;
  }
}

export const runtimeReadiness = new RuntimeReadiness();

export async function assertChatSchemaReady(prisma: ChatPrismaClient): Promise<void> {
  // INVARIANT: a reachable database is not a ready database. Resolving the
  // exact relations used by every turn makes an unapplied Scene migration fail
  // before admission rather than during message creation.
  await prisma.$queryRaw`
    SELECT messages.scene_version, messages.runtime_trace, revisions.version
    FROM chat.messages AS messages
    LEFT JOIN chat.chat_scene_revisions AS revisions
      ON revisions.session_id = messages.session_id
    LIMIT 0
  `;

  // INVARIANT: memory enablement is immutable per assistant turn. A trigger
  // that is missing, weakened to another event/column, or REPLICA-only lets a
  // later preference change rewrite the authority used by an existing turn.
  const [messageMemoryAuthority] = await prisma.$queryRaw<
    Array<{ messageMemoryAuthorityReady: boolean }>
  >`
    SELECT COALESCE(
      count(*) = 1
      AND bool_and(
        trigger.tgenabled IN ('O', 'A')
        AND trigger.tgfoid =
          to_regprocedure('chat.reject_message_memory_authority_mutation()')
        AND pg_get_triggerdef(trigger.oid) =
          'CREATE TRIGGER message_memory_authority_immutable BEFORE UPDATE OF memory_authority ON chat.messages FOR EACH ROW EXECUTE FUNCTION chat.reject_message_memory_authority_mutation()'
        AND (
          SELECT proc.prolang = (
              SELECT language.oid
              FROM pg_language AS language
              WHERE language.lanname = 'plpgsql'
            )
            AND proc.prorettype = 'trigger'::regtype
            AND proc.provolatile = 'v'
            AND NOT proc.prosecdef
            AND encode(
              sha256(convert_to(proc.prosrc, 'UTF8')),
              'hex'
            ) = 'bafacc9a03bc7ae96a8f18aaea9c7fcacf85ec6396f40b44191aef5648376376'
          FROM pg_proc AS proc
          WHERE proc.oid = trigger.tgfoid
        )
      ),
      false
    ) AS "messageMemoryAuthorityReady"
    FROM pg_trigger AS trigger
    WHERE trigger.tgrelid = 'chat.messages'::regclass
      AND trigger.tgname = 'message_memory_authority_immutable'
      AND NOT trigger.tgisinternal
  `;
  if (!messageMemoryAuthority?.messageMemoryAuthorityReady) {
    throw new Error("chat message memory authority is not canonical");
  }

  // INVARIANT: account-erasure v2 is acknowledged only after Chat has
  // materialized its request-bound file-mutation receipt. A legacy two-arg
  // redactor makes that receipt impossible to commit, so reject the runtime
  // before it can accept or ACK any durable event.
  const [catalogAuthority] = await prisma.$queryRaw<
    Array<{ fileMutationAuthorityReady: boolean }>
  >`
    WITH authority_functions AS (
      SELECT
        to_regprocedure(
          'chat.redact_file_mutation_payload(text,text,jsonb)'
        ) AS redact_oid,
        to_regprocedure(
          'chat.redact_file_mutation_payload(text,jsonb)'
        ) AS legacy_redact_oid,
        to_regprocedure('chat.assert_file_mutation_update()') AS trigger_oid
    )
    SELECT COALESCE(
      functions.redact_oid IS NOT NULL
      AND functions.legacy_redact_oid IS NOT NULL
      AND functions.trigger_oid IS NOT NULL
      AND redact_proc.prolang = (
        SELECT language.oid
        FROM pg_language AS language
        WHERE language.lanname = 'sql'
      )
      AND redact_proc.prorettype = 'jsonb'::regtype
      AND redact_proc.provolatile = 'i'
      AND redact_proc.proparallel = 's'
      AND NOT redact_proc.prosecdef
      AND encode(
        sha256(convert_to(redact_proc.prosrc, 'UTF8')),
        'hex'
      ) = '94ff772d58470e1d7abd093ee762db14e7975ec7504d92b1771fad10d13d1a88'
      AND legacy_redact_proc.prolang = (
        SELECT language.oid
        FROM pg_language AS language
        WHERE language.lanname = 'sql'
      )
      AND legacy_redact_proc.prorettype = 'jsonb'::regtype
      AND legacy_redact_proc.provolatile = 'i'
      AND legacy_redact_proc.proparallel = 's'
      AND NOT legacy_redact_proc.prosecdef
      AND encode(
        sha256(convert_to(legacy_redact_proc.prosrc, 'UTF8')),
        'hex'
      ) = 'e39530608271e79c6e706b0564df5baab900412e27648330a5e47b70bca5ff42'
      AND trigger_proc.prolang = (
        SELECT language.oid
        FROM pg_language AS language
        WHERE language.lanname = 'plpgsql'
      )
      AND trigger_proc.prorettype = 'trigger'::regtype
      AND trigger_proc.provolatile = 'v'
      AND NOT trigger_proc.prosecdef
      AND encode(
        sha256(convert_to(trigger_proc.prosrc, 'UTF8')),
        'hex'
      ) = 'cbd3c376165f562a06735453ec28ec3937083bebdad7ea206d10aa4321a9d914'
      AND trigger_authority.ready,
      false
    ) AS "fileMutationAuthorityReady"
    FROM authority_functions AS functions
    LEFT JOIN pg_proc AS trigger_proc
      ON trigger_proc.oid = functions.trigger_oid
    LEFT JOIN pg_proc AS redact_proc
      ON redact_proc.oid = functions.redact_oid
    LEFT JOIN pg_proc AS legacy_redact_proc
      ON legacy_redact_proc.oid = functions.legacy_redact_oid
    CROSS JOIN LATERAL (
      SELECT count(*) = 1
        AND bool_and(
          trigger.tgenabled IN ('O', 'A')
          AND trigger.tgtype = 31
          AND trigger.tgqual IS NULL
          AND trigger.tgattr::text = ''
          AND trigger.tgfoid = functions.trigger_oid
        ) AS ready
      FROM pg_trigger AS trigger
      WHERE trigger.tgrelid = 'chat.chat_file_mutations'::regclass
        AND trigger.tgname = 'chat_file_mutations_immutable'
        AND NOT trigger.tgisinternal
    ) AS trigger_authority
  `;
  if (!catalogAuthority?.fileMutationAuthorityReady) {
    throw new Error("chat file mutation authority is not canonical");
  }

  const [semanticAuthority] = await prisma.$queryRaw<
    Array<{ fileMutationAuthorityReady: boolean }>
  >`
    SELECT chat.redact_file_mutation_payload(
      'readiness-file-mutation',
      'account_delete',
      jsonb_build_object(
        'kind', 'account_delete',
        'deletionRequestEventId', 'readiness-request',
        'requestBound', true
      )
    ) = jsonb_build_object(
      'kind', 'account_delete',
      'deletionRequestEventId', 'readiness-request',
      'requestBound', true
    ) AS "fileMutationAuthorityReady"
  `;
  if (!semanticAuthority?.fileMutationAuthorityReady) {
    throw new Error("chat file mutation authority is not canonical");
  }
}

type ConnectedDatabaseAuthority = {
  role: string;
  sessionRole: string;
  database: string;
  serverAddress: string | null;
  serverPort: number | null;
  capabilitiesReady: boolean;
};

async function connectedDatabaseAuthority(
  prisma: ChatPrismaClient,
): Promise<ConnectedDatabaseAuthority> {
  const [authority] = await prisma.$queryRaw<ConnectedDatabaseAuthority[]>`
    WITH runtime_role AS (
      SELECT
        role.rolcanlogin
        AND NOT role.rolsuper
        AND NOT role.rolbypassrls
        AND NOT role.rolcreaterole
        AND NOT role.rolcreatedb
        AND NOT role.rolreplication
        AND NOT pg_has_role(role.oid, 'core_owner'::regrole, 'MEMBER')
        AND NOT pg_has_role(role.oid, 'chat_owner'::regrole, 'MEMBER')
          AS posture_ready
      FROM pg_roles AS role
      WHERE role.rolname = session_user
    ),
    chat_relations AS (
      SELECT class.oid AS relation, class.relname
      FROM pg_class AS class
      JOIN pg_namespace AS namespace
        ON namespace.oid = class.relnamespace
      WHERE namespace.nspname = 'chat'
        AND class.relkind IN ('r', 'p', 'v', 'm', 'f')
    ),
    expected_chat_relations AS (
      SELECT
        relation,
        relname,
        CASE current_user
          WHEN 'chat_service' THEN
            relname IN (
              'chat_sessions',
              'chat_send_receipts',
              'chat_session_release_migrations',
              'messages',
              'message_attachments',
              'message_versions',
              'chat_usage',
              'chat_moderation_events',
              'chat_outbox_events',
              'chat_inbox_events',
              'chat_scene_revisions',
              'chat_file_mutations'
            )
          WHEN 'chat_projector' THEN
            relname IN (
              'chat_sessions',
              'chat_send_receipts',
              'messages',
              'chat_outbox_events',
              'chat_file_mutations'
            )
          ELSE false
        END AS can_select,
        CASE current_user
          WHEN 'chat_service' THEN
            relname IN (
              'chat_sessions',
              'chat_send_receipts',
              'chat_session_release_migrations',
              'messages',
              'message_attachments',
              'message_versions',
              'chat_usage',
              'chat_moderation_events',
              'chat_outbox_events',
              'chat_inbox_events',
              'chat_scene_revisions'
            )
          WHEN 'chat_projector' THEN false
          ELSE false
        END AS can_insert,
        CASE current_user
          WHEN 'chat_service' THEN
            relname IN (
              'chat_sessions',
              'chat_send_receipts',
              'chat_session_release_migrations',
              'messages',
              'message_attachments',
              'message_versions',
              'chat_usage',
              'chat_moderation_events',
              'chat_outbox_events',
              'chat_inbox_events'
            )
          WHEN 'chat_projector' THEN false
          ELSE false
        END AS can_update,
        current_user = 'chat_service'
          AND relname IN (
            'chat_sessions',
            'chat_send_receipts',
            'chat_session_release_migrations',
            'messages',
            'message_attachments',
            'message_versions',
            'chat_usage',
            'chat_moderation_events',
            'chat_outbox_events',
            'chat_inbox_events'
          ) AS can_delete
      FROM chat_relations
    ),
    expected_chat_columns AS (
      SELECT
        relation_authority.relation,
        relation_authority.relname,
        attribute.attname,
        relation_authority.can_select,
        relation_authority.can_insert
          OR (
            current_user = 'chat_service'
            AND relation_authority.relname = 'chat_file_mutations'
            AND attribute.attname IN ('id', 'user_id', 'kind', 'payload')
          )
          OR (
            current_user = 'chat_projector'
            AND relation_authority.relname = 'chat_outbox_events'
            AND attribute.attname IN (
              'id',
              'event_type',
              'aggregate_type',
              'aggregate_id',
              'payload',
              'schema_version',
              'status',
              'attempts',
              'next_run_at',
              'created_at'
            )
          ) AS can_insert,
        relation_authority.can_update
          OR (
            current_user = 'chat_projector'
            AND (
              (relation_authority.relname = 'chat_sessions'
                AND attribute.attname IN ('log_extracted_seq', 'updated_at'))
              OR (relation_authority.relname = 'messages'
                AND attribute.attname IN (
                  'memory_extracted_attempt', 'updated_at'
                ))
              OR (relation_authority.relname = 'chat_file_mutations'
                AND attribute.attname IN (
                  'status', 'payload', 'attempts', 'last_error', 'applied_at'
                ))
            )
          ) AS can_update
      FROM expected_chat_relations AS relation_authority
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = relation_authority.relation
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
    ),
    authority_views AS (
      SELECT class.oid AS relation, class.relname
      FROM pg_class AS class
      JOIN pg_namespace AS namespace
        ON namespace.oid = class.relnamespace
      WHERE (namespace.nspname, class.relname) IN (
        ('core', 'chat_user_view'),
        ('core', 'chat_character_view'),
        ('core', 'chat_character_content_version_view'),
        ('core', 'chat_character_release_view'),
        ('core', 'chat_character_tags_view'),
        ('billing', 'chat_entitlement_view'),
        ('compliance', 'chat_user_eligibility_view')
      )
    ),
    chat_sequences AS (
      SELECT class.oid AS relation, class.relname
      FROM pg_class AS class
      JOIN pg_namespace AS namespace
        ON namespace.oid = class.relnamespace
      WHERE namespace.nspname = 'chat'
        AND class.relkind = 'S'
    ),
    chat_functions AS (
      SELECT procedure.oid AS procedure
      FROM pg_proc AS procedure
      JOIN pg_namespace AS namespace
        ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'chat'
    ),
    chat_owner_default_grants AS (
      SELECT expanded.grantee
      FROM pg_roles AS owner_role
      CROSS JOIN (
        VALUES ('r'::"char"), ('S'::"char"), ('f'::"char")
      ) AS object_type(code)
      CROSS JOIN LATERAL aclexplode(
        COALESCE(
          (
            SELECT defaults.defaclacl
            FROM pg_default_acl AS defaults
            WHERE defaults.defaclrole = owner_role.oid
              AND defaults.defaclnamespace = 0
              AND defaults.defaclobjtype = object_type.code
          ),
          acldefault(object_type.code, owner_role.oid)
        )
      ) AS expanded
      WHERE owner_role.rolname = 'chat_owner'
      UNION ALL
      SELECT expanded.grantee
      FROM pg_roles AS owner_role
      JOIN pg_default_acl AS defaults
        ON defaults.defaclrole = owner_role.oid
       AND defaults.defaclnamespace = (
         SELECT oid FROM pg_namespace WHERE nspname = 'chat'
       )
       AND defaults.defaclobjtype IN ('r', 'S', 'f')
      CROSS JOIN LATERAL aclexplode(defaults.defaclacl) AS expanded
      WHERE owner_role.rolname = 'chat_owner'
    ),
    application_schemas AS (
      SELECT namespace.oid AS schema, namespace.nspname
      FROM pg_namespace AS namespace
      WHERE namespace.nspname IN (
        'chat', 'core', 'billing', 'compliance', 'public'
      )
    ),
    public_tables AS (
      SELECT class.oid AS relation
      FROM pg_class AS class
      JOIN pg_namespace AS namespace
        ON namespace.oid = class.relnamespace
      WHERE namespace.nspname = 'public'
        AND class.relkind IN ('r', 'p', 'v', 'm', 'f')
    )
    SELECT
      current_user::text AS role,
      session_user::text AS "sessionRole",
      current_database()::text AS database,
      inet_server_addr()::text AS "serverAddress",
      inet_server_port() AS "serverPort",
      COALESCE(
        runtime_role.posture_ready
        AND current_user IN ('chat_service', 'chat_projector')
        AND NOT EXISTS (
          SELECT 1
          FROM expected_chat_relations AS table_authority
          WHERE has_table_privilege(
              current_user,
              table_authority.relation,
              'SELECT'
            ) IS DISTINCT FROM table_authority.can_select
            OR has_table_privilege(
              current_user,
              table_authority.relation,
              'INSERT'
            ) IS DISTINCT FROM table_authority.can_insert
            OR has_table_privilege(
              current_user,
              table_authority.relation,
              'UPDATE'
            ) IS DISTINCT FROM table_authority.can_update
            OR has_table_privilege(
              current_user,
              table_authority.relation,
              'DELETE'
            ) IS DISTINCT FROM table_authority.can_delete
            OR has_table_privilege(
              current_user,
              table_authority.relation,
              'TRUNCATE'
            )
            OR has_table_privilege(
              current_user,
              table_authority.relation,
              'REFERENCES'
            )
            OR has_table_privilege(
              current_user,
              table_authority.relation,
              'TRIGGER'
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM expected_chat_columns AS column_authority
          WHERE has_column_privilege(
              current_user,
              column_authority.relation,
              column_authority.attname,
              'SELECT'
            ) IS DISTINCT FROM column_authority.can_select
            OR has_column_privilege(
              current_user,
              column_authority.relation,
              column_authority.attname,
              'INSERT'
            ) IS DISTINCT FROM column_authority.can_insert
            OR has_column_privilege(
              current_user,
              column_authority.relation,
              column_authority.attname,
              'UPDATE'
            ) IS DISTINCT FROM column_authority.can_update
            OR has_column_privilege(
              current_user,
              column_authority.relation,
              column_authority.attname,
              'REFERENCES'
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM chat_sequences AS sequence_authority
          WHERE has_sequence_privilege(
              current_user,
              sequence_authority.relation,
              'USAGE'
            ) IS DISTINCT FROM (
              current_user = 'chat_service'
              AND sequence_authority.relname =
                'chat_file_mutations_sequence_seq'
            )
            OR has_sequence_privilege(
              current_user,
              sequence_authority.relation,
              'SELECT'
            )
            OR has_sequence_privilege(
              current_user,
              sequence_authority.relation,
              'UPDATE'
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public_tables AS public_authority
          WHERE has_table_privilege(current_user, public_authority.relation, 'SELECT')
            OR has_table_privilege(current_user, public_authority.relation, 'INSERT')
            OR has_table_privilege(current_user, public_authority.relation, 'UPDATE')
            OR has_table_privilege(current_user, public_authority.relation, 'DELETE')
            OR has_table_privilege(current_user, public_authority.relation, 'TRUNCATE')
            OR has_table_privilege(current_user, public_authority.relation, 'REFERENCES')
            OR has_table_privilege(current_user, public_authority.relation, 'TRIGGER')
            OR has_any_column_privilege(
              current_user,
              public_authority.relation,
              'SELECT,INSERT,UPDATE,REFERENCES'
            )
        )
        AND (SELECT count(*) = 7 FROM authority_views)
        AND NOT EXISTS (
          SELECT 1
          FROM authority_views AS view_authority
          WHERE has_table_privilege(
              current_user,
              view_authority.relation,
              'SELECT'
            ) IS DISTINCT FROM (current_user = 'chat_service')
            OR has_table_privilege(current_user, view_authority.relation, 'INSERT')
            OR has_table_privilege(current_user, view_authority.relation, 'UPDATE')
            OR has_table_privilege(current_user, view_authority.relation, 'DELETE')
            OR has_table_privilege(current_user, view_authority.relation, 'TRUNCATE')
            OR has_table_privilege(current_user, view_authority.relation, 'REFERENCES')
            OR has_table_privilege(current_user, view_authority.relation, 'TRIGGER')
        )
        AND (SELECT count(*) = 5 FROM application_schemas)
        AND NOT EXISTS (
          SELECT 1
          FROM application_schemas AS schema_authority
          WHERE (
              schema_authority.nspname <> 'public'
              AND has_schema_privilege(
                current_user,
                schema_authority.schema,
                'USAGE'
              ) IS DISTINCT FROM (
                (current_user = 'chat_service'
                  AND schema_authority.nspname IN (
                    'chat', 'core', 'billing', 'compliance'
                  ))
                OR (current_user = 'chat_projector'
                  AND schema_authority.nspname = 'chat')
              )
            )
            OR has_schema_privilege(
              current_user,
              schema_authority.schema,
              'CREATE'
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM chat_functions AS function_authority
          WHERE has_function_privilege(
              current_user,
              function_authority.procedure,
              'EXECUTE'
            ) IS DISTINCT FROM CASE current_user
              WHEN 'chat_service' THEN function_authority.procedure IN (
                to_regprocedure(
                  'chat.redact_file_mutation_payload(text,text,jsonb)'
                ),
                to_regprocedure(
                  'chat.purge_file_mutations_for_account(text,text)'
                )
              )
              WHEN 'chat_projector' THEN function_authority.procedure IN (
                to_regprocedure(
                  'chat.redact_file_mutation_payload(text,text,jsonb)'
                ),
                to_regprocedure(
                  'chat.purge_file_mutations_for_account(text,text)'
                ),
                to_regprocedure(
                  'chat.purge_applied_relationship_sets(text,text,bigint)'
                )
              )
              ELSE false
            END
        )
        AND NOT EXISTS (
          SELECT 1
          FROM chat_owner_default_grants AS default_authority
          WHERE default_authority.grantee = 0
            OR default_authority.grantee IN (
              'chat_service'::regrole::oid,
              'chat_projector'::regrole::oid
            )
        ),
        false
      ) AS "capabilitiesReady"
    FROM runtime_role
  `;
  if (
    !authority?.sessionRole ||
    !authority.database ||
    !authority.serverAddress ||
    !Number.isInteger(authority.serverPort) ||
    typeof authority.capabilitiesReady !== "boolean"
  ) {
    throw new Error("chat database authority is incomplete");
  }
  return authority;
}

async function assertChatProjectorReady(
  requestPrisma: ChatPrismaClient,
  projectorPrisma: ChatPrismaClient,
): Promise<void> {
  // INVARIANT: readiness covers the narrow client that commits durable file
  // receipts, not only the broader request client. Both connections must land
  // on the same PostgreSQL authority while retaining distinct credentials.
  const requestAuthority = await connectedDatabaseAuthority(requestPrisma);
  const projectorAuthority = await connectedDatabaseAuthority(projectorPrisma);
  if (requestAuthority.sessionRole !== "chat_service") {
    throw new Error("chat request authenticated role is not canonical");
  }
  if (requestAuthority.role !== "chat_service") {
    throw new Error("chat request database role is not canonical");
  }
  if (!requestAuthority.capabilitiesReady) {
    throw new Error("chat request database capability is not canonical");
  }
  if (projectorAuthority.sessionRole !== "chat_projector") {
    throw new Error("chat projector authenticated role is not canonical");
  }
  if (projectorAuthority.role !== "chat_projector") {
    throw new Error("chat projector database role is not canonical");
  }
  if (!projectorAuthority.capabilitiesReady) {
    throw new Error("chat projector database capability is not canonical");
  }
  if (
    projectorAuthority.serverAddress !== requestAuthority.serverAddress ||
    projectorAuthority.serverPort !== requestAuthority.serverPort ||
    projectorAuthority.database !== requestAuthority.database
  ) {
    throw new Error(
      "chat projector database authority differs from request database",
    );
  }
}

export async function warmRuntime(input: {
  prisma?: ChatPrismaClient;
  projectorPrisma?: ChatPrismaClient;
  chat?: ChatModel;
  memoryChat?: ChatModel;
  profiles?: ChatModelProfile[];
  pingRedis?: () => Promise<void>;
  readiness?: RuntimeReadiness;
} = {}): Promise<void> {
  const readiness = input.readiness ?? runtimeReadiness;
  const warmupAttempt = readiness.beginWarmup();
  try {
    const prisma = input.prisma ?? chatPrisma;
    const projectorPrisma = input.projectorPrisma ?? chatProjectorPrisma;
    const chat = input.chat ?? providers.chat;
    await assertChatSchemaReady(prisma);
    await assertChatProjectorReady(prisma, projectorPrisma);
    const pingRuntimeRedis = input.pingRedis ?? pingRedis;
    await pingRuntimeRedis();

    const profiles = distinctProfiles(input.profiles ?? ["free", "premium", "deluxe"].map(
      (tier) => resolveChatModelProfile(process.env, tier),
    ));
    const warmedProfiles: string[] = [];
    for (const profile of profiles) {
      let output = "";
      for await (const chunk of chat.stream({
        model: profile.model,
        messages: [
          {
            role: "system",
            content: "You are a runtime warm-up probe. Reply with READY only.",
          },
          { role: "user", content: "READY" },
        ],
        tools: profile.supportsTools ? [READINESS_TOOL] : [],
      })) {
        output += chunk.delta;
      }
      if (!output.trim()) {
        throw new Error(`chat model warm-up returned no content for ${profile.model}`);
      }
      warmedProfiles.push(`chat:${profile.provider}:${profile.model}`);
    }

    const memory = resolveChatMemoryExtractProfile(process.env);
    const defaultProfile = profiles[0] ?? resolveChatModelProfile(process.env);
    const memoryChat = input.memoryChat ?? input.chat ?? (
      defaultProfile.provider === "mock"
        ? chat
        : new OpenAICompatibleChatModel({
            ...defaultProfile,
            baseUrl: memory.baseUrl,
            model: memory.model,
            apiKey: memory.apiKey,
            completionTimeoutMs: memory.timeoutMs,
          })
    );
    const extracted = await memoryChat.complete({
      model: memory.model,
      messages: [
        { role: "system", content: "Reply with exactly {} and nothing else." },
        { role: "user", content: "{}" },
      ],
      // INTENT: keep this far below a real extraction turn (300 tokens) while
      // leaving enough room for OpenAI-compatible chat templates to terminate.
      maxTokens: 64,
    });
    if (!extracted.content.trim()) throw new Error("memory extractor warm-up returned no content");
    warmedProfiles.push(`memory:${memory.model}`);
    readiness.warmed(
      warmedProfiles,
      async () => {
        await assertChatSchemaReady(prisma);
        await assertChatProjectorReady(prisma, projectorPrisma);
        await pingRuntimeRedis();
      },
      warmupAttempt,
    );
  } catch (error) {
    readiness.failed(error);
    throw error;
  }
}

const READINESS_TOOL = {
  name: "runtime_readiness_probe",
  description: "Validate that the exact production tool schema is accepted.",
  parameters: {
    type: "object",
    properties: { ready: { type: "boolean" } },
    required: ["ready"],
    additionalProperties: false,
  },
};

function distinctProfiles(profiles: ChatModelProfile[]): ChatModelProfile[] {
  const seen = new Set<string>();
  return profiles.filter((profile) => {
    const key = `${profile.provider}\u0000${profile.baseUrl}\u0000${profile.model}\u0000${profile.supportsTools}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function pingRedis(): Promise<void> {
  const redis = new Redis(redisOptions());
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      redis.ping(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(
            `Chat Redis readiness ping timed out after ${RUNTIME_REDIS_PING_TIMEOUT_MS}ms`,
          ));
        }, RUNTIME_REDIS_PING_TIMEOUT_MS);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    // INTENT: this is a one-shot probe client. A graceful QUIT is another Redis
    // command and can hang on the same black hole, so close the socket locally.
    redis.disconnect();
  }
}
