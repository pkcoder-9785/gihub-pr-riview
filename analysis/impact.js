import { ImpactReportV3 } from './types.js';
import { createModuleResolver, createSymbolResolver } from './resolver.js';
import { buildGraph } from './graph.js';
import { detectContractChanges } from './contracts.js';

// Compare syntax facts without treating changed line numbers as code changes.
export function detectChangedSymbols(baseFacts, headFacts) {
  const changes = [];
  const before = new Map((baseFacts?.symbols || []).map((symbol) => [`${symbol.scope}:${symbol.kind}:${symbol.name}:${symbol.symbolKey.split('#').at(-1)}`, symbol]));
  const after = new Map((headFacts?.symbols || []).map((symbol) => [`${symbol.scope}:${symbol.kind}:${symbol.name}:${symbol.symbolKey.split('#').at(-1)}`, symbol]));
  for (const [key, old] of before) {
    const current = after.get(key);
    if (!current) { changes.push({ symbolKey: old.symbolKey, changeTypes: ['removed'], baseRange: old.range, headRange: null }); continue; }
    const changeTypes = [];
    if (old.bodyFingerprint !== current.bodyFingerprint) changeTypes.push('modified');
    if (old.signatureFingerprint !== current.signatureFingerprint) changeTypes.push('signature_changed');
    if (JSON.stringify([...old.exportedNames].sort()) !== JSON.stringify([...current.exportedNames].sort())) changeTypes.push('export_changed');
    if (changeTypes.length) changes.push({ symbolKey: current.symbolKey, changeTypes, baseRange: old.range, headRange: current.range });
  }
  for (const [key, current] of after) if (!before.has(key)) changes.push({ symbolKey: current.symbolKey, changeTypes: ['added'], baseRange: null, headRange: current.range });
  const removed = changes.filter((item) => item.changeTypes.includes('removed'));
  const added = changes.filter((item) => item.changeTypes.includes('added'));
  for (const oldChange of removed) {
    const old = [...before.values()].find((symbol) => symbol.symbolKey === oldChange.symbolKey);
    const matches = added.filter((item) => {
      const symbol = [...after.values()].find((candidate) => candidate.symbolKey === item.symbolKey);
      return symbol && symbol.kind === old.kind && symbol.name !== old.name && symbol.structureFingerprint === old.structureFingerprint;
    });
    if (matches.length !== 1) continue;
    const competing = removed.filter((item) => {
      const symbol = [...before.values()].find((candidate) => candidate.symbolKey === item.symbolKey);
      return symbol && symbol.kind === old.kind && symbol.structureFingerprint === old.structureFingerprint;
    });
    if (competing.length !== 1) continue;
    const next = matches[0];
    oldChange.baseSymbolKey = oldChange.symbolKey;
    oldChange.symbolKey = next.symbolKey;
    oldChange.changeTypes = ['renamed'];
    oldChange.headRange = next.headRange;
    oldChange.confidence = 0.7;
    oldChange.reason = 'Unique matching structure with a different name';
    changes.splice(changes.indexOf(next), 1);
  }
  return changes;
}

