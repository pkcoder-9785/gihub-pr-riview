import { collectContext } from './context.js';
import { optedOut } from '../github/webhook.js';
import { sameSnapshot, sanitize } from './safety.js';
import { findReview } from './publish.js';
import { persistParsedSnapshot, resolveSnapshot, snapshotInputs, INDEX_LIMITS } from '../analysis/indexer.js';
import { buildImpactReport } from '../analysis/impact.js';
import { PARSER_VERSION, RESOLVER_VERSION } from '../analysis/types.js';
import { buildEvidencePacket } from './evidence.js';
import { runAgent } from './agents.js';
import { verifyFindings } from './verify.js';
import { artifactId } from './analysis-store.js';
import { recordMetrics } from './metrics.js';

class StaleSnapshot extends Error {}

export async function runV3Review({ step, client, store, config, data, args, snapshot, reviewId, runId, getAI }) {
  const start = Date.now();
  let apiReads = 0;
  const isFresh = async () => {
    apiReads++;
    const pr = (await client.rest.pulls.get(args)).data;
    return !config.review.killSwitch && !optedOut(pr, config.github.botAuthorAllowlist) && sameSnapshot(pr, snapshot);
  };
  const fresh = async () => { if (!await isFresh()) throw new StaleSnapshot(); };
  const collect = async () => {
    await fresh();
    apiReads++;
    const pr = (await client.rest.pulls.get(args)).data;
    const context = await collectContext(client, args, snapshot, config.review, { model: config.openai.model, pullRequest: pr });
    await fresh();
    return context;
  };
  const metadata = (context) => ({
    files: context.files.map(({ path, previousPath, contextMissing, redacted, omittedHunks }) => ({ path: path.slice(0, 1024), previousPath: previousPath?.slice(0, 1024) ?? null, contextMissing, redacted, omittedHunks })),
    skipped: context.skipped.slice(0, 300).map(({ path, reason }) => ({ path: String(path).slice(0, 1024), reason: String(reason).slice(0, 80) })),
    skippedCount: context.skipped.length, partial: context.partial,
  });
  const readArtifact = (ref, base = snapshot.base, head = snapshot.head) => store.getAnalysisArtifact(ref.id, data.repositoryId, base, head);
  try {
    const contextRef = await step.run('collect-context', async () => {
      await fresh();
      if (await findReview(client, args, `<!-- ai-review:${reviewId} -->`, snapshot.botId)) return { alreadyPublished: true };
      const context = await collect();
      const id = artifactId('context', runId, reviewId);
      await store.putAnalysisArtifact(id, data.repositoryId, snapshot.base, snapshot.head, { coverage: metadata(context),
        changedPaths: [...new Set(context.files.flatMap((file) => [file.path, file.previousPath].filter(Boolean)))] });
      return { id };
    });
    if (contextRef.alreadyPublished) return { status: 'already_published' };
    const collected = await readArtifact(contextRef);
    if (!collected.coverage.files.length) return { status: 'complete', findings: [], fileChanges: [], summary: 'No reviewable diff; three-agent analysis was skipped.', coverage: collected.coverage, usage: 0 };
    const parse = (commitSha) => persistParsedSnapshot({ client, store, repositoryId: data.repositoryId, owner: data.owner, repo: data.repo, commitSha });
    // Independent durable work. Only references/counts leave each step; no raw source.
    const [baseRef, headRef] = await Promise.all([
      step.run('ast-parse-base', async () => { await fresh(); return parse(snapshot.base); }),
      step.run('ast-parse-head', async () => { await fresh(); return parse(snapshot.head); }),
    ]);
    const resolve = async (ref) => {
      await fresh();
      const parsed = await readArtifact(ref, ref.commitSha, ref.commitSha);
      return resolveSnapshot({ store, repositoryId: data.repositoryId, parsed, owner: `${runId}:${ref.commitSha}` });
    };
    await step.run('resolve-index-base', () => resolve(baseRef));
    await step.run('resolve-index-head', () => resolve(headRef));
    const impactRef = await step.run('impact-analysis', async () => {
      await fresh();
      const base = await store.getIndexSnapshot(data.repositoryId, snapshot.base), head = await store.getIndexSnapshot(data.repositoryId, snapshot.head);
      if (!base || !head || [base, head].some((s) => s.parser_version !== PARSER_VERSION || s.resolver_version !== RESOLVER_VERSION)) throw new Error('Compatible pinned index unavailable');
      const a = snapshotInputs(base), b = snapshotInputs(head);
      const impact = await buildImpactReport({ baseSha: snapshot.base, headSha: snapshot.head, baseFacts: a.facts, headFacts: b.facts,
        baseFiles: a.files, headFiles: b.files, baseManifest: new Map(base.manifest), headManifest: new Map(head.manifest),
        changedPaths: collected.changedPaths, store, repositoryId: data.repositoryId });
      const indexPartial = [base.coverage, head.coverage].some((c) => c.status !== 'complete');
      impact.indexCoverage.isPartial ||= indexPartial;
      impact.limits.truncated ||= [base.coverage, head.coverage].some((c) => c.truncated);
      const id = artifactId('impact', runId, reviewId);
      await store.putAnalysisArtifact(id, data.repositoryId, snapshot.base, snapshot.head, { impact });
      return { id };
    });
    const loadPacket = async () => {
      const { impact } = await readArtifact(impactRef);
      const base = await store.getIndexSnapshot(data.repositoryId, snapshot.base), head = await store.getIndexSnapshot(data.repositoryId, snapshot.head);
      if (!base || !head) throw new Error('Pinned analysis snapshot unavailable');
      const fetched = new Map();
      const fetchFile = async (file, sha) => {
        const manifest = new Map(sha === snapshot.head ? head.manifest : base.manifest);
        if (!manifest.has(file)) return null;
        const key = `${sha}:${file}`;
        if (!fetched.has(key)) {
          apiReads++;
          const blob = (await client.rest.git.getBlob({ owner: data.owner, repo: data.repo, file_sha: manifest.get(file) })).data;
          if (blob.encoding !== 'base64' || blob.size > INDEX_LIMITS.fileBytes) return null;
          const buffer = Buffer.from(blob.content || '', 'base64');
          if (buffer.length > INDEX_LIMITS.fileBytes || buffer.includes(0)) return null;
          fetched.set(key, buffer.toString('utf8'));
        }
        return fetched.get(key);
      };
      return buildEvidencePacket({ context: await collect(), impact, snapshot, fetchFile, baseFacts: new Map(base.facts), headFacts: new Map(head.facts) });
    };
    const executeAgent = async (role, previousResults = []) => {
      const packet = await loadPacket();
      const priorFindings = role === 'architecture' ? await store.getPriorFindings(data.repositoryId, data.prNumber) : [];
      const client = getAI(config.openai);
      const countInput = config.review.v3.astraSonnet
        ? async ({ model, instructions, input, text, reasoning }) => {
          const result = await client.responses.inputTokens.count(
            { model, instructions, input, text, reasoning },
            { timeout: config.review.v3.timeoutMs },
          );
          return result.input_tokens;
        }
        : undefined;
      return runAgent({ client, countInput, store, config, data, snapshot, runId, role, packet, previousResults, priorFindings, isFresh });
    };
    const reviewerRoles = config.review.v3.astraSonnet
      ? ['security-logic']
      : ['context-dependency', 'security-logic'];
    const first = await Promise.all(reviewerRoles.map((role) =>
      step.run(`${role}-agent`, () => executeAgent(role))));
    if (first.some((result) => result.status === 'skipped_stale')) return { status: 'skipped_stale' };
    if (first.some((result) => result.status !== 'complete')) return { status: 'incomplete', coverage: collected.coverage };
    const architecture = await step.run('architecture-agent', () => executeAgent('architecture', first));
    if (architecture.status !== 'complete') return { status: architecture.status, coverage: collected.coverage };
    const aggregateRef = await step.run('aggregate', async () => {
      const id = artifactId('candidates', runId, reviewId);
      await store.putAnalysisArtifact(id, data.repositoryId, snapshot.base, snapshot.head, {
        candidates: config.review.v3.astraSonnet
          ? architecture.candidates
          : [...first, architecture].flatMap((result) => result.candidates),
        revisions: architecture.revisions,
        summary: config.review.v3.astraSonnet
          ? 'Astra verified findings from the Sol reviewer.'
          : sanitize(first[0].summary || 'Three-agent review completed.'),
        partial: [...first, architecture].some((result) => result.partial),
        usage: [...first, architecture].every((r) => r.usage) ? [...first, architecture].reduce((sum, r) => sum + r.usage.tokens, 0) : null,
      });
      return { id };
    });
    const verifiedRef = await step.run('verify', async () => {
      await fresh();
      const packet = await loadPacket(), aggregated = await readArtifact(aggregateRef);
      const prior = await store.getPriorFindings(data.repositoryId, data.prNumber);
      const verified = verifyFindings({ candidates: aggregated.candidates, packet, priorFindings: prior, revisions: aggregated.revisions, maxFindings: config.review.maxFindings });
      const id = artifactId('verified', runId, reviewId);
      const coverage = { ...collected.coverage, partial: collected.coverage.partial || aggregated.partial || packet.coverage.partial };
      const result = { status: 'complete', summary: `${aggregated.summary}\n${coverage.partial ? 'Analysis is partial.' : 'Available analysis completed.'} ${verified.states.filter((s) => ['changed', 'still_present'].includes(s.state)).length} previously reported findings tracked without reposting.`,
        findings: verified.findings, fileChanges: [], usage: aggregated.usage, coverage };
      await store.saveFindingStates(data.repositoryId, data.prNumber, snapshot.head, reviewId, verified.states);
      await store.putAnalysisArtifact(id, data.repositoryId, snapshot.base, snapshot.head, result);
      await recordMetrics(store, `${runId}:verification`, data.repositoryId, snapshot.head, { stage: 'verify', status: 'complete',
        candidates: aggregated.candidates.length, accepted: verified.findings.length, rejected: verified.rejected.length, partial: coverage.partial });
      return { id };
    });
    await step.run('record-metrics', () => recordMetrics(store, `${runId}:analysis`, data.repositoryId, snapshot.head, {
      stage: 'analysis', status: 'complete', durationMs: Date.now() - start, apiReads,
      indexedFiles: headRef.coverage.indexed, unindexedFiles: headRef.coverage.unindexed,
      partial: headRef.coverage.status !== 'complete',
    }));
    await fresh();
    return readArtifact(verifiedRef);
  } catch (error) {
    if (error instanceof StaleSnapshot) return { status: 'skipped_stale' };
    throw error;
  }
}
