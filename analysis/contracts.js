/** Contract changes are evidence for hypotheses, not proof of bugs. */
export function detectContractChanges(base, head) {
  const changes = [];
  const current = new Map((head?.symbols || []).map((s) => [`${s.scope}:${s.kind}:${s.name}:${s.symbolKey.split('#').at(-1)}`, s]));
  const emit = (kind, old, next, detail) => changes.push({ kind, baseRange: old?.range ?? null, headRange: next?.range ?? null, symbolKey: next?.symbolKey ?? old?.symbolKey, detail, classification: 'hypothesis_input' });
  for (const old of base?.symbols || []) {
    const next = current.get(`${old.scope}:${old.kind}:${old.name}:${old.symbolKey.split('#').at(-1)}`);
    if (!next) { if (old.exportedNames.length) emit('removed_export', old, null, old.exportedNames); continue; }
    if (JSON.stringify(old.exportedNames) !== JSON.stringify(next.exportedNames)) emit('export_binding', old, next, { before: old.exportedNames, after: next.exportedNames });
    const a = old.contract, b = next.contract;
    if (!a || !b) continue;
    if (a.parameters.length !== b.parameters.length) emit('parameter_count', old, next, { before: a.parameters.length, after: b.parameters.length });
    if (a.parameters.map((p) => p.name).join('|') !== b.parameters.map((p) => p.name).join('|')) emit('parameter_order', old, next, { before: a.parameters.map((p) => p.name), after: b.parameters.map((p) => p.name) });
    if (JSON.stringify(a.parameters.map((p) => [p.hasDefault, p.defaultFingerprint])) !== JSON.stringify(b.parameters.map((p) => [p.hasDefault, p.defaultFingerprint]))) emit('parameter_default', old, next, null);
    if (a.parameters.map((p) => p.optional).join('|') !== b.parameters.map((p) => p.optional).join('|')) emit('parameter_optionality', old, next, null);
    for (const [field, kind] of [['async', 'async'], ['generator', 'generator'], ['parameters', 'parameters'], ['modifiers', 'modifiers'], ['returns', 'return_shape'], ['throws', 'throws'], ['throwFingerprints', 'throw_statements']]) {
      if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) emit(kind, old, next, { before: a[field], after: b[field] });
    }
  }
  for (const previous of base?.exports || []) {
    if (previous.isTypeOnly) continue;
    const same = (head?.exports || []).some((item) => item.name === previous.name && !item.isTypeOnly);
    if (same) continue;
    const renamed = (head?.exports || []).filter((item) => !item.isTypeOnly && item.local === previous.local && item.reexportSource === previous.reexportSource);
    changes.push({ kind: renamed.length === 1 ? 'renamed_export' : 'removed_export_binding', baseRange: previous.range, headRange: renamed.length === 1 ? renamed[0].range : null, symbolKey: base?.symbols.find((symbol) => symbol.name === previous.local)?.symbolKey ?? null, detail: { before: previous.name, after: renamed.length === 1 ? renamed[0].name : null }, classification: 'hypothesis_input' });
  }
  for (const old of (base?.symbols || []).filter((symbol) => symbol.kind === 'class')) {
    const next = (head?.symbols || []).find((symbol) => symbol.kind === 'class' && symbol.name === old.name && symbol.scope === old.scope);
    if (!next) continue;
    const entries = (facts, symbol) => (facts?.extendsImplements || []).filter((item) => item.classSymbolKey === symbol.symbolKey).map((item) => `${item.type}:${item.targetName}`).sort();
    const before = entries(base, old), after = entries(head, next);
    if (JSON.stringify(before) !== JSON.stringify(after)) emit('heritage', old, next, { before, after });
  }
  return changes;
}
