import { z } from 'zod';

export const PARSER_VERSION = 'v10';
export const RESOLVER_VERSION = 'v2';

export const SymbolKindV3 = z.enum([
  'function',
  'arrow_function',
  'method',
  'getter',
  'setter',
  'class',
  'interface',
  'type_alias',
  'variable',
  'enum',
]);

export const RangeV3 = z.object({
  start: z.object({ line: z.number().int(), column: z.number().int() }),
  end: z.object({ line: z.number().int(), column: z.number().int() }),
});

export const SymbolDeclarationV3 = z.object({
  symbolKey: z.string(), // path#scope#kind:name#ordinal
  name: z.string(),
  kind: SymbolKindV3,
  scope: z.string(),     // lexical scope: "global", "class:Foo", "function:bar"
  exportedNames: z.array(z.string()),
  range: RangeV3,
  signatureFingerprint: z.string(), // hash of normalized params and return type
  bodyFingerprint: z.string(),      // hash of normalized token stream (whitespace/comments removed)
  structureFingerprint: z.string(), // hash of AST node skeleton for rename detection
  confidence: z.enum(['high', 'low']).default('high'),
  hasParseError: z.boolean().default(false),
  enclosingSymbolKey: z.string().nullable().default(null),
  byteOffset: z.number().int().nonnegative().optional(),
  endByte: z.number().int().nonnegative().optional(),
  declarationKind: z.enum(['function', 'arrow', 'method', 'class', 'constructor', 'generator', 'other']).optional(),
  lexicalScope: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).optional(),
  contract: z.object({ async: z.boolean(), generator: z.boolean(), parameters: z.array(z.object({ name: z.string(), optional: z.boolean(), hasDefault: z.boolean(), defaultFingerprint: z.string().nullable().default(null) })), modifiers: z.array(z.string()), returns: z.array(z.string()), throws: z.boolean(), throwFingerprints: z.array(z.string()).default([]) }).optional(),
});

export const ImportSpecifierV3 = z.object({
  imported: z.string(),
  local: z.string(),
  isTypeOnly: z.boolean().default(false),
});

export const ImportDeclarationV3 = z.object({
  source: z.string(),
  specifiers: z.array(ImportSpecifierV3),
  isDynamic: z.boolean().default(false),
  kind: z.enum(['esm', 'cjs']), // ESM import vs CommonJS require
  isTopLevel: z.boolean().default(true),
  byteOffset: z.number().int().nonnegative().optional(),
  range: RangeV3,
});

export const ExportDeclarationV3 = z.object({
  name: z.string(),
  local: z.string(),
  isTypeOnly: z.boolean().default(false),
  reexportSource: z.string().nullable().default(null),
  byteOffset: z.number().int().nonnegative().optional(),
  range: RangeV3,
});

export const CallSiteV3 = z.object({
  calleeName: z.string(),
  receiver: z.string().nullable().default(null),
  computed: z.boolean().default(false),
  requireSource: z.string().nullable().default(null),
  byteOffset: z.number().int().nonnegative().optional(),
  endByte: z.number().int().nonnegative().optional(),
  optional: z.boolean().default(false),
  syntaxKind: z.enum(['direct_call', 'method_call', 'new_expression', 'tagged_template']),
  range: RangeV3,
  enclosingSymbolKey: z.string().nullable().default(null),
  confidence: z.enum(['high', 'low']).default('high'),
});

export const JsxUsageV3 = z.object({
  elementName: z.string(),
  byteOffset: z.number().int().nonnegative().optional(),
  enclosingSymbolKey: z.string().nullable().default(null),
  range: RangeV3,
});

export const ValueReferenceV3 = z.object({
  identifier: z.string(),
  byteOffset: z.number().int().nonnegative().optional(),
  enclosingSymbolKey: z.string().nullable().default(null),
  range: RangeV3,
});

export const ExtendsImplementsV3 = z.object({
  classSymbolKey: z.string(),
  targetName: z.string(),
  type: z.enum(['extends', 'implements']),
});

export const DiagnosticV3 = z.object({
  level: z.enum(['warning', 'error']),
  message: z.string(),
  range: RangeV3,
});

export const ParseResultV3 = z.object({
  path: z.string(),
  language: z.enum(['javascript', 'jsx', 'typescript', 'tsx']),
  symbols: z.array(SymbolDeclarationV3),
  imports: z.array(ImportDeclarationV3),
  exports: z.array(ExportDeclarationV3),
  callSites: z.array(CallSiteV3),
  jsxUsages: z.array(JsxUsageV3),
  valueReferences: z.array(ValueReferenceV3),
  extendsImplements: z.array(ExtendsImplementsV3),
  usedIdentifiers: z.array(z.string()),
  uncertainBindings: z.array(z.string()).default([]),
  typeBindings: z.array(z.object({ name: z.string(), typeName: z.string(), exactNew: z.boolean(), enclosingSymbolKey: z.string().nullable() })).default([]),
  riskSignals: z.array(z.object({ kind: z.enum(['env_access', 'route_registration']), range: RangeV3 })).default([]),
  bindingEvidenceVersion: z.number().int().nullable().default(null),
  diagnostics: z.array(DiagnosticV3),
  parseStatus: z.enum(['complete', 'partial', 'error']),
});

