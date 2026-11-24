import { createHash } from 'node:crypto';
import ts from 'typescript';
import { buildCommitManifest, isConfigFile } from './manifest.js';
import { parseFile, isSupportedLanguageFile } from './parser.js';
import { PARSER_VERSION, RESOLVER_VERSION, IndexCoverageV3, DependencyGraphV3 } from './types.js';
import { createModuleResolver, createSymbolResolver } from './resolver.js';
import { buildGraph } from './graph.js';
import { redact } from '../review/safety.js';
import { artifactId } from '../review/analysis-store.js';

export const INDEX_LIMITS = Object.freeze({ files: 500, bytes: 5 * 1024 * 1024, edges: 10000, fileBytes: 500 * 1024 });
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cleanConfig = (file, text) => {
  const result = ts.parseConfigFileTextToJson(file, text);
  if (result.error || !result.config || typeof result.config !== 'object') return null;
  const value = result.config;
  // Store resolver metadata, never scripts, registry credentials or arbitrary config.
  const projected = file.endsWith('package.json')
    ? Object.fromEntries(['name', 'type', 'main', 'module', 'types', 'exports', 'imports', 'workspaces'].filter((key) => key in value).map((key) => [key, value[key]]))
    : Object.fromEntries(['compilerOptions', 'extends', 'references', 'files', 'include', 'exclude'].filter((key) => key in value).map((key) => [key, value[key]]));
  return redact(JSON.stringify(projected));
};

export async function parseSnapshot({ client, store, repositoryId, owner, repo, commitSha, limits: requested = {} }) {
  const limits = Object.fromEntries(Object.entries(INDEX_LIMITS).map(([key, maximum]) => [key, Math.max(0, Math.min(maximum, requested[key] ?? maximum))]));
  const discovered = await buildCommitManifest(client, { owner, repo, commitSha });
  const manifest = [...discovered.manifest.entries()].sort(([a], [b]) => a.localeCompare(b));
  const facts = [], configs = [], sizes = [], reasons = [];
  let totalBytes = 0, failed = 0, supported = 0;
  const caps = { fileCapHit: false, byteCapHit: false, edgeCapHit: false };
  const cached = store.batchGetFileFacts ? await store.batchGetFileFacts(repositoryId, manifest.map(([, sha]) => sha), PARSER_VERSION) : new Map();
  for (const [file, sha] of manifest) {
    const isSource = isSupportedLanguageFile(file);
    if (isSource && supported++ >= limits.files) { caps.fileCapHit = true; reasons.push({ path: file, reason: 'file_limit' }); continue; }
    if (!isSource && !isConfigFile(file)) continue;
    if (totalBytes >= limits.bytes) { caps.byteCapHit = true; reasons.push({ path: file, reason: 'byte_limit' }); continue; }
    let data = cached.get(sha)?.facts;
    const size = data?.fileSize;
    if (data?.path === file && data.parseStatus === 'complete' && Number.isSafeInteger(size) && size <= limits.fileBytes && totalBytes + size <= limits.bytes) {
      facts.push([file, data]); sizes.push([file, size]); totalBytes += size; continue;
    }
    try {
      const blob = (await client.rest.git.getBlob({ owner, repo, file_sha: sha })).data;
      if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error('Blob unavailable');
      if (blob.size > limits.fileBytes) { reasons.push({ path: file, reason: 'file_size_limit' }); continue; }
      if (blob.size > limits.bytes - totalBytes) { caps.byteCapHit = true; reasons.push({ path: file, reason: 'byte_limit' }); continue; }
      const buffer = Buffer.from(blob.content, 'base64');
      if (buffer.length > limits.fileBytes || buffer.includes(0)) { reasons.push({ path: file, reason: 'binary_or_oversize' }); continue; }
      if (buffer.length > limits.bytes - totalBytes) { caps.byteCapHit = true; reasons.push({ path: file, reason: 'byte_limit' }); continue; }
      totalBytes += buffer.length; sizes.push([file, buffer.length]);
      const source = buffer.toString('utf8');
      if (!isSource) {
        const projected = cleanConfig(file, source);
        if (projected === null) { reasons.push({ path: file, reason: 'config_parse_failed' }); failed++; }
        else configs.push([file, projected]);
        continue;
      }
      data = { ...await parseFile(file, source), fileSize: buffer.length };
      facts.push([file, data]);
      if (data.parseStatus !== 'complete') { failed++; reasons.push({ path: file, reason: 'parse_partial' }); }
      else if (store.upsertFileFacts) await store.upsertFileFacts({ repositoryId, blobSha: sha, parserVersion: PARSER_VERSION, facts: data, parseStatus: data.parseStatus, identifiers: data.usedIdentifiers });
    } catch (error) {
      // Permissions/rate limits must retain their original provider retry policy.
      if (error.status === 429 || error.status === 403 || error.response?.headers?.['retry-after']) throw error;
      failed++; reasons.push({ path: file, reason: 'download_or_parse_failed' });
    }
  }
  const indexed = facts.filter(([, f]) => f.parseStatus === 'complete').length;
  const totalSupported = manifest.filter(([file]) => isSupportedLanguageFile(file)).length;
  if (discovered.isPartial) reasons.push({ path: '[tree]', reason: 'tree_discovery_partial' });
  const coverage = IndexCoverageV3.parse({ status: reasons.length ? 'partial' : 'complete', indexed,
    unindexed: Math.max(0, totalSupported - indexed), failed, unsupported: discovered.unsupportedFiles || 0, totalBytes,
    truncated: discovered.isPartial || Object.values(caps).some(Boolean), reasons, limits: caps });
  return { repositoryId: String(repositoryId), commitSha, parserVersion: PARSER_VERSION, resolverVersion: RESOLVER_VERSION,
    manifest, facts, configs, sizes, configHash: digest(configs), coverage };
}

