import { createHash } from 'node:crypto';

export const ANALYSIS_SCHEMA = `
CREATE TABLE IF NOT EXISTS repo_index_state (
 repository_id text NOT NULL, commit_sha text NOT NULL, parser_version text NOT NULL,
 resolver_version text NOT NULL, config_hash text NOT NULL, status text NOT NULL
 CHECK(status IN ('building','complete','partial','failed')), build_owner text,
 lease_until timestamptz, files_indexed integer NOT NULL DEFAULT 0,
 files_unindexed integer NOT NULL DEFAULT 0, files_failed integer NOT NULL DEFAULT 0,
 coverage jsonb NOT NULL DEFAULT '{}', manifest jsonb NOT NULL DEFAULT '[]',
 config_files jsonb NOT NULL DEFAULT '[]', started_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz, PRIMARY KEY(repository_id,commit_sha));
CREATE TABLE IF NOT EXISTS repo_file_symbols (
 repository_id text NOT NULL, commit_sha text NOT NULL, file_path text NOT NULL,
 file_hash text NOT NULL, parser_version text NOT NULL, symbols jsonb NOT NULL,
 parse_status text NOT NULL, indexed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(repository_id,commit_sha,file_path));
CREATE INDEX IF NOT EXISTS repo_symbols_hash_idx ON repo_file_symbols(repository_id,file_hash,parser_version);
CREATE TABLE IF NOT EXISTS repo_dependency_edges (
 repository_id text NOT NULL, commit_sha text NOT NULL, edge_key text NOT NULL,
 edge_type text NOT NULL, resolution text NOT NULL, source_file text NOT NULL,
 source_symbol_key text NOT NULL DEFAULT '', call_start_byte text, call_line integer,
 target_file text NOT NULL DEFAULT '', target_symbol_key text NOT NULL DEFAULT '',
 target_name text NOT NULL DEFAULT '', evidence jsonb NOT NULL,
 PRIMARY KEY(repository_id,commit_sha,edge_key));
CREATE INDEX IF NOT EXISTS repo_edges_callee_idx ON repo_dependency_edges(repository_id,commit_sha,target_symbol_key,resolution);
CREATE INDEX IF NOT EXISTS repo_edges_caller_idx ON repo_dependency_edges(repository_id,commit_sha,source_file,source_symbol_key);
CREATE TABLE IF NOT EXISTS review_analysis_artifact (
 id text PRIMARY KEY, repository_id text NOT NULL, base_sha text NOT NULL,
 head_sha text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS review_v3_budget (
 period text NOT NULL, scope text NOT NULL, tokens bigint NOT NULL DEFAULT 0,
 cost_micros bigint NOT NULL DEFAULT 0, PRIMARY KEY(period,scope));
CREATE TABLE IF NOT EXISTS review_v3_reservation (
 id text PRIMARY KEY, status text NOT NULL, tokens bigint NOT NULL, cost_micros bigint NOT NULL,
 scopes jsonb NOT NULL, result jsonb, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS review_v3_metrics (
 id text PRIMARY KEY, repository_id text NOT NULL, commit_sha text NOT NULL,
 metrics jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS review_finding_state (
 repository_id text NOT NULL, pr_number integer NOT NULL, fingerprint text NOT NULL,
 head_sha text NOT NULL, publication_id text NOT NULL, state text NOT NULL,
 finding jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(repository_id,pr_number,fingerprint,head_sha));
`;

// All new storage is append-only relative to the pre-V3 schema. Transactions use
// the existing shared advisory lock, including money/token reservations together.
export class AnalysisStore {
  async getIndexState(repositoryId, commitSha) {
    await this.init();
    return (await this.pool.query('SELECT * FROM repo_index_state WHERE repository_id=$1 AND commit_sha=$2', [String(repositoryId), commitSha])).rows[0] || null;
  }

  async claimIndexBuild({ repositoryId, commitSha, parserVersion, resolverVersion, configHash, owner }) {
    return this.transaction(async (c) => {
      const params = [String(repositoryId), commitSha, parserVersion, resolverVersion, configHash, owner];
      const result = await c.query(`INSERT INTO repo_index_state
        (repository_id,commit_sha,parser_version,resolver_version,config_hash,status,build_owner,lease_until)
        VALUES($1,$2,$3,$4,$5,'building',$6,now()+interval '10 minutes')
        ON CONFLICT(repository_id,commit_sha) DO UPDATE SET parser_version=$3,resolver_version=$4,
        config_hash=$5,status='building',build_owner=$6,lease_until=now()+interval '10 minutes',completed_at=NULL
        WHERE (repo_index_state.status <> 'building' OR repo_index_state.lease_until < now())
        AND (repo_index_state.status <> 'complete' OR repo_index_state.parser_version<>$3
          OR repo_index_state.resolver_version<>$4 OR repo_index_state.config_hash<>$5)
        RETURNING build_owner`, params);
      return { claimed: result.rows.length === 1 };
    });
  }

