import { createHash } from 'node:crypto';
import { z } from 'zod';
import { changedLineEntries } from './context.js';
import { redact } from './safety.js';
import { isEligibleManifestFile } from '../analysis/manifest.js';

export const EVIDENCE_LIMITS = Object.freeze({ files: 20, chars: 50000 });
const hash = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export const CandidateV3 = z.object({
  title: z.string().min(1).max(240), category: z.enum(['security', 'logic', 'compatibility']),
  severity: z.enum(['critical', 'high', 'medium', 'low']), confidence: z.number().min(0).max(1),
  rootCause: z.string().min(1).max(400), changedFile: z.string().min(1).max(1024),
  changedLine: z.number().int().positive().nullable(), side: z.enum(['LEFT', 'RIGHT']).nullable(),
  changedSymbolKey: z.string().nullable(), triggerScenario: z.string().min(1).max(1200),
  whyIncorrect: z.string().min(1).max(1600), evidenceRefs: z.array(z.string()).min(1).max(12),
  chainRefs: z.array(z.string()).max(5), dependencyClaim: z.enum(['none', 'confirmed', 'conditional']),
  suggestion: z.string().max(1000).nullable(), agentOrigin: z.enum(['context-dependency', 'security-logic', 'architecture']),
}).strict();
export const RevisionAssessmentV3 = z.object({ fingerprint: z.string(),
  state: z.enum(['still_present', 'changed', 'fixed', 'no_longer_verifiable']),
  evidenceRefs: z.array(z.string()).max(8), reason: z.string().min(1).max(600),
}).strict();
export const AgentResultV3 = z.object({ summary: z.string().max(1600), candidates: z.array(CandidateV3).max(12),
  revisions: z.array(RevisionAssessmentV3).max(30),
}).strict();