export async function persistParsedSnapshot(options) {
  const state = await options.store.getIndexState(options.repositoryId, options.commitSha);
  if (!options.limits && state?.status === 'complete' && state.parser_version === PARSER_VERSION && state.resolver_version === RESOLVER_VERSION) {
    const cached = await options.store.getIndexSnapshot(options.repositoryId, options.commitSha);
    if (cached) {
      const id = artifactId('parsed-cache', options.repositoryId, options.commitSha, PARSER_VERSION, RESOLVER_VERSION, state.config_hash);
      await options.store.putAnalysisArtifact(id, options.repositoryId, options.commitSha, options.commitSha, {
        ...cached, repositoryId: String(options.repositoryId), commitSha: options.commitSha, parserVersion: PARSER_VERSION,
        resolverVersion: RESOLVER_VERSION, configHash: state.config_hash, configs: cached.config_files });
      return { id, commitSha: options.commitSha, coverage: state.coverage };
    }
  }
  const parsed = await parseSnapshot(options);
  const id = artifactId('parsed', options.repositoryId, options.commitSha, PARSER_VERSION, RESOLVER_VERSION, parsed.configHash, parsed.coverage);
  await options.store.putAnalysisArtifact(id, options.repositoryId, options.commitSha, options.commitSha, parsed);
  return { id, commitSha: options.commitSha, coverage: parsed.coverage };
}

export function snapshotInputs(snapshot) {
  return { facts: new Map(snapshot.facts), files: new Map([...snapshot.manifest.map(([file]) => [file, '']), ...(snapshot.configs || snapshot.config_files || [])]) };
}

export async function resolveSnapshot({ store, repositoryId, parsed, owner, edgeLimit = INDEX_LIMITS.edges }) {
  edgeLimit = Math.max(0, Math.min(INDEX_LIMITS.edges, edgeLimit));
  const versionsMatch = (state) => state?.parser_version === PARSER_VERSION && state.resolver_version === RESOLVER_VERSION && state.config_hash === parsed.configHash;
  const existing = await store.getIndexState(repositoryId, parsed.commitSha);
  if (existing?.status === 'complete' && versionsMatch(existing)) return { commitSha: parsed.commitSha, reused: true, coverage: existing.coverage };
  const claim = await store.claimIndexBuild({ repositoryId, commitSha: parsed.commitSha, parserVersion: PARSER_VERSION, resolverVersion: RESOLVER_VERSION, configHash: parsed.configHash, owner });
  if (!claim.claimed) {
    const ready = await store.getIndexState(repositoryId, parsed.commitSha);
    if (ready?.status === 'complete' && versionsMatch(ready)) return { commitSha: parsed.commitSha, reused: true, coverage: ready.coverage };
    throw new Error('Index build is already in progress');
  }
  try {
    const { facts, files } = snapshotInputs(parsed);
    const resolver = createSymbolResolver({ facts, moduleResolver: createModuleResolver(files) });
    const graph = await buildGraph({ files: [...facts.keys()], loadFacts: async (file) => facts.get(file), resolver, maxEdges: edgeLimit });
    const coverage = structuredClone(parsed.coverage);
    if (graph.truncated) {
      coverage.status = 'partial'; coverage.truncated = true; coverage.limits.edgeCapHit = true;
      coverage.reasons.push({ path: '[graph]', reason: 'edge_limit' });
    }
    DependencyGraphV3.parse({ repositoryId: String(repositoryId), commitSha: parsed.commitSha, parserVersion: PARSER_VERSION, resolverVersion: RESOLVER_VERSION, edges: graph.edges, coverage });
    await store.commitIndexSnapshot({ repositoryId, commitSha: parsed.commitSha, owner, parserVersion: PARSER_VERSION,
      files: parsed.facts.map(([path, data]) => ({ path, hash: new Map(parsed.manifest).get(path), facts: data, status: data.parseStatus })),
      edges: graph.edges, coverage, manifest: parsed.manifest, configFiles: parsed.configs });
    return { commitSha: parsed.commitSha, reused: false, coverage };
  } catch (error) {
    await store.failIndexBuild(repositoryId, parsed.commitSha, owner).catch(() => {});
    throw error;
  }
}
