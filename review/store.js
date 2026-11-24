import pg from 'pg';
import { AnalysisStore, ANALYSIS_SCHEMA } from './analysis-store.js';

const GLOBAL_BUDGET_LOCK = 74821390;
export const RUN_ABANDONED_TIMEOUT_MINUTES = 15;

export class Store extends AnalysisStore {
  constructor(connectionString) {
    super();
    this.pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 });
    this.ready = null;
  }

  async init() {
    if (!this.ready) {
      this.ready = this.pool.query(`
        CREATE TABLE IF NOT EXISTS review_budget (
          day date NOT NULL,
          scope text NOT NULL,
          used bigint NOT NULL DEFAULT 0,
          PRIMARY KEY(day, scope)
        );
        CREATE TABLE IF NOT EXISTS review_reservation (
          id text PRIMARY KEY,
          day date NOT NULL,
          repo text NOT NULL,
          pr_key text,
          amount bigint NOT NULL,
          status text NOT NULL,
          result jsonb,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        ALTER TABLE review_reservation ADD COLUMN IF NOT EXISTS pr_key text;
        ALTER TABLE review_reservation ADD COLUMN IF NOT EXISTS result jsonb;
        ALTER TABLE review_reservation ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
        CREATE TABLE IF NOT EXISTS review_publication (
          id text PRIMARY KEY,
          status text NOT NULL,
          installation_id text,
          repository_id text,
          owner text,
          repo text,
          pr_number integer,
          base_sha text,
          head_sha text,
          bot_id bigint,
          output jsonb,
          summary_output jsonb,
          review_id bigint,
          recovery_attempts integer NOT NULL DEFAULT 0,
          recovery_claim_id text,
          recovery_claimed_at timestamptz,
          alerted_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        ALTER TABLE review_publication ADD COLUMN IF NOT EXISTS installation_id text;
        ALTER TABLE review_publication ADD COLUMN IF NOT EXISTS repository_id text;
        ALTER TABLE review_publication ADD COLUMN IF NOT EXISTS owner text;
        ALTER TABLE review_publication ADD COLUMN IF NOT EXISTS repo text;
        ALTER TABLE review_publication ADD COLUMN IF NOT EXISTS pr_number integer;
        ALTER TABLE review_publication ADD COLUMN IF NOT EXISTS base_sha text;
        ALTER TABLE review_publication ADD COLUMN IF NOT EXISTS head_sha text;
        ALTER TABLE review_publication ADD COLUMN IF NOT EXISTS bot_id bigint;
        ALTER TABLE review_publication ADD COLUMN IF NOT EXISTS output jsonb;
        ALTER TABLE review_publication ADD COLUMN IF NOT EXISTS summary_output jsonb;
        ALTER TABLE review_publication ADD COLUMN IF NOT EXISTS review_id bigint;
        ALTER TABLE review_publication ADD COLUMN IF NOT EXISTS recovery_attempts integer NOT NULL DEFAULT 0;
        ALTER TABLE review_publication ADD COLUMN IF NOT EXISTS recovery_claim_id text;
        ALTER TABLE review_publication ADD COLUMN IF NOT EXISTS recovery_claimed_at timestamptz;
        ALTER TABLE review_publication ADD COLUMN IF NOT EXISTS alerted_at timestamptz;
        ALTER TABLE review_publication ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
        ALTER TABLE review_publication ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
        CREATE TABLE IF NOT EXISTS review_write_schedule (
          installation_id text PRIMARY KEY,
          next_allowed_at timestamptz NOT NULL
        );
        CREATE TABLE IF NOT EXISTS review_write_slot (
          operation_id text PRIMARY KEY,
          installation_id text NOT NULL,
          scheduled_at timestamptz NOT NULL
        );
        CREATE TABLE IF NOT EXISTS review_run (
          identity_key text PRIMARY KEY,
          state text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS review_run_state_updated_idx
          ON review_run(state, updated_at);
        CREATE INDEX IF NOT EXISTS review_publication_recovery_idx
          ON review_publication(status, updated_at);
        CREATE TABLE IF NOT EXISTS file_facts (
          repository_id bigint NOT NULL,
          blob_sha text NOT NULL,
          parser_version text NOT NULL,
          facts jsonb NOT NULL,
          parse_status text NOT NULL,
          indexed_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY(repository_id, blob_sha, parser_version)
        );
        CREATE TABLE IF NOT EXISTS file_identifier_index (
          repository_id bigint NOT NULL,
          identifier text NOT NULL,
          blob_sha text NOT NULL,
          PRIMARY KEY(repository_id, identifier, blob_sha)
        );
        CREATE INDEX IF NOT EXISTS file_identifier_lookup_idx
          ON file_identifier_index(repository_id, identifier);
        ${ANALYSIS_SCHEMA}
      `).catch((error) => {
        this.ready = null;
        throw error;
      });
    }
    await this.ready;
  }

  async transaction(fn) {
    await this.init();
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT pg_advisory_xact_lock($1)', [GLOBAL_BUDGET_LOCK]);
      const result = await fn(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }

  async reserve(id, repo, prKey, amount, limits) {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new TypeError('Reservation amount must be a positive integer');
    return this.transaction(async (connection) => {
      const existing = (await connection.query('SELECT status,result FROM review_reservation WHERE id=$1', [id])).rows[0];
      if (existing) {
        return {
          reserved: false,
          reason: existing.status === 'unknown' ? 'unknown' : 'prior_attempt',
          result: existing.result || null,
        };
      }

      const scopes = [
        { name: 'global', limit: limits.globalDailyTokenLimit },
        { name: repo, limit: limits.dailyTokenLimit },
        { name: prKey, limit: limits.prDailyTokenLimit },
      ];
      for (const scope of scopes) {
        await connection.query(
          "INSERT INTO review_budget(day,scope) VALUES ((now() AT TIME ZONE 'UTC')::date,$1) ON CONFLICT DO NOTHING",
          [scope.name],
        );
      }
      const names = scopes.map((scope) => scope.name);
      const rows = (await connection.query(
        "SELECT scope,used FROM review_budget WHERE day=(now() AT TIME ZONE 'UTC')::date AND scope=ANY($1)",
        [names],
      )).rows;
      const current = new Map(rows.map((row) => [row.scope, Number(row.used)]));
      if (scopes.some((scope) => (current.get(scope.name) || 0) + amount > scope.limit)) {
        return { reserved: false, reason: 'limit' };
      }

      await connection.query(
        "UPDATE review_budget SET used=used+$1 WHERE day=(now() AT TIME ZONE 'UTC')::date AND scope=ANY($2)",
        [amount, names],
      );
      await connection.query(
        "INSERT INTO review_reservation(id,day,repo,pr_key,amount,status) VALUES ($1,(now() AT TIME ZONE 'UTC')::date,$2,$3,$4,'reserved')",
        [id, repo, prKey, amount],
      );
      return { reserved: true };
    });
  }

  async reconcile(id, actual, result = null) {
    if (!Number.isSafeInteger(actual) || actual < 0) throw new TypeError('Actual token count must be a non-negative integer');
    return this.transaction(async (connection) => {
      const reservation = (await connection.query('SELECT * FROM review_reservation WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!reservation || reservation.status !== 'reserved') return false;
      const scopes = ['global', reservation.repo, reservation.pr_key];
      const difference = actual - Number(reservation.amount);
      await connection.query(
        'UPDATE review_budget SET used=GREATEST(0,used+$1) WHERE day=$2 AND scope=ANY($3)',
        [difference, reservation.day, scopes],
      );
      await connection.query(
        "UPDATE review_reservation SET status='accounted',amount=$2,result=$3::jsonb,updated_at=now() WHERE id=$1",
        [id, actual, result ? JSON.stringify(result) : null],
      );
      return true;
    });
  }

  async releaseReservation(id) {
    return this.transaction(async (connection) => {
      const reservation = (await connection.query(
        "DELETE FROM review_reservation WHERE id=$1 AND status='reserved' RETURNING *",
        [id],
      )).rows[0];
      if (!reservation) return false;
      const scopes = ['global', reservation.repo, reservation.pr_key];
      await connection.query(
        'UPDATE review_budget SET used=GREATEST(0,used-$1) WHERE day=$2 AND scope=ANY($3)',
        [Number(reservation.amount), reservation.day, scopes],
      );
      return true;
    });
  }

  async markReservationUnknown(id) {
    await this.init();
    await this.pool.query("UPDATE review_reservation SET status='unknown',updated_at=now() WHERE id=$1 AND status='reserved'", [id]);
  }

  async publication(id) {
    await this.init();
    return (await this.pool.query('SELECT * FROM review_publication WHERE id=$1', [id])).rows[0] || null;
  }

  async claimPublication(id, payload) {
    return this.transaction(async (connection) => {
      const existing = (await connection.query('SELECT status FROM review_publication WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!existing) {
        await connection.query(
          `INSERT INTO review_publication
            (id,status,installation_id,repository_id,owner,repo,pr_number,base_sha,head_sha,bot_id,output,summary_output)
           VALUES ($1,'publishing',$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)`,
          [id, payload.installationId, payload.repositoryId, payload.owner, payload.repo, payload.prNumber,
            payload.snapshot.base, payload.snapshot.head, payload.botId, JSON.stringify(payload.output), JSON.stringify(payload.summaryOutput)],
        );
        return true;
      }
      if (existing.status !== 'retryable') return false;
      await connection.query(
        `UPDATE review_publication SET status='publishing',output=$2::jsonb,summary_output=$3::jsonb,
         updated_at=now() WHERE id=$1`,
        [id, JSON.stringify(payload.output), JSON.stringify(payload.summaryOutput)],
      );
      return true;
    });
  }

  async claimRecovery(id, ttlMinutes = 15, claimId = id) {
    await this.init();
    const result = await this.pool.query(
      `UPDATE review_publication SET recovery_claim_id=$3,recovery_claimed_at=now(),status='publishing',updated_at=now()
       WHERE id=$1 AND status IN ('publishing','publish_unknown','retryable') AND recovery_attempts=0
       AND updated_at <= now() - ($2 * interval '1 minute')
       AND (recovery_claimed_at IS NULL OR recovery_claimed_at <= now() - interval '5 minutes' OR recovery_claim_id=$3)
       RETURNING *`,
      [id, ttlMinutes, claimId],
    );
    if (result.rows[0]) return result.rows[0];
    return (await this.pool.query(
      "SELECT * FROM review_publication WHERE id=$1 AND recovery_claim_id=$2 AND status='publishing'",
      [id, claimId],
    )).rows[0] || null;
  }

  async beginRecoveryWrite(id, claimId) {
    await this.init();
    const updated = await this.pool.query(
      `UPDATE review_publication SET recovery_attempts=1,updated_at=now()
       WHERE id=$1 AND recovery_claim_id=$2 AND recovery_attempts=0 RETURNING id`,
      [id, claimId],
    );
    return updated.rowCount === 1;
  }

  async deferRecovery(id, claimId) {
    await this.init();
    await this.pool.query(
      `UPDATE review_publication SET status='publishing',recovery_claim_id=NULL,recovery_claimed_at=NULL,
       updated_at=now() WHERE id=$1 AND recovery_claim_id=$2 AND recovery_attempts=0`,
      [id, claimId],
    );
  }

  async listRecoverablePublications(ttlMinutes = 15, limit = 50) {
    await this.init();
    const result = await this.pool.query(
      `SELECT * FROM review_publication WHERE status IN ('publishing','publish_unknown','retryable')
       AND recovery_attempts=0 AND updated_at <= now() - ($1 * interval '1 minute')
       ORDER BY updated_at ASC LIMIT $2`,
      [ttlMinutes, limit],
    );
    return result.rows;
  }

  async listUnresolvedPublications(limit = 50) {
    await this.init();
    const result = await this.pool.query(
      `SELECT id FROM review_publication WHERE status IN ('publishing','publish_unknown') AND recovery_attempts > 0
       AND updated_at <= now() - interval '1 hour'
       AND (alerted_at IS NULL OR alerted_at <= now() - interval '1 hour')
       ORDER BY updated_at ASC LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  async mark(id, status, reviewId = null) {
    await this.init();
    await this.pool.query(
      `INSERT INTO review_publication(id,status,review_id) VALUES ($1,$2,$3)
       ON CONFLICT(id) DO UPDATE SET status=$2,review_id=COALESCE($3,review_publication.review_id),updated_at=now()`,
      [id, status, reviewId],
    );
  }

  async markAlerted(id) {
    await this.init();
    await this.pool.query('UPDATE review_publication SET alerted_at=now() WHERE id=$1', [id]);
  }

  async releasePublication(id) {
    await this.init();
    await this.pool.query("UPDATE review_publication SET status='retryable',updated_at=now() WHERE id=$1 AND status='publishing'", [id]);
  }

  async reserveWriteSlot(operationId, installationId) {
    return this.transaction(async (connection) => {
      const existing = (await connection.query('SELECT scheduled_at FROM review_write_slot WHERE operation_id=$1', [operationId])).rows[0];
      if (existing) return new Date(existing.scheduled_at);

      await connection.query('SELECT pg_advisory_xact_lock(74821391, hashtext($1))', [`github-installation-write:${installationId}`]);
      const clock = (await connection.query('SELECT clock_timestamp() AS now')).rows[0].now;
      const schedule = (await connection.query('SELECT next_allowed_at FROM review_write_schedule WHERE installation_id=$1 FOR UPDATE', [String(installationId)])).rows[0];
      const now = new Date(clock);
      const scheduledAt = schedule && new Date(schedule.next_allowed_at) > now ? new Date(schedule.next_allowed_at) : now;
      const nextAllowedAt = new Date(scheduledAt.getTime() + 1000);
      await connection.query(
        `INSERT INTO review_write_schedule(installation_id,next_allowed_at) VALUES ($1,$2)
         ON CONFLICT(installation_id) DO UPDATE SET next_allowed_at=EXCLUDED.next_allowed_at`,
        [String(installationId), nextAllowedAt],
      );
      await connection.query(
        'INSERT INTO review_write_slot(operation_id,installation_id,scheduled_at) VALUES ($1,$2,$3)',
        [operationId, String(installationId), scheduledAt],
      );
      return scheduledAt;
    });
  }

  async claimRun(identityKey, timeoutMinutes = RUN_ABANDONED_TIMEOUT_MINUTES) {
    return this.transaction(async (connection) => {
      const existing = (await connection.query(
        'SELECT state, updated_at FROM review_run WHERE identity_key = $1 FOR UPDATE',
        [identityKey],
      )).rows[0];

      if (!existing) {
        await connection.query(
          "INSERT INTO review_run(identity_key, state, created_at, updated_at) VALUES ($1, 'started', now(), now())",
          [identityKey],
        );
        return { claimed: true };
      }

      if (existing.state === 'done') {
        return { claimed: false, reason: 'done' };
      }

      if (existing.state === 'failed') {
        await connection.query(
          "UPDATE review_run SET state = 'started', updated_at = now() WHERE identity_key = $1",
          [identityKey],
        );
        return { claimed: true, reason: 'retry_failed' };
      }

      if (existing.state === 'stale') {
        await connection.query(
          "UPDATE review_run SET state = 'started', updated_at = now() WHERE identity_key = $1",
          [identityKey],
        );
        return { claimed: true, reason: 'retry_stale' };
      }

      const ageMs = Date.now() - new Date(existing.updated_at).getTime();
      if (ageMs >= timeoutMinutes * 60 * 1000) {
        await connection.query(
          "UPDATE review_run SET state = 'started', updated_at = now() WHERE identity_key = $1",
          [identityKey],
        );
        return { claimed: true, reason: 'retry_abandoned' };
      }

      return { claimed: false, reason: 'in_progress' };
    });
  }

  async markRunState(identityKey, state) {
    await this.init();
    await this.pool.query(
      `INSERT INTO review_run(identity_key, state, created_at, updated_at)
       VALUES ($1, $2, now(), now())
       ON CONFLICT (identity_key) DO UPDATE SET state = $2, updated_at = now()`,
      [identityKey, state],
    );
  }

  async markRunDone(identityKey) {
    return this.markRunState(identityKey, 'done');
  }

  async markRunStale(identityKey) {
    return this.markRunState(identityKey, 'stale');
  }

  async markRunFailed(identityKey) {
    return this.markRunState(identityKey, 'failed');
  }

  async upsertFileFacts({ repositoryId, blobSha, parserVersion, facts, parseStatus, identifiers = [] }) {
    await this.init();
    await this.pool.query(
      `INSERT INTO file_facts (repository_id, blob_sha, parser_version, facts, parse_status, indexed_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (repository_id, blob_sha, parser_version)
       DO UPDATE SET facts = EXCLUDED.facts, parse_status = EXCLUDED.parse_status, indexed_at = now()`,
      [repositoryId, blobSha, parserVersion, JSON.stringify(facts), parseStatus],
    );

    if (Array.isArray(identifiers) && identifiers.length > 0) {
      const uniqueIds = Array.from(new Set(identifiers.filter((id) => typeof id === 'string' && id.length > 0)));
      if (uniqueIds.length > 0) {
        const values = [];
        const params = [repositoryId, blobSha];
        let paramIdx = 3;
        for (const id of uniqueIds) {
          values.push(`($1, $${paramIdx++}, $2)`);
          params.push(id);
        }
        await this.pool.query(
          `INSERT INTO file_identifier_index (repository_id, identifier, blob_sha)
           VALUES ${values.join(', ')}
           ON CONFLICT DO NOTHING`,
          params,
        );
      }
    }
  }

  async getFileFacts(repositoryId, blobSha, parserVersion) {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT facts, parse_status, indexed_at
       FROM file_facts
       WHERE repository_id = $1 AND blob_sha = $2 AND parser_version = $3`,
      [repositoryId, blobSha, parserVersion],
    );
    if (!rows.length) return null;
    return {
      facts: rows[0].facts,
      parseStatus: rows[0].parse_status,
      indexedAt: rows[0].indexed_at,
    };
  }

  async batchGetFileFacts(repositoryId, blobShas, parserVersion) {
    await this.init();
    if (!Array.isArray(blobShas) || blobShas.length === 0) return new Map();
    const uniqueShas = Array.from(new Set(blobShas));
    const { rows } = await this.pool.query(
      `SELECT blob_sha, facts, parse_status, indexed_at
       FROM file_facts
       WHERE repository_id = $1 AND parser_version = $3 AND blob_sha = ANY($2::text[])`,
      [repositoryId, uniqueShas, parserVersion],
    );
    const map = new Map();
    for (const row of rows) {
      map.set(row.blob_sha, {
        facts: row.facts,
        parseStatus: row.parse_status,
        indexedAt: row.indexed_at,
      });
    }
    return map;
  }

  async findBlobShasWithIdentifiers(repositoryId, identifiers) {
    await this.init();
    if (!Array.isArray(identifiers) || identifiers.length === 0) return new Map();
    const uniqueIds = Array.from(new Set(identifiers));
    const { rows } = await this.pool.query(
      `SELECT identifier, blob_sha
       FROM file_identifier_index
       WHERE repository_id = $1 AND identifier = ANY($2::text[])`,
      [repositoryId, uniqueIds],
    );
    const result = new Map();
    for (const row of rows) {
      if (!result.has(row.identifier)) {
        result.set(row.identifier, new Set());
      }
      result.get(row.identifier).add(row.blob_sha);
    }
    return result;
  }

  async pruneOldFacts(daysOld = 30) {
    await this.init();
    const { rowCount } = await this.pool.query(
      `DELETE FROM file_facts
       WHERE indexed_at < now() - ($1 || ' days')::interval`,
      [String(Math.max(1, Number(daysOld) || 30))],
    );
    return rowCount;
  }

  async close() {
    await this.pool.end();
  }
}