  async commitIndexSnapshot({ repositoryId, commitSha, owner, parserVersion, files, edges, coverage, manifest, configFiles }) {
    return this.transaction(async (c) => {
      const key = [String(repositoryId), commitSha];
      const claim = (await c.query(`SELECT build_owner FROM repo_index_state WHERE repository_id=$1 AND commit_sha=$2
        AND status='building' AND build_owner=$3 AND lease_until>now() FOR UPDATE`, [...key, owner])).rows[0];
      if (!claim) throw new Error('Index build ownership lost');
      // Replace the whole coherent snapshot: failure rolls back rows and status.
      await c.query('DELETE FROM repo_dependency_edges WHERE repository_id=$1 AND commit_sha=$2', key);
      await c.query('DELETE FROM repo_file_symbols WHERE repository_id=$1 AND commit_sha=$2', key);
      await c.query(`INSERT INTO repo_file_symbols(repository_id,commit_sha,file_path,file_hash,parser_version,symbols,parse_status)
        SELECT $1,$2,x.path,x.hash,$3,x.facts,x.status FROM jsonb_to_recordset($4::jsonb)
        AS x(path text,hash text,facts jsonb,status text)`, [...key, parserVersion, JSON.stringify(files)]);
      await this.insertAnalysisEdges(c, key, edges);
      await c.query(`UPDATE repo_index_state SET status=$3,coverage=$4,manifest=$5,config_files=$6,
        files_indexed=$7,files_unindexed=$8,files_failed=$9,completed_at=now(),lease_until=NULL
        WHERE repository_id=$1 AND commit_sha=$2`, [...key, coverage.status, JSON.stringify(coverage), JSON.stringify(manifest), JSON.stringify(configFiles), coverage.indexed, coverage.unindexed, coverage.failed]);
      return { status: coverage.status };
    });
  }

  async insertAnalysisEdges(c, key, edges) {
    await c.query(`INSERT INTO repo_dependency_edges(repository_id,commit_sha,edge_key,edge_type,resolution,source_file,
      source_symbol_key,call_start_byte,call_line,target_file,target_symbol_key,target_name,evidence)
      SELECT $1,$2,x->>'edge_key',x->>'type',x->>'resolution',x->>'file',COALESCE(x->>'callerSymbolKey',''),x->>'byteOffset',(x->>'line')::integer,
        COALESCE(x->'target'->>'file',''),COALESCE(x->>'targetSymbolKey',''),COALESCE(x->'target'->'symbol'->>'name',''),x
      FROM jsonb_array_elements($3::jsonb) AS t(x)
      ON CONFLICT(repository_id,commit_sha,edge_key) DO UPDATE SET evidence=EXCLUDED.evidence`, [...key, JSON.stringify(edges)]);
  }

  async failIndexBuild(repositoryId, commitSha, owner) {
    await this.init();
    await this.pool.query(`UPDATE repo_index_state SET status='failed',lease_until=NULL WHERE repository_id=$1 AND commit_sha=$2
      AND build_owner=$3 AND status='building'`, [String(repositoryId), commitSha, owner]);
  }

  async getIndexSnapshot(repositoryId, commitSha) {
    await this.init();
    // One MVCC statement prevents a reader mixing state/edges from different builds.
    const row = (await this.pool.query(`SELECT s.*,
      COALESCE((SELECT jsonb_agg(jsonb_build_array(f.file_path,f.symbols)) FROM repo_file_symbols f
        WHERE f.repository_id=s.repository_id AND f.commit_sha=s.commit_sha),'[]') AS facts,
      COALESCE((SELECT jsonb_agg(e.evidence) FROM repo_dependency_edges e
        WHERE e.repository_id=s.repository_id AND e.commit_sha=s.commit_sha),'[]') AS edges
      FROM repo_index_state s WHERE s.repository_id=$1 AND s.commit_sha=$2 AND s.status IN ('complete','partial')`, [String(repositoryId), commitSha])).rows[0];
    return row || null;
  }

  async getFileSymbolsByHash(repositoryId, fileHash, parserVersion, filePath) {
    await this.init();
    const row = (await this.pool.query(`SELECT symbols FROM repo_file_symbols WHERE repository_id=$1 AND file_hash=$2
      AND parser_version=$3 AND file_path=$4 ORDER BY indexed_at DESC LIMIT 1`, [String(repositoryId), fileHash, parserVersion, filePath])).rows[0];
    return row?.symbols || null;
  }