export async function buildEvidencePacket({ context, impact, snapshot, fetchFile, baseFacts = new Map(), headFacts = new Map(), maxFiles = 20, maxChars = 50000 }) {
  maxFiles = Math.max(0, Math.min(EVIDENCE_LIMITS.files, maxFiles));
  maxChars = Math.max(0, Math.min(EVIDENCE_LIMITS.chars, maxChars));
  const items = [], chains = [], files = new Set(), fetched = new Map();
  let chars = 0, truncated = false;
  const add = (item) => {
    if (!isEligibleManifestFile(item.file) || redact(item.file) !== item.file) { truncated = true; return null; }
    const snippet = redact(item.snippet).slice(0, 1800);
    const id = hash(item.kind, item.file, item.sha, item.line, item.side, item.symbolKey, snippet);
    const existing = items.find((entry) => entry.id === id);
    if (existing) return id;
    const length = snippet.length + item.file.length + (item.symbolKey?.length || 0) + 200;
    if ((!files.has(item.file) && files.size >= maxFiles) || chars + length > maxChars) { truncated = true; return null; }
    files.add(item.file); chars += length;
    items.push({ ...item, snippet, id });
    return id;
  };
  // Preserve exact redacted changed lines. A clipped line is not an inline anchor.
  for (const file of context.files) {
    for (const entry of changedLineEntries(file.patch)) {
      const facts = entry.side === 'LEFT' ? baseFacts.get(file.previousPath || file.path) : headFacts.get(file.path);
      const enclosing = facts?.symbols.filter((s) => s.range.start.line <= entry.line && s.range.end.line >= entry.line)
        .sort((a, b) => (a.range.end.line - a.range.start.line) - (b.range.end.line - b.range.start.line))[0];
      const id = add({ kind: 'changed', file: file.path, sourceFile: entry.side === 'LEFT' ? file.previousPath || file.path : file.path,
        sha: entry.side === 'LEFT' ? snapshot.base : snapshot.head, side: entry.side, line: entry.line, column: 0,
        symbolKey: enclosing?.symbolKey ?? null, snippet: entry.text });
      if (id) items.find((item) => item.id === id).anchorValid = entry.text.length <= 1800 && file.patch.split('\n').length === redact(file.patch).split('\n').length;
    }
  }
  const load = async (file, sha) => {
    const key = `${sha}:${file}`;
    if (!fetched.has(key)) fetched.set(key, Promise.resolve(fetchFile(file, sha)).catch(() => null));
    return fetched.get(key);
  };
  // Include enclosing function/contract excerpts, without sending entire source files.
  for (const change of impact.changedSymbols || []) {
    if (chars >= maxChars || files.size >= maxFiles && !files.has(change.file)) { truncated = true; continue; }
    const removed = change.changeTypes.includes('removed');
    const sha = removed ? snapshot.base : snapshot.head;
    const facts = (removed ? baseFacts : headFacts).get(change.file);
    const symbol = facts?.symbols.find((s) => s.symbolKey === change.symbolKey || removed && s.symbolKey === change.baseSymbolKey);
    if (!symbol) continue;
    const source = await load(change.file, sha);
    if (typeof source !== 'string') { truncated = true; continue; }
    const lines = source.split(/\r?\n/);
    add({ kind: 'symbol', file: change.file, sha, side: removed ? 'LEFT' : 'RIGHT', line: symbol.range.start.line,
      column: symbol.range.start.column, symbolKey: symbol.symbolKey, snippet: lines.slice(symbol.range.start.line - 1, Math.min(symbol.range.end.line, symbol.range.start.line + 18)).join('\n') });
  }
  for (const caller of impact.affectedCallers || []) {
    if (caller.resolution !== 'confirmed' || !caller.path?.length) continue;
    const refs = [];
    let complete = true;
    for (const site of caller.path) {
      if (chars >= maxChars || !isEligibleManifestFile(site.file) || (!files.has(site.file) && files.size >= maxFiles)) { truncated = true; complete = false; break; }
      const source = await load(site.file, caller.graphSnapshotSha);
      if (typeof source !== 'string') { truncated = true; complete = false; break; }
      const lines = source.split(/\r?\n/);
      const id = add({ kind: 'callsite', file: site.file, sha: caller.graphSnapshotSha, side: 'RIGHT', line: site.line,
        column: site.column, symbolKey: site.callerSymbolKey, targetSymbolKey: site.targetSymbolKey,
        snippet: lines.slice(Math.max(0, site.line - 4), site.line + 4).join('\n') });
      if (!id) { complete = false; break; }
      refs.push(id);
    }
    if (complete) chains.push({ id: hash('chain', caller.changedSymbolKey, ...refs), changedSymbolKey: caller.changedSymbolKey,
      sha: caller.graphSnapshotSha, resolution: 'confirmed', evidenceRefs: refs, path: caller.path, explanation: caller.explanation });
  }
  return { version: 'v3', snapshot, items, chains,
    coverage: { partial: context.partial || impact.indexCoverage?.isPartial || truncated, files: files.size, chars, truncated,
      index: impact.indexCoverage, limits: impact.limits },
    risks: (impact.potentialRisks || []).slice(0, 40),
    unresolved: (impact.unresolved || []).slice(0, 40).map(({ file, reason }) => ({ file, reason })),
  };
}

export function selectAgentEvidence(packet, role) {
  // Shared facts have stable IDs. Specialists receive compact excerpts, never
  // repeated whole diffs/ASTs or unrestricted repository context.
  const items = packet.items.map((item) => ({ ...item, snippet: item.snippet.slice(0, role === 'context-dependency' ? 900 : 1400) }));
  return { ...packet, items };
}

export function rootFingerprint(candidate) {
  const normalize = (value) => String(value || '').toLowerCase().replace(/\b(?:line|sha|commit)\s*[:#]?\s*[a-z0-9]+/g, '').replace(/\s+/g, ' ').trim();
  return hash(normalize(candidate.changedFile), normalize(candidate.changedSymbolKey?.replace(/#\d+$/, '') || ''), normalize(candidate.rootCause));
}
