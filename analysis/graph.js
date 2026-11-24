import { createHash } from 'node:crypto';

// References, JSX and inheritance are useful leads, never proof of invocation.
const callerTypes = new Set(['direct_call']);
export function edgeKey(edge) {
  return createHash('sha256').update(JSON.stringify([edge.type, edge.file, edge.callerSymbolKey, edge.byteOffset, edge.targetSymbolKey])).digest('hex');
}

export function createGraph(edges = []) {
  const items = edges.map((edge) => ({ ...edge, edge_key: edgeKey(edge) }));
  return {
    edges: items,
    getImporters(targetSymbolKey) { return items.filter((e) => ['import', 'reexport'].includes(e.type) && e.targetSymbolKey === targetSymbolKey); },
    getCallers(changedSymbolKey, { hops = 1, cap = 20 } = {}) {
      hops = Math.max(0, Math.min(2, Math.trunc(hops) || 0));
      cap = Math.max(0, Math.min(20, Math.trunc(cap) || 0));
      const confirmed = [], leads = [];
      let truncated = false;
      const queue = [{ target: changedSymbolKey, depth: 0, path: [] }];
      const visited = new Set([changedSymbolKey]);
      while (queue.length) {
        const current = queue.shift();
        if (current.depth >= hops) continue;
        for (const edge of items.filter((e) => callerTypes.has(e.type) && e.targetSymbolKey === current.target)) {
          const path = [edge, ...current.path];
          if (edge.resolution !== 'confirmed') { leads.push({ ...edge, path }); continue; }
          if (confirmed.length >= cap) { truncated = true; continue; }
          confirmed.push({ ...edge, hops: current.depth + 1, path });
          if (edge.callerSymbolKey && !visited.has(edge.callerSymbolKey)) {
            visited.add(edge.callerSymbolKey);
            queue.push({ target: edge.callerSymbolKey, depth: current.depth + 1, path });
          }
        }
      }
      return { confirmed, leads, truncated };
    },
  };
}

export async function buildGraph({ files, loadFacts, resolver, maxEdges = 10000 }) {
  const edges = [];
  let truncated = false;
  // Stop extraction at the cap, rather than merely slicing an unbounded graph.
  const append = edges.push.bind(edges);
  edges.push = (...items) => {
    for (const item of items) {
      if (edges.length >= maxEdges) { truncated = true; return edges.length; }
      append(item);
    }
    return edges.length;
  };
  for (const file of files) {
    if (truncated) break;
    const f = await loadFacts(file);
    if (!f) continue;
    const sites = [
      ...f.callSites.map((site) => ({ type: 'direct_call', site })),
      ...f.jsxUsages.map((site) => ({ type: 'jsx_use', site: { ...site, calleeName: site.elementName } })),
      ...f.valueReferences.map((site) => ({ type: 'value_ref', site: { ...site, calleeName: site.identifier } })),
    ];
    for (const { type, site } of sites) {
      if (truncated) break;
      const resolved = resolver.resolve(file, site);
      edges.push({ type, file, callerSymbolKey: site.enclosingSymbolKey, byteOffset: site.byteOffset ?? `${site.range.start.line}:${site.range.start.column}`, line: site.range.start.line, column: site.range.start.column, targetSymbolKey: resolved.target?.symbol.symbolKey ?? null, ...resolved });
    }
    for (const imp of f.imports.filter((item) => !item.isDynamic)) {
      for (const spec of imp.specifiers.filter((item) => !item.isTypeOnly)) {
        const cjsUnsafe = imp.kind === 'cjs' && (!imp.isTopLevel || f.symbols.some((symbol) => symbol.name === 'require') || f.uncertainBindings.includes('require'));
        const result = cjsUnsafe ? { resolution: 'unresolved', reason: 'unsupported_syntax', candidates: [] } : resolver.resolveImport(file, imp.source, spec.imported);
        edges.push({ type: 'import', file, callerSymbolKey: null, byteOffset: `${imp.byteOffset ?? `${imp.range.start.line}:${imp.range.start.column}`}:${spec.local}`, line: imp.range.start.line, column: imp.range.start.column, targetSymbolKey: result.target?.symbol.symbolKey ?? null, ...result });
      }
    }
    for (const exp of f.exports.filter((item) => item.reexportSource && !item.isTypeOnly)) {
      for (const { name, result } of resolver.resolveReexports(file, exp)) {
        edges.push({ type: 'reexport', file, callerSymbolKey: null, byteOffset: `${exp.byteOffset ?? `${exp.range.start.line}:${exp.range.start.column}`}:${name}`, line: exp.range.start.line, column: exp.range.start.column, targetSymbolKey: result.target?.symbol.symbolKey ?? null, ...result });
      }
    }
    for (const heritage of f.extendsImplements) {
      const owner = f.symbols.find((symbol) => symbol.symbolKey === heritage.classSymbolKey);
      if (!owner) continue;
      const resolved = resolver.resolve(file, { calleeName: heritage.targetName, byteOffset: owner.byteOffset, enclosingSymbolKey: owner.enclosingSymbolKey, confidence: owner.confidence });
      edges.push({ type: 'extends', file, callerSymbolKey: owner.symbolKey, byteOffset: owner.byteOffset, line: owner.range.start.line, column: owner.range.start.column, targetSymbolKey: resolved.target?.symbol.symbolKey ?? null, ...resolved });
    }
  }
  // Fail closed if a resolver ever emits a confirmed edge without exactly one
  // matching target and an evidence chain. This applies to every fixture and
  // caller using buildGraph, rather than only to hand-picked examples.
  for (const edge of edges) {
    if (edge.resolution !== 'confirmed') continue;
    const valid = edge.targetSymbolKey && edge.candidates?.length === 1 && edge.candidates[0].symbol?.symbolKey === edge.targetSymbolKey && typeof edge.explanation === 'string' && edge.explanation.includes(edge.targetSymbolKey);
    if (!valid) { edge.resolution = 'unresolved'; edge.reason = 'unsupported_syntax'; edge.targetSymbolKey = null; }
  }
  return { ...createGraph(edges), truncated };
}