  async replaceEdgesForSourceFiles(repositoryId, commitSha, sourceFiles, edges) {
    return this.transaction(async (c) => {
      const key = [String(repositoryId), commitSha];
      const state = (await c.query('SELECT status FROM repo_index_state WHERE repository_id=$1 AND commit_sha=$2 FOR UPDATE', key)).rows[0];
      if (!state || state.status === 'building') throw new Error('Cannot replace uncommitted edges');
      await c.query('DELETE FROM repo_dependency_edges WHERE repository_id=$1 AND commit_sha=$2 AND source_file=ANY($3)', [...key, sourceFiles]);
      if (edges.some((edge) => !sourceFiles.includes(edge.file))) throw new Error('Invalid replacement source');
      await this.insertAnalysisEdges(c, key, edges);
    });
  }

  async findReverseImporters(repositoryId, commitSha, targetFile, limit = 500) {
    await this.init();
    return (await this.pool.query(`SELECT DISTINCT source_file FROM repo_dependency_edges WHERE repository_id=$1 AND commit_sha=$2
      AND target_file=$3 AND edge_type IN ('import','file_import','reexport') ORDER BY source_file LIMIT $4`, [String(repositoryId), commitSha, targetFile, Math.min(500, Math.max(1, limit))])).rows.map((row) => row.source_file);
  }

  async getConfirmedCallers(repositoryId, commitSha, symbolKey, limit = 20) {
    await this.init();
    return (await this.pool.query(`SELECT evidence FROM repo_dependency_edges WHERE repository_id=$1 AND commit_sha=$2
      AND target_symbol_key=$3 AND edge_type='direct_call' AND resolution='confirmed' ORDER BY edge_key LIMIT $4`, [String(repositoryId), commitSha, symbolKey, Math.min(21, Math.max(1, limit))])).rows.map((row) => row.evidence);
  }

  async getCallersRecursive(repositoryId, commitSha, symbolKey, { depth = 1, limit = 20 } = {}) {
    const { createGraph } = await import('../analysis/graph.js');
    const snapshot = await this.getIndexSnapshot(repositoryId, commitSha);
    return createGraph(snapshot?.edges || []).getCallers(symbolKey, { hops: depth, cap: limit });
  }

  async getCoverage(repositoryId, commitSha) { return (await this.getIndexState(repositoryId, commitSha))?.coverage || null; }

