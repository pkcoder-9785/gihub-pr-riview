import path from 'node:path';
import ts from 'typescript';

// The host exposes only the supplied snapshot. No source is executed and the
// TypeScript resolver cannot read the process filesystem.
export function createModuleResolver(files, { configPath = '/tsconfig.json' } = {}) {
  const entries = new Map([...files].map(([name, content]) => [path.posix.resolve('/', name), content]));
  // Expose snapshot workspace packages through virtual node_modules aliases.
  // The actual lookup and package exports rules remain TypeScript's resolver.
  const aliases = [];
  let workspaces = [];
  try { const config = JSON.parse(entries.get('/package.json') || '{}'); workspaces = Array.isArray(config.workspaces) ? config.workspaces : (config.workspaces?.packages || []); } catch { /* No verified workspaces. */ }
  for (const [file, content] of entries) {
    if (!file.endsWith('/package.json') || file.includes('/node_modules/')) continue;
    try {
      const pkg = JSON.parse(content);
      const target = path.posix.dirname(file);
      const relative = target.slice(1);
      const listed = typeof path.matchesGlob === 'function' && workspaces.some((pattern) => typeof pattern === 'string' && path.matchesGlob(relative, pattern));
      if (listed && typeof pkg.name === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(pkg.name)) aliases.push({ alias: `/node_modules/${pkg.name}`, target });
    } catch { /* malformed packages are not eligible as workspace aliases */ }
  }
  for (let index = aliases.length - 1; index >= 0; index--) if (aliases.some((other, n) => n !== index && other.alias === aliases[index].alias)) { const duplicate = aliases[index].alias; for (let n = aliases.length - 1; n >= 0; n--) if (aliases[n].alias === duplicate) aliases.splice(n, 1); }
  const resolveAlias = (name) => {
    const clean = path.posix.resolve('/', name);
    const entry = aliases.find(({ alias }) => clean === alias || clean.startsWith(`${alias}/`));
    return entry ? entry.target + clean.slice(entry.alias.length) : clean;
  };
  const virtualNames = [...entries.keys()];
  for (const { alias, target } of aliases) for (const file of entries.keys()) if (file.startsWith(`${target}/`)) virtualNames.push(alias + file.slice(target.length));
  const directories = new Set(['/']);
  for (const name of virtualNames) {
    let dir = path.posix.dirname(name);
    while (!directories.has(dir)) { directories.add(dir); dir = path.posix.dirname(dir); }
  }
  const host = {
    fileExists: (name) => entries.has(resolveAlias(name)),
    readFile: (name) => entries.get(resolveAlias(name)),
    directoryExists: (name) => directories.has(path.posix.resolve('/', name)),
    getDirectories: (name) => [...directories].filter((item) => path.posix.dirname(item) === path.posix.resolve('/', name)),
    realpath: (name) => resolveAlias(name),
    getCurrentDirectory: () => '/',
    useCaseSensitiveFileNames: true,
    readDirectory: () => [...entries.keys()],
  };
  let options = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true };
  const configName = path.posix.resolve('/', configPath);
  if (host.fileExists(configName)) {
    const result = ts.readConfigFile(configName, host.readFile);
    if (result.error) return { resolve: () => ({ status: 'unresolved', reason: 'unsupported_syntax' }), diagnostics: [result.error.code] };
    const parsed = ts.parseJsonConfigFileContent(result.config, host, path.posix.dirname(configName), options, configName);
    if (parsed.errors.length) return { resolve: () => ({ status: 'unresolved', reason: 'unsupported_syntax' }), diagnostics: parsed.errors.map((e) => e.code) };
    options = parsed.options;
  }
  return {
    diagnostics: [],
    resolve(from, specifier) {
      const source = path.posix.resolve('/', from);
      const result = ts.resolveModuleName(specifier, source, options, host).resolvedModule;
      if (!result) return { status: 'unresolved', reason: specifier.startsWith('.') ? 'unindexed_target' : 'external_package' };
      const target = path.posix.resolve('/', result.resolvedFileName);
      if (!entries.has(target) || target.split('/').includes('node_modules')) return { status: 'unresolved', reason: 'external_package' };
      return { status: 'resolved', file: target.slice(1) };
    },
  };
}

const functionKinds = new Set(['function', 'arrow_function', 'class', 'variable']);

