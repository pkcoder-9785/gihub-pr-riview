import { CandidateV3, rootFingerprint } from './evidence.js';
import { sanitize } from './safety.js';

const unsupportedExecutionClaim = /\b(?:(?:i|we|agent|bot)\s+(?:have\s+)?(?:ran|executed|tested|reproduced)|(?:tests?|exploit|reproduction)\s+(?:passed|failed|was run|was executed)|(?:confirmed|verified)\s+(?:by|with|through)\s+(?:running|executing|tests?))\b/i;

export function verifyFindings({ candidates, packet, priorFindings = [], revisions = [], maxFindings = 5 }) {
  const evidence = new Map(packet.items.map((item) => [item.id, item]));
  const chains = new Map(packet.chains.map((item) => [item.id, item]));
  const previous = new Map(priorFindings.filter((row) => row.state !== 'fixed').map((row) => [row.fingerprint, row]));
  const accepted = new Map(), rejected = [], states = [];
  for (const raw of candidates) {
    const result = CandidateV3.safeParse(raw);
    if (!result.success) { rejected.push({ reason: 'schema' }); continue; }
    const c = result.data;
    const reject = (reason) => rejected.push({ reason, fingerprint: rootFingerprint(c) });
    if (c.confidence < 0.8 || c.severity === 'low') { reject('low_confidence_or_impact'); continue; }
    if (unsupportedExecutionClaim.test([c.title, c.whyIncorrect, c.triggerScenario, c.suggestion].join(' '))) { reject('unproven_execution'); continue; }
    const refs = c.evidenceRefs.map((id) => evidence.get(id));
    if (refs.some((item) => !item || ![packet.snapshot.head, packet.snapshot.base].includes(item.sha))) { reject('missing_evidence'); continue; }
    const changed = refs.filter((item) => item.kind === 'changed' && item.file === c.changedFile);
    if (!changed.length) { reject('no_related_diff_evidence'); continue; }
    if (c.changedSymbolKey && !refs.some((item) => item.symbolKey === c.changedSymbolKey)) { reject('missing_symbol'); continue; }
    const usedChains = c.chainRefs.map((id) => chains.get(id));
    if (usedChains.some((chain) => !chain || chain.resolution !== 'confirmed' || c.changedSymbolKey && chain.changedSymbolKey !== c.changedSymbolKey || chain.evidenceRefs.some((id) => !evidence.has(id)))) { reject('unproven_chain'); continue; }
    if (c.dependencyClaim === 'confirmed' && !usedChains.length) { reject('missing_chain'); continue; }
    if (c.dependencyClaim === 'none' && /\b(?:caller|downstream|invokes|call chain)\b/i.test(c.whyIncorrect)) { reject('undeclared_dependency_claim'); continue; }
    // A symbol claim must concern changed evidence in that symbol. A file-level
    // regression can explicitly use a null symbol and remains diff-grounded.
    if (c.changedSymbolKey && !changed.some((item) => item.symbolKey === c.changedSymbolKey)) { reject('wrong_symbol_location'); continue; }
    const fingerprint = rootFingerprint(c);
    const old = previous.get(fingerprint);
    const state = old ? old.head_sha === packet.snapshot.head ? 'still_present' : 'changed' : 'new';
    const inline = changed.find((item) => item.line === c.changedLine && item.side === c.side && item.anchorValid);
    const proof = usedChains.map((chain) => chain.path.map((site) => `${site.file}:${site.line}`).join(' -> ')).join('; ');
    const proofText = `Evidence: ${packet.snapshot.head}; ${changed.slice(0, 2).map((item) => `${item.file}:${item.line} ${item.side}`).join(', ')}${proof ? `; confirmed chain ${proof}` : ''}. ${c.dependencyClaim === 'conditional' ? 'Dependency impact is conditional. ' : ''}${packet.coverage.partial ? 'Analysis coverage is partial.' : 'Available analysis coverage is complete.'}`;
    const finding = { path: c.changedFile, line: inline ? c.changedLine : null, side: inline ? c.side : null,
      severity: c.severity, confidence: c.confidence, title: sanitize(c.title), explanation: `${sanitize(c.whyIncorrect).slice(0, 1100)}\n\n${sanitize(proofText).slice(0, 500)}`,
      failureScenario: `Reasoned scenario: ${sanitize(c.triggerScenario).slice(0, 750)}`,
      suggestedFix: c.suggestion ? sanitize(c.suggestion).slice(0, 900) : null, anchorValid: Boolean(inline),
      fingerprint, state, symbolKey: c.changedSymbolKey, rootCause: sanitize(c.rootCause), evidenceRefs: c.evidenceRefs, agentOrigin: c.agentOrigin };
    const known = accepted.get(fingerprint);
    if (!known || known.confidence < finding.confidence) accepted.set(fingerprint, finding);
  }
  const ranks = { critical: 0, high: 1, medium: 2, low: 3 };
  const findings = [...accepted.values()].sort((a, b) => ranks[a.severity] - ranks[b.severity] || b.confidence - a.confidence).slice(0, Math.min(5, maxFindings));
  for (const finding of findings) states.push(finding);
  for (const row of priorFindings) if (!accepted.has(row.fingerprint)) {
    const assessment = revisions.find((revision) => revision.fingerprint === row.fingerprint);
    const refs = assessment?.evidenceRefs.map((id) => evidence.get(id)) || [];
    const grounded = refs.length && refs.every((item) => item?.sha === packet.snapshot.head && item.file === row.finding?.path)
      && !unsupportedExecutionClaim.test(assessment.reason);
    const fixed = grounded && assessment.state === 'fixed' && !packet.coverage.partial
      && refs.some((item) => item.kind === 'changed') && !(packet.unresolved || []).some((lead) => lead.file === row.finding?.path);
    states.push({ ...row.finding, fingerprint: row.fingerprint,
      state: fixed || row.state === 'fixed' ? 'fixed' : grounded && ['still_present', 'changed'].includes(assessment.state) ? assessment.state : 'no_longer_verifiable',
      revisionReason: grounded ? sanitize(assessment.reason) : 'Insufficient evidence to reassess the prior finding.',
      revisionAssessment: fixed ? 'source_evidence_assessment' : null });
  }
  // Already-posted unresolved root causes are tracked, not reposted each push.
  return { findings: findings.filter((finding) => !previous.has(finding.fingerprint)), states, rejected };
}