export const FileFactsV3 = z.object({
  repositoryId: z.number().int(),
  blobSha: z.string(),
  parserVersion: z.string(),
  facts: ParseResultV3,
  parseStatus: z.enum(['complete', 'partial', 'error']),
  indexedAt: z.string(),
});

export const EdgeTypeV3 = z.enum([
  'import',
  'reexport',
  'direct_call',
  'jsx_use',
  'value_ref',
  'extends',
  'probable',
  'unresolved',
]);

export const CallChainNodeV3 = z.object({
  file: z.string(),
  line: z.number(),
  column: z.number(),
  commitSha: z.string(),
  symbolKey: z.string().nullable().default(null),
});

export const ResolvedEdgeV3 = z.object({
  fromSymbolKey: z.string(),
  toSymbolKey: z.string(),
  edgeType: EdgeTypeV3,
  trust: z.enum(['very_high', 'high', 'probable', 'unresolved']),
  callChain: z.array(CallChainNodeV3),
  explanation: z.string(),
  path: z.array(z.string()).default([]),
});

export const UnresolvedReasonV3 = z.enum(['dynamic_call', 'computed_member', 'ambiguous_receiver', 'ambiguous_export', 'external_package', 'unindexed_target', 'parse_partial', 'unsupported_syntax', 'cycle_limit']);

export const ContractChangeV3 = z.object({ kind: z.string().min(1), baseRange: RangeV3.nullable(), headRange: RangeV3.nullable(), symbolKey: z.string().nullable(), detail: z.unknown(), classification: z.literal('hypothesis_input'), file: z.string() });

export const ImpactReportV3 = z.object({
  changedSymbols: z.array(z.object({ symbolKey: z.string(), changeTypes: z.array(z.enum(['added', 'modified', 'removed', 'renamed', 'signature_changed', 'export_changed'])), baseRange: RangeV3.nullable(), headRange: RangeV3.nullable(), confidence: z.number().min(0).max(1), reason: z.string().nullable(), file: z.string(), baseSymbolKey: z.string().nullable() })),
  affectedCallers: z.array(z.object({ graphSnapshotSha: z.string(), changedSymbolKey: z.string(), callerSymbolKey: z.string().nullable(), file: z.string(), line: z.number(), column: z.number(), hops: z.number().int().positive(), resolution: z.literal('confirmed'), explanation: z.string().min(1), path: z.array(z.object({ file: z.string(), line: z.number(), column: z.number(), callerSymbolKey: z.string().nullable(), targetSymbolKey: z.string().nullable() })).min(1) })),
  contractChanges: z.array(ContractChangeV3),
  potentialRisks: z.array(z.object({ label: z.literal('hypothesis'), file: z.string(), reason: z.string() })),
  otherChanges: z.array(z.object({ file: z.string(), reason: z.string() })),
  unresolved: z.array(z.object({ file: z.string(), line: z.number(), column: z.number(), resolution: z.enum(['probable', 'unresolved']), reason: UnresolvedReasonV3, explanation: z.string().nullable() })),
  indexCoverage: z.object({ manifestFiles: z.number(), parsedFiles: z.number(), skippedFiles: z.number(), ratio: z.number(), isPartial: z.boolean() }),
  neighborhoodCoverage: z.object({ candidateFiles: z.number(), resolvedFiles: z.number(), unresolvedFiles: z.number(), resolvedEdges: z.number(), unresolvedEdges: z.number(), ratio: z.number(), reasonCounts: z.record(z.string(), z.number()) }),
  limits: z.object({ hops: z.number(), callerCap: z.number(), truncated: z.boolean() }),
});

export const VerifiedFindingV3 = z.object({
  path: z.string(),
  line: z.number().nullable(),
  side: z.enum(['LEFT', 'RIGHT']).nullable(),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  confidence: z.number().min(0).max(1),
  title: z.string(),
  explanation: z.string(),
  failureScenario: z.string(),
  suggestedFix: z.string().nullable(),
  evidence: z.string(),
  anchorValid: z.boolean(),
  verificationStatus: z.enum(['verified', 'rejected_unanchored', 'rejected_evidence_mismatch', 'summary_only']),
  rejectionReason: z.string().nullable().default(null),
});

export const IndexCoverageV3 = z.object({
  status: z.enum(['complete', 'partial', 'unavailable']),
  indexed: z.number().int().nonnegative(), unindexed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(), unsupported: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(), truncated: z.boolean(),
  reasons: z.array(z.object({ path: z.string(), reason: z.string() })),
  limits: z.object({ fileCapHit: z.boolean(), byteCapHit: z.boolean(), edgeCapHit: z.boolean() }),
});
export const DependencyGraphV3 = z.object({
  repositoryId: z.string(), commitSha: z.string(), parserVersion: z.string(), resolverVersion: z.string(),
  edges: z.array(z.object({ edge_key: z.string(), type: z.string(), file: z.string(),
    callerSymbolKey: z.string().nullable(), targetSymbolKey: z.string().nullable(),
    resolution: z.enum(['confirmed', 'probable', 'unresolved']), line: z.number(), column: z.number(),
    byteOffset: z.union([z.number(), z.string()]), explanation: z.string().optional(),
  }).passthrough()), coverage: IndexCoverageV3,
});