/** Resolve only bindings that can be established from the supplied facts. */
export function createSymbolResolver({ facts, moduleResolver, maxDepth = 20 }) {
  const indexed = facts instanceof Map ? facts : new Map(Object.entries(facts));
  const get = (file) => indexed.get(file) || indexed.get('/' + file);

  function exported(file, name, seen = new Set()) {
    const key = `${file}:${name}`;
    if (seen.has(key) || seen.size >= maxDepth) return { targets: [], reason: 'cycle_limit' };
    const next = new Set(seen); next.add(key);
    const f = get(file);
    if (!f) return { targets: [], reason: 'unindexed_target' };
    const targets = [];
    let reason = null;
    for (const record of f.exports) {
      if (record.isTypeOnly || (record.name !== name && record.name !== '*')) continue;
      if (record.reexportSource) {
        const module = moduleResolver.resolve(file, record.reexportSource);
        if (module.status !== 'resolved') { reason = module.reason; continue; }
        const inner = exported(module.file, record.name === '*' ? name : record.local, next);
        targets.push(...inner.targets); reason = inner.reason || reason;
      } else {
        targets.push(...f.symbols.filter((s) => s.name === record.local && functionKinds.has(s.kind) && s.scope === 'global' && !s.enclosingSymbolKey).map((symbol) => ({ file, symbol })));
      }
    }
    const unique = [...new Map(targets.map((t) => [`${t.file}:${t.symbol.symbolKey}`, t])).values()];
    return { targets: unique, reason: unique.length > 1 ? 'ambiguous_export' : reason || (unique.length ? null : 'unindexed_target') };
  }

  function resolve(file, site) {
    const f = get(file);
    if (!f) return { resolution: 'unresolved', reason: 'unindexed_target', candidates: [] };
    if (site.computed) return { resolution: 'unresolved', reason: 'computed_member', candidates: [] };
    if (f.uncertainBindings?.includes(site.receiver || site.calleeName)) return { resolution: 'unresolved', reason: 'ambiguous_receiver', candidates: [] };
    if (site.receiver === 'Reflect' && site.calleeName === 'apply') return { resolution: 'unresolved', reason: 'dynamic_call', candidates: [] };
    if (site.receiver && ['call', 'apply', 'bind'].includes(site.calleeName)) return { resolution: 'unresolved', reason: 'dynamic_call', candidates: [] };
    const cjsNames = new Set(f.imports.filter((item) => item.kind === 'cjs' && item.isTopLevel).flatMap((item) => item.specifiers.map((spec) => spec.local)));

    const candidates = [];
    let reason = site.receiver ? 'ambiguous_receiver' : 'unindexed_target';
    const select = (targets, explanation) => {
      if (targets.length !== 1) return null;
      const target = targets[0];
      const caller = f.symbols.find((symbol) => symbol.symbolKey === site.enclosingSymbolKey);
      const targetFacts = get(target.file);
      const safe = f.bindingEvidenceVersion === 1 && targetFacts?.bindingEvidenceVersion === 1 && f.parseStatus === 'complete' && targetFacts.parseStatus === 'complete' && site.confidence !== 'low' && caller?.confidence !== 'low' && target.symbol.confidence !== 'low' && !target.symbol.hasParseError && target.symbol.lexicalScope != null && !targetFacts.uncertainBindings.includes(target.symbol.name);
      return { resolution: safe ? 'confirmed' : 'probable', target, candidates: targets, explanation, ...(safe ? {} : { reason: caller?.confidence === 'low' || target.symbol.hasParseError ? 'parse_partial' : 'unsupported_syntax' }) };
    };
    if (site.receiver && cjsNames.has(site.receiver) && f.symbols.filter((symbol) => symbol.name === site.receiver).length !== 1) return { resolution: 'unresolved', reason: 'ambiguous_receiver', candidates: [] };
    if (site.receiver && !site.requireSource) {
      let classSymbol = null;
      let inferredExactly = false;
      const caller = f.symbols.find((symbol) => symbol.symbolKey === site.enclosingSymbolKey);
      if (site.receiver === 'this' && caller?.kind === 'method') {
        classSymbol = f.symbols.find((symbol) => symbol.symbolKey === caller.enclosingSymbolKey && symbol.kind === 'class');
        inferredExactly = Boolean(classSymbol);
      } else {
        const matches = (f.typeBindings || []).filter((binding) => binding.name === site.receiver && (!site.receiver.startsWith('this.') || binding.enclosingSymbolKey === caller?.enclosingSymbolKey));
        const declarations = f.symbols.filter((symbol) => symbol.name === site.receiver && symbol.kind === 'variable');
        const declaration = declarations[0];
        const visible = declaration?.lexicalScope && Number.isInteger(site.byteOffset) && declaration.lexicalScope.start <= site.byteOffset && site.byteOffset < declaration.lexicalScope.end && declaration.byteOffset < site.byteOffset;
        if (matches.length === 1 && ((site.receiver.startsWith('this.') && caller?.kind === 'method') || (declarations.length === 1 && visible))) {
          const declarationsOfType = f.symbols.filter((symbol) => symbol.name === matches[0].typeName);
          const importedType = f.imports.some((imp) => imp.specifiers.some((spec) => spec.local === matches[0].typeName));
          const candidate = declarationsOfType[0];
          const typeVisible = candidate?.lexicalScope && declaration?.byteOffset >= candidate.lexicalScope.start && declaration.byteOffset < candidate.lexicalScope.end;
          if (declarationsOfType.length === 1 && candidate.kind === 'class' && !importedType && !f.uncertainBindings.includes(candidate.name) && (site.receiver.startsWith('this.') || typeVisible)) { classSymbol = candidate; inferredExactly = matches[0].exactNew; }
        }
      }
      if (classSymbol && !f.uncertainBindings.includes(site.calleeName)) {
        let current = classSymbol;
        let currentFile = file;
        const visited = new Set();
        const inheritance = [classSymbol.name];
        let method = null;
        while (current && !visited.has(`${currentFile}:${current.symbolKey}`)) {
          visited.add(`${currentFile}:${current.symbolKey}`);
          const currentFacts = get(currentFile);
          if (!currentFacts || currentFacts.parseStatus !== 'complete') break;
          const methods = currentFacts.symbols.filter((symbol) => symbol.enclosingSymbolKey === current.symbolKey && symbol.name === site.calleeName && symbol.kind === 'method');
          if (methods.length > 1) break;
          if (methods.length === 1) { method = { file: currentFile, symbol: methods[0] }; break; }
          const parents = currentFacts.extendsImplements.filter((heritage) => heritage.classSymbolKey === current.symbolKey && heritage.type === 'extends');
          if (parents.length !== 1) break;
          const parentName = parents[0].targetName;
          const ancestors = currentFacts.symbols.filter((symbol) => symbol.kind === 'class' && symbol.name === parentName);
          const imports = currentFacts.imports.flatMap((imp) => imp.specifiers.filter((spec) => !spec.isTypeOnly && spec.local === parentName).map((spec) => ({ imp, spec })));
          if (ancestors.length === 1 && !imports.length && !currentFacts.uncertainBindings.includes(parentName)) { current = ancestors[0]; inheritance.push(parentName); continue; }
          if (!ancestors.length && imports.length === 1 && !currentFacts.uncertainBindings.includes(parentName)) {
            const { imp, spec } = imports[0];
            const resolvedModule = moduleResolver.resolve(currentFile, imp.source);
            if (resolvedModule.status !== 'resolved') break;
            const result = exported(resolvedModule.file, spec.imported);
            if (result.reason || result.targets.length !== 1 || result.targets[0].symbol.kind !== 'class') break;
            currentFile = result.targets[0].file; current = result.targets[0].symbol;
            inheritance.push(`${parentName} (${imp.source})`); continue;
          }
          break;
        }
        if (method) {
          const allMatches = [...indexed.values()].flatMap((facts) => facts.symbols.filter((symbol) => symbol.kind === 'method' && symbol.name === site.calleeName));
          const chain = select([method], `receiver ${site.receiver} -> ${inheritance.join(' -> ')} -> ${method.file}#${method.symbol.symbolKey}`);
          if (chain && (!inferredExactly || allMatches.length !== 1 || classSymbol.exportedNames.length)) return { ...chain, resolution: 'probable', reason: 'ambiguous_receiver' };
          if (chain) return chain;
        }
      }
      if (f.symbols.some((s) => s.name === site.receiver && !cjsNames.has(s.name))) return { resolution: 'unresolved', reason: 'ambiguous_receiver', candidates: [] };
    }
    // Choose the smallest enclosing lexical block when exactly one declaration
    // is visible there. Unknown/legacy offsets cannot prove a binding.
    if (!site.receiver) {
      const local = f.symbols.filter((s) => s.name === site.calleeName && functionKinds.has(s.kind) && !(s.kind === 'variable' && cjsNames.has(s.name) && f.imports.some((imp) => imp.kind === 'cjs' && imp.specifiers.some((spec) => spec.local === s.name) && imp.range.start.line >= s.range.start.line && imp.range.end.line <= s.range.end.line && (imp.range.start.line !== s.range.start.line || imp.range.start.column >= s.range.start.column))));
      const visible = local.filter((s) => s.lexicalScope && Number.isInteger(site.byteOffset) && s.lexicalScope.start <= site.byteOffset && site.byteOffset < s.lexicalScope.end);
      visible.sort((a, b) => (a.lexicalScope.end - a.lexicalScope.start) - (b.lexicalScope.end - b.lexicalScope.start));
      if (visible.length) {
        const width = visible[0].lexicalScope.end - visible[0].lexicalScope.start;
        const nearest = visible.filter((s) => s.lexicalScope.end - s.lexicalScope.start === width);
        const importedSameName = f.imports.some((imp) => imp.specifiers.some((spec) => spec.local === site.calleeName));
        if (nearest.length === 1 && !importedSameName) return select([{ file, symbol: nearest[0] }], `lexical ${site.calleeName} -> ${file}#${nearest[0].symbolKey}`);
        candidates.push(...nearest.map((symbol) => ({ file, symbol })));
      }
    }
    if (site.requireSource && !f.symbols.some((s) => s.name === 'require') && !f.uncertainBindings.includes('require')) {
      const mod = moduleResolver.resolve(file, site.requireSource);
      if (mod.status === 'resolved') {
        const binding = exported(mod.file, site.calleeName);
        if (binding.reason === null) { const found = select(binding.targets, `require ${site.requireSource}: ${site.calleeName} -> ${mod.file}#${binding.targets[0]?.symbol.symbolKey}`); if (found) return found; }
        reason = binding.reason;
      } else reason = mod.reason;
    }
    for (const imp of f.imports.filter((item) => !item.isDynamic && (item.kind !== 'cjs' || (item.isTopLevel && !f.symbols.some((s) => s.name === 'require') && !f.uncertainBindings.includes('require'))))) {
      for (const spec of imp.specifiers) {
        if (spec.isTypeOnly) continue;
        const matches = site.receiver ? ((spec.imported === '*' || (imp.kind === 'cjs' && spec.imported === 'default')) && spec.local === site.receiver) : spec.local === site.calleeName;
        if (!matches) continue;
        const module = moduleResolver.resolve(file, imp.source);
        if (module.status !== 'resolved') { reason = module.reason; continue; }
        const exportName = site.receiver ? site.calleeName : spec.imported;
        const result = exported(module.file, exportName);
        if (candidates.length === 0 && result.reason === null) {
          const found = select(result.targets, `import ${imp.source}: ${exportName} as ${spec.local} -> ${module.file}#${result.targets[0]?.symbol.symbolKey}`);
          if (found) return found;
        }
        candidates.push(...result.targets); reason = result.reason;
      }
    }
    return candidates.length ? { resolution: 'probable', reason: !reason || reason === 'unindexed_target' ? 'ambiguous_receiver' : reason, candidates, explanation: 'Candidate bindings are not uniquely grounded.' } : { resolution: 'unresolved', reason, candidates: [] };
  }
  function resolveImport(file, source, importedName) {
    const f = get(file);
    const module = moduleResolver.resolve(file, source);
    if (module.status !== 'resolved') return { resolution: 'unresolved', reason: module.reason, candidates: [] };
    if (importedName === '*') return { resolution: 'unresolved', reason: 'unsupported_syntax', candidates: [] };
    const result = exported(module.file, importedName);
    if (result.reason || result.targets.length !== 1) return { resolution: result.targets.length ? 'probable' : 'unresolved', reason: result.reason || 'ambiguous_export', candidates: result.targets };
    const target = result.targets[0], targetFacts = get(target.file);
    const safe = f?.parseStatus === 'complete' && targetFacts?.parseStatus === 'complete' && f.bindingEvidenceVersion === 1 && targetFacts.bindingEvidenceVersion === 1 && target.symbol.confidence === 'high' && !target.symbol.hasParseError;
    return { resolution: safe ? 'confirmed' : 'probable', ...(safe ? {} : { reason: 'parse_partial' }), target, candidates: result.targets, explanation: `import ${source}: ${importedName} -> ${target.file}#${target.symbol.symbolKey}` };
  }
  function exportNames(file, seen = new Set()) {
    if (seen.has(file) || seen.size >= maxDepth) return [];
    const next = new Set(seen); next.add(file);
    const names = new Set();
    for (const entry of get(file)?.exports || []) {
      if (entry.isTypeOnly || entry.name === 'default') continue;
      if (entry.name !== '*') names.add(entry.name);
      else if (entry.reexportSource) {
        const result = moduleResolver.resolve(file, entry.reexportSource);
        if (result.status === 'resolved') for (const name of exportNames(result.file, next)) names.add(name);
      }
    }
    return [...names].sort();
  }
  function resolveReexports(file, entry) {
    if (entry.name !== '*') return [{ name: entry.name, result: resolveImport(file, entry.reexportSource, entry.local) }];
    const module = moduleResolver.resolve(file, entry.reexportSource);
    if (module.status !== 'resolved') return [{ name: '*', result: { resolution: 'unresolved', reason: module.reason, candidates: [] } }];
    const names = exportNames(module.file);
    return names.length ? names.map((name) => ({ name, result: resolveImport(file, entry.reexportSource, name) })) : [{ name: '*', result: { resolution: 'unresolved', reason: 'cycle_limit', candidates: [] } }];
  }
  return { resolve, exported, resolveImport, resolveReexports };
}