// Inputs refer to pinned snapshots; facts and index access are injected.
export async function buildImpactReport({ baseSha, headSha, baseFacts, headFacts, baseFiles, headFiles, baseManifest, headManifest, changedPaths, store, repositoryId, hops = null, cap = 20 }) {
  cap = Math.max(0, Math.min(20, Math.trunc(cap) || 0));
  if (hops != null) hops = Math.max(0, Math.min(2, Math.trunc(hops) || 0));
  const base = baseFacts instanceof Map ? baseFacts : new Map(Object.entries(baseFacts));
  const head = headFacts instanceof Map ? headFacts : new Map(Object.entries(headFacts));
  const paths = changedPaths || [...new Set([...base.keys(), ...head.keys()])];
  const changes = [], contracts = [], otherChanges = [];
  for (const file of paths) {
    const a = base.get(file), b = head.get(file);
    for (const item of detectChangedSymbols(a, b)) {
      const partial = (a && a.parseStatus !== 'complete') || (b && b.parseStatus !== 'complete');
      changes.push({ ...item, file, baseSymbolKey: item.baseSymbolKey ?? (a?.symbols.find((symbol) => symbol.symbolKey === item.symbolKey)?.symbolKey || null), confidence: partial ? Math.min(item.confidence ?? 1, 0.5) : (item.confidence ?? 1), reason: partial ? (item.reason ? `${item.reason}; partial parse` : 'Partial parse evidence') : (item.reason ?? null) });
    }
    contracts.push(...detectContractChanges(a, b).map((item) => ({ ...item, file })));
    if (/^(?:.*\/)?(?:package\.json|tsconfig.*\.json)$/.test(file) || /(?:migration|schema|routes?)/i.test(file)) otherChanges.push({ file, reason: 'Config, route or schema file changed; review manually.' });
    const importShape = (facts) => JSON.stringify((facts?.imports || []).map(({ source, specifiers, isDynamic, kind }) => ({ source, specifiers, isDynamic, kind })));
    if (a && b && importShape(a) !== importShape(b)) otherChanges.push({ file, reason: 'Import bindings changed.' });
    for (const kind of ['env_access', 'route_registration']) {
      const count = (facts) => (facts?.riskSignals || []).filter((signal) => signal.kind === kind).length;
      if (count(a) !== count(b)) otherChanges.push({ file, reason: kind === 'env_access' ? 'Environment access changed.' : 'Possible route registration changed.' });
    }
  }
  // Pair only an unambiguous moved/renamed symbol; the old and new paths remain evidence.
  for (const removed of [...changes].filter((item) => item.changeTypes.includes('removed'))) {
    const old = base.get(removed.file)?.symbols.find((symbol) => symbol.symbolKey === removed.symbolKey);
    if (!old) continue;
    const options = changes.filter((item) => item.changeTypes.includes('added') && item.file !== removed.file).filter((item) => {
      const target = head.get(item.file)?.symbols.find((symbol) => symbol.symbolKey === item.symbolKey);
      return target && target.kind === old.kind && target.structureFingerprint === old.structureFingerprint;
    });
    if (options.length !== 1) continue;
    const next = options[0];
    const competing = changes.filter((item) => item.changeTypes.includes('removed')).filter((item) => {
      const symbol = base.get(item.file)?.symbols.find((candidate) => candidate.symbolKey === item.symbolKey);
      return symbol && symbol.kind === old.kind && symbol.structureFingerprint === old.structureFingerprint;
    });
    if (competing.length !== 1) continue;
    next.baseSymbolKey = removed.symbolKey; next.baseRange = removed.baseRange; next.changeTypes = ['renamed'];
    next.confidence = 0.7; next.reason = `Unique structural match moved from ${removed.file}`;
    changes.splice(changes.indexOf(removed), 1);
  }
  const names = [...new Set(changes.flatMap((item) => [base.get(item.file), head.get(item.file)].flatMap((f) => (f?.symbols || []).filter((s) => s.symbolKey === item.symbolKey || s.symbolKey === item.baseSymbolKey).map((s) => s.name))))];
  for (const change of changes) if (change.baseSymbolKey) for (const facts of base.values()) for (const symbol of facts.symbols) if (symbol.symbolKey === change.baseSymbolKey && !names.includes(symbol.name)) names.push(symbol.name);
  const candidateSet = new Set(paths);
  let indexAvailable = false;
  if (store?.findBlobShasWithIdentifiers && repositoryId != null && names.length) {
    const index = await store.findBlobShasWithIdentifiers(repositoryId, names);
    const shas = new Set([...index.values()].flatMap((v) => [...v]));
    for (const manifest of [baseManifest, headManifest]) if (manifest) for (const [file, sha] of manifest) if (shas.has(sha)) candidateSet.add(file);
    indexAvailable = !!(baseManifest && headManifest);
  }
  // Include known importers and barrel chains; full-scan fallback keeps missing index data conservative.
  for (const facts of [base, head]) for (const [file, f] of facts) if (!indexAvailable || f.imports.some((imp) => imp.specifiers.some((spec) => names.includes(spec.imported) || spec.imported === '*'))) candidateSet.add(file);
  for (const [facts, files] of [[base, baseFiles], [head, headFiles]]) {
    const modules = createModuleResolver(files || new Map());
    let changed = true;
    while (changed) {
      changed = false;
      for (const [file, f] of facts) {
        if (candidateSet.has(file)) continue;
        const sources = [...f.imports.map((item) => item.source), ...f.exports.map((item) => item.reexportSource).filter(Boolean)];
        if (sources.some((source) => { const result = modules.resolve(file, source); return result.status === 'resolved' && candidateSet.has(result.file); })) { candidateSet.add(file); changed = true; }
      }
    }
  }
  const candidates = [...candidateSet].sort();
  const run = async (facts, files) => {
    const resolver = createSymbolResolver({ facts, moduleResolver: createModuleResolver(files || new Map()) });
    return buildGraph({ files: candidates, loadFacts: async (file) => facts.get(file), resolver });
  };
  const [baseGraph, headGraph] = await Promise.all([run(base, baseFiles), run(head, headFiles)]);
  const affectedCallers = [], unresolved = [], seenUnresolved = new Set(), reasonCounts = {};
  const sensitive = (change) => /(?:auth|permission|payment|billing|transaction|validat|session|token)/i.test(`${change.file} ${change.symbolKey}`);
  const resolvedHops = hops ?? ((contracts.length || changes.some((change) => sensitive(change) || change.changeTypes.includes('signature_changed') || change.changeTypes.includes('export_changed'))) ? 2 : 1);
  let truncated = baseGraph.truncated || headGraph.truncated;
  for (const change of changes) {
    const removed = change.changeTypes.includes('removed');
    const renamed = change.changeTypes.includes('renamed');
    const graphTargets = removed ? [[baseGraph, change.baseSymbolKey || change.symbolKey, baseSha]] : [[headGraph, change.symbolKey, headSha]];
    if (renamed && change.baseSymbolKey) graphTargets.push([baseGraph, change.baseSymbolKey, baseSha]);
    for (const [graph, target, snapshot] of graphTargets) {
      const result = graph.getCallers(target, { hops: resolvedHops, cap });
      truncated ||= result.truncated;
      for (const edge of result.confirmed) affectedCallers.push({ graphSnapshotSha: snapshot, changedSymbolKey: change.symbolKey, callerSymbolKey: edge.callerSymbolKey ?? null, file: edge.file, line: edge.line, column: edge.column, hops: edge.hops, resolution: 'confirmed', explanation: edge.explanation, path: edge.path.map((item) => ({ file: item.file, line: item.line, column: item.column, callerSymbolKey: item.callerSymbolKey ?? null, targetSymbolKey: item.targetSymbolKey ?? null })) });
    }
  }
  for (const edge of headGraph.edges) if (edge.resolution !== 'confirmed') {
    const key = `${edge.file}:${edge.line}:${edge.column}:${edge.type}`;
    if (seenUnresolved.has(key)) continue;
    seenUnresolved.add(key);
    const reason = edge.reason || 'unsupported_syntax';
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    unresolved.push({ file: edge.file, line: edge.line, column: edge.column, resolution: edge.resolution, reason, explanation: edge.explanation ?? null });
  }
  const headCandidates = candidates.filter((file) => headManifest ? headManifest.has(file) : headFiles ? headFiles.has(file) : head.has(file));
  for (const file of headCandidates) if (!head.has(file)) {
    unresolved.push({ file, line: 1, column: 0, resolution: 'unresolved', reason: 'unindexed_target', explanation: 'Candidate facts are unavailable.' });
    reasonCounts.unindexed_target = (reasonCounts.unindexed_target || 0) + 1;
  }
  const unresolvedFileSet = new Set(unresolved.map((lead) => lead.file));
  const unresolvedFiles = headCandidates.filter((file) => unresolvedFileSet.has(file)).length;
  const resolvedFiles = headCandidates.length - unresolvedFiles;
  const manifestFiles = headManifest ? [...headManifest.keys()].filter((file) => /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file)).length : head.size;
  const parsedFiles = [...head.entries()].filter(([file, f]) => (!headManifest || headManifest.has(file)) && f.parseStatus === 'complete').length;
  const resolvedEdges = headGraph.edges.filter((edge) => edge.resolution === 'confirmed').length;
  const unresolvedEdges = unresolved.length;
  const riskHypotheses = contracts.map((c) => ({ label: 'hypothesis', file: c.file, reason: `Contract change: ${c.kind}` }));
  for (const change of changes) {
    const symbol = head.get(change.file)?.symbols.find((s) => s.symbolKey === change.symbolKey);
    const callers = affectedCallers.filter((c) => c.changedSymbolKey === change.symbolKey);
    const distinctCallers = new Set(callers.map((c) => c.callerSymbolKey || `${c.file}:${c.line}`)).size;
    const signals = [sensitive(change) ? 'sensitive flow' : null, symbol?.exportedNames.length ? 'public API' : null,
      distinctCallers ? `${distinctCallers} confirmed callers` : null,
      callers.some((c) => head.get(c.file)?.symbols.some((s) => s.symbolKey === c.callerSymbolKey && s.exportedNames.length)) ? 'exported entrypoint reachable' : null,
      callers.some((c) => /(?:test|spec)\.[cm]?[jt]sx?$/.test(c.file)) ? 'static test references present (not executed)' : 'test coverage unknown',
    ].filter(Boolean);
    if (signals.length > 1) riskHypotheses.push({ label: 'hypothesis', file: change.file, reason: signals.join('; ') });
  }
  return ImpactReportV3.parse({ changedSymbols: changes, affectedCallers, contractChanges: contracts, potentialRisks: riskHypotheses, otherChanges, unresolved, indexCoverage: { manifestFiles, parsedFiles, skippedFiles: Math.max(0, manifestFiles - parsedFiles), ratio: manifestFiles ? parsedFiles / manifestFiles : 1, isPartial: parsedFiles < manifestFiles || baseGraph.truncated || headGraph.truncated }, neighborhoodCoverage: { candidateFiles: candidates.length, resolvedFiles, unresolvedFiles, resolvedEdges, unresolvedEdges, ratio: headCandidates.length ? resolvedFiles / headCandidates.length : 1, reasonCounts }, limits: { hops: resolvedHops, callerCap: cap, truncated } });
}