  async putAnalysisArtifact(id, repositoryId, baseSha, headSha, payload) {
    await this.init();
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded) > 25 * 1024 * 1024) throw new Error('Analysis artifact limit exceeded');
    await this.pool.query(`INSERT INTO review_analysis_artifact(id,repository_id,base_sha,head_sha,payload)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,created_at=now()`, [id, String(repositoryId), baseSha, headSha, encoded]);
    return { id };
  }

  async getAnalysisArtifact(id, repositoryId, baseSha, headSha) {
    await this.init();
    const row = (await this.pool.query(`SELECT payload FROM review_analysis_artifact WHERE id=$1 AND repository_id=$2
      AND base_sha=$3 AND head_sha=$4`, [id, String(repositoryId), baseSha, headSha])).rows[0];
    if (!row) throw new Error('Analysis artifact unavailable');
    return row.payload;
  }

  async pruneOldIndexSnapshots(repositoryId, days = 30) {
    return this.transaction(async (c) => {
      const params = [String(repositoryId), Math.max(1, days)];
      for (const table of ['repo_dependency_edges', 'repo_file_symbols']) {
        await c.query(`DELETE FROM ${table} d USING repo_index_state s WHERE d.repository_id=s.repository_id AND d.commit_sha=s.commit_sha
          AND s.repository_id=$1 AND s.status<>'building' AND s.completed_at<now()-($2 * interval '1 day')`, params);
      }
      await c.query(`DELETE FROM repo_index_state WHERE repository_id=$1 AND status<>'building' AND completed_at<now()-($2 * interval '1 day')`, params);
      await c.query(`DELETE FROM review_analysis_artifact WHERE repository_id=$1 AND created_at<now()-($2 * interval '1 day')`, params);
    });
  }

  async reserveAgentBudget(id, scopes, tokens, costMicros) {
    if (![tokens, costMicros].every((v) => Number.isSafeInteger(v) && v >= 0)) throw new TypeError('Invalid agent reservation');
    return this.transaction(async (c) => {
      const existing = (await c.query('SELECT * FROM review_v3_reservation WHERE id=$1', [id])).rows[0];
      if (existing && !(existing.status === 'accounted' && !existing.result && Number(existing.tokens) === 0 && Number(existing.cost_micros) === 0)) return { reserved: false, reason: existing.status, result: existing.result };
      if (existing) await c.query('DELETE FROM review_v3_reservation WHERE id=$1', [id]);
      for (const scope of scopes) {
        if (scope.legacyScope) {
          await c.query('INSERT INTO review_budget(day,scope) VALUES($1::date,$2) ON CONFLICT DO NOTHING', [scope.period, scope.legacyScope]);
          const legacy = (await c.query('SELECT used FROM review_budget WHERE day=$1::date AND scope=$2 FOR UPDATE', [scope.period, scope.legacyScope])).rows[0];
          if (Number(legacy.used) + tokens > scope.tokens) return { reserved: false, reason: 'limit' };
        }
        await c.query('INSERT INTO review_v3_budget(period,scope) VALUES($1,$2) ON CONFLICT DO NOTHING', [scope.period, scope.name]);
        const row = (await c.query('SELECT tokens,cost_micros FROM review_v3_budget WHERE period=$1 AND scope=$2 FOR UPDATE', [scope.period, scope.name])).rows[0];
        if (Number(row.tokens) + tokens > scope.tokens || Number(row.cost_micros) + costMicros > scope.costMicros) return { reserved: false, reason: 'limit' };
      }
      for (const scope of scopes) {
        await c.query('UPDATE review_v3_budget SET tokens=tokens+$3,cost_micros=cost_micros+$4 WHERE period=$1 AND scope=$2', [scope.period, scope.name, tokens, costMicros]);
        if (scope.legacyScope) await c.query('UPDATE review_budget SET used=used+$3 WHERE day=$1::date AND scope=$2', [scope.period, scope.legacyScope, tokens]);
      }
      await c.query("INSERT INTO review_v3_reservation(id,status,tokens,cost_micros,scopes) VALUES($1,'reserved',$2,$3,$4)", [id, tokens, costMicros, JSON.stringify(scopes)]);
      return { reserved: true };
    });
  }

  async settleAgentBudget(id, tokens, costMicros, result, unknown = false) {
    return this.transaction(async (c) => {
      const row = (await c.query('SELECT * FROM review_v3_reservation WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!row || row.status !== 'reserved') return;
      if (!unknown) {
        if (![tokens, costMicros].every((v) => Number.isSafeInteger(v) && v >= 0)) throw new TypeError('Invalid actual agent usage');
        for (const scope of row.scopes) {
          await c.query(`UPDATE review_v3_budget SET tokens=GREATEST(0,tokens+$3),cost_micros=GREATEST(0,cost_micros+$4)
            WHERE period=$1 AND scope=$2`, [scope.period, scope.name, tokens - Number(row.tokens), costMicros - Number(row.cost_micros)]);
          if (scope.legacyScope) await c.query('UPDATE review_budget SET used=GREATEST(0,used+$3) WHERE day=$1::date AND scope=$2', [scope.period, scope.legacyScope, tokens - Number(row.tokens)]);
        }
      }
      await c.query('UPDATE review_v3_reservation SET status=$2,result=$3,tokens=$4,cost_micros=$5,updated_at=now() WHERE id=$1', [id, unknown ? 'unknown' : 'accounted', result ? JSON.stringify(result) : null, unknown ? Number(row.tokens) : tokens, unknown ? Number(row.cost_micros) : costMicros]);
    });
  }

  async recordAnalysisMetrics(id, repositoryId, commitSha, metrics) {
    await this.init();
    await this.pool.query(`INSERT INTO review_v3_metrics(id,repository_id,commit_sha,metrics) VALUES($1,$2,$3,$4)
      ON CONFLICT(id) DO NOTHING`, [id, String(repositoryId), commitSha, JSON.stringify(metrics)]);
  }

  async getPriorFindings(repositoryId, prNumber) {
    await this.init();
    return (await this.pool.query(`SELECT DISTINCT ON (f.fingerprint) f.* FROM review_finding_state f
      JOIN review_publication p ON p.id=f.publication_id AND p.status='published'
      WHERE f.repository_id=$1 AND f.pr_number=$2 ORDER BY f.fingerprint,f.updated_at DESC LIMIT 100`, [String(repositoryId), prNumber])).rows;
  }

  async saveFindingStates(repositoryId, prNumber, headSha, publicationId, findings) {
    return this.transaction(async (c) => {
      for (const finding of findings) await c.query(`INSERT INTO review_finding_state(repository_id,pr_number,fingerprint,head_sha,publication_id,state,finding)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(repository_id,pr_number,fingerprint,head_sha)
        DO UPDATE SET publication_id=$5,state=$6,finding=$7,updated_at=now()`, [String(repositoryId), prNumber, finding.fingerprint, headSha, publicationId, finding.state, JSON.stringify(finding)]);
    });
  }
}

export const artifactId = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
