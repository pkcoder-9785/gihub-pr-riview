import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFile } from '../analysis/parser.js';
import { detectChangedSymbols } from '../analysis/impact.js';

test('line shifts and comments do not constitute symbol modification', async () => {
  const before = await parseFile('a.js', 'export function f(x) { return x + 1; }');
  const after = await parseFile('a.js', '// comment\n\nexport function f(x) { /* explanation */ return x + 1; }');
  assert.deepEqual(detectChangedSymbols(before, after), []);
});

test('contract facts detect async, parameter and throw changes', async () => {
  const { detectContractChanges } = await import('../analysis/contracts.js');
  const before = await parseFile('a.js', 'export function f(a) { return 1; }');
  const after = await parseFile('a.js', 'export async function f(a, b = 1) { throw new Error(); }');
  const kinds = detectContractChanges(before, after).map((item) => item.kind);
  assert.ok(kinds.includes('async'));
  assert.ok(kinds.includes('parameters'));
  assert.ok(kinds.includes('throws'));
});

test('a unique structural rename is a hypothesis below full confidence', async () => {
  const before = await parseFile('a.js', 'function oldName(a) { return a + 1; }');
  const after = await parseFile('a.js', 'function newName(a) { return a + 1; }');
  const changes = detectChangedSymbols(before, after);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].changeTypes, ['renamed']);
  assert.ok(changes[0].confidence < 1);
  assert.ok(changes[0].reason);
});

test('impact report traces a confirmed aliased caller and separates dynamic leads', async () => {
  const { buildImpactReport } = await import('../analysis/impact.js');
  const { ImpactReportV3 } = await import('../analysis/types.js');
  const beforeFiles = new Map([['src/lib.js', 'export function run(x){ return x + 1; }'], ['src/use.js', "import {run as check} from './lib'; export function use(){ check(1); obj[key](); }"]]);
  const afterFiles = new Map(beforeFiles); afterFiles.set('src/lib.js', 'export function run(x){ return x + 2; }');
  const parse = async (files) => new Map(await Promise.all([...files].map(async ([name, code]) => [name, await parseFile(name, code)])));
  const baseFacts = await parse(beforeFiles), headFacts = await parse(afterFiles);
  const report = await buildImpactReport({ baseSha: 'base', headSha: 'head', baseFacts, headFacts, baseFiles: beforeFiles, headFiles: afterFiles, changedPaths: ['src/lib.js'] });
  assert.ok(ImpactReportV3.safeParse(report).success);
  assert.equal(report.affectedCallers.length, 1);
  assert.equal(report.affectedCallers[0].file, 'src/use.js');
  assert.equal(report.affectedCallers[0].graphSnapshotSha, 'head');
  assert.ok(report.affectedCallers[0].explanation.includes('check'));
  assert.ok(report.unresolved.some((lead) => lead.reason === 'computed_member'));
  assert.equal(report.indexCoverage.isPartial, false);
  assert.ok(report.neighborhoodCoverage.ratio < 1);
});

test('deleted symbol is traced against base snapshot and incomplete index is reported', async () => {
  const { buildImpactReport } = await import('../analysis/impact.js');
  const bfiles = new Map([['a.js', 'export function run() {}'], ['b.js', "import {run} from './a'; function use(){ run(); }"]]);
  const hfiles = new Map([['b.js', bfiles.get('b.js')]]);
  const parse = async (files) => new Map(await Promise.all([...files].map(async ([name, code]) => [name, await parseFile(name, code)])));
  const report = await buildImpactReport({ baseSha: 'base', headSha: 'head', baseFacts: await parse(bfiles), headFacts: await parse(hfiles), baseFiles: bfiles, headFiles: hfiles, headManifest: new Map([['b.js', '1'], ['unindexed.js', '2']]), changedPaths: ['a.js'] });
  assert.equal(report.affectedCallers[0].graphSnapshotSha, 'base');
  assert.equal(report.affectedCallers[0].file, 'b.js');
  assert.equal(report.indexCoverage.isPartial, true);
});

test('index candidates follow barrel importers and retain two-hop evidence', async () => {
  const { buildImpactReport } = await import('../analysis/impact.js');
  const before = new Map([['src/lib.js', 'export function run(){ return 1; }'], ['src/barrel.js', "export {run} from './lib';"], ['src/use.js', "import {run} from './barrel'; export function use(){ run(); }"], ['src/top.js', "import {use} from './use'; function top(){ use(); }"]]);
  const after = new Map(before); after.set('src/lib.js', 'export function run(){ return 2; }');
  const parse = async (files) => new Map(await Promise.all([...files].map(async ([name, code]) => [name, await parseFile(name, code)])));
  const manifest = new Map([...before.keys()].map((name) => [name, name]));
  const store = { findBlobShasWithIdentifiers: async () => new Map([['run', new Set(['src/use.js'])]]) };
  const report = await buildImpactReport({ baseSha: 'base', headSha: 'head', baseFacts: await parse(before), headFacts: await parse(after), baseFiles: before, headFiles: after, baseManifest: manifest, headManifest: manifest, changedPaths: ['src/lib.js'], repositoryId: 1, store, hops: 2 });
  assert.ok(report.affectedCallers.some((item) => item.file === 'src/use.js'));
  const top = report.affectedCallers.find((item) => item.file === 'src/top.js');
  assert.equal(top.hops, 2);
  assert.equal(top.path.length, 2);
});

test('moved symbol keeps base callers and records the move as uncertain', async () => {
  const { buildImpactReport } = await import('../analysis/impact.js');
  const before = new Map([['old.js', 'export function run(){ return 1; }'], ['use.js', "import {run} from './old'; function use(){run();}"]]);
  const after = new Map([['new.js', 'export function run(){ return 1; }'], ['use.js', before.get('use.js')]]);
  const parse = async (files) => new Map(await Promise.all([...files].map(async ([name, code]) => [name, await parseFile(name, code)])));
  const report = await buildImpactReport({ baseSha: 'base', headSha: 'head', baseFacts: await parse(before), headFacts: await parse(after), baseFiles: before, headFiles: after, changedPaths: ['old.js', 'new.js'] });
  assert.ok(report.changedSymbols.some((item) => item.changeTypes.includes('renamed') && item.confidence < 1));
  assert.ok(report.affectedCallers.some((item) => item.graphSnapshotSha === 'base' && item.file === 'use.js'));
});

test('parameter default, optionality, export rename and heritage changes have evidence', async () => {
  const { detectContractChanges } = await import('../analysis/contracts.js');
  const old = await parseFile('a.ts', 'class Base {} class A extends Base {} function f(a: number, b?: number){} export { f as oldName };');
  const now = await parseFile('a.ts', 'class Base {} class A {} function f(b: number = 1, a: number){} export { f as newName };');
  const changes = detectContractChanges(old, now);
  for (const kind of ['parameter_order', 'parameter_default', 'parameter_optionality', 'renamed_export', 'heritage']) assert.ok(changes.some((item) => item.kind === kind), kind);
  assert.ok(changes.every((item) => item.classification === 'hypothesis_input' && item.baseRange));
});

test('impact other changes distinguish environment and route signals', async () => {
  const { buildImpactReport } = await import('../analysis/impact.js');
  const old = new Map([['app.js', 'function setup(app){}']]);
  const now = new Map([['app.js', "function setup(app){ app.get('/ok', handler); return process.env.PORT; }"]]);
  const parse = async (files) => new Map(await Promise.all([...files].map(async ([name, code]) => [name, await parseFile(name, code)])));
  const report = await buildImpactReport({ baseSha: 'base', headSha: 'head', baseFacts: await parse(old), headFacts: await parse(now), baseFiles: old, headFiles: now, changedPaths: ['app.js'] });
  assert.ok(report.otherChanges.some((item) => item.reason.includes('Environment')));
  assert.ok(report.otherChanges.some((item) => item.reason.includes('route')));
});

const contractFixtures = [
    ['async', 'export function f(){}', 'export async function f(){}'],
    ['generator', 'export function f(){}', 'export function* f(){}'],
    ['parameter_count', 'export function f(a){}', 'export function f(a,b){}'],
    ['parameter_order', 'export function f(a,b){}', 'export function f(b,a){}'],
    ['parameter_default', 'export function f(a){}', 'export function f(a=1){}'],
    ['parameter_optionality', 'export function f(a: number){}', 'export function f(a?: number){}'],
    ['modifiers', 'class A { public f(){} }', 'class A { private f(){} }'],
    ['return_shape', 'export function f(){return {a:1};}', 'export function f(){return {b:1};}'],
    ['throws', 'export function f(){}', 'export function f(){throw new Error();}'],
    ['export_binding', 'export default function f(){}', 'export function f(){}'],
    ['heritage', 'class B{} class A extends B{}', 'class B{} class A{}'],
  ];
for (const [kind, before, after] of contractFixtures) {
  test(`contract ${kind} retains evidence and is a hypothesis input`, async () => {
    const { detectContractChanges } = await import('../analysis/contracts.js');
    const changes = detectContractChanges(await parseFile('a.ts', before), await parseFile('a.ts', after));
    assert.ok(changes.some((item) => item.kind === kind && item.baseRange && item.headRange && item.classification === 'hypothesis_input'), kind);
  });
}

test('private helper impact reaches exported function and external caller', async () => {
  const { buildImpactReport } = await import('../analysis/impact.js');
  const before = new Map([['a.js', 'function helper(){return 1;} export function api(){return helper();}'], ['b.js', "import {api} from './a'; function use(){api();}"]]);
  const after = new Map(before); after.set('a.js', 'function helper(){return 2;} export function api(){return helper();}');
  const parse = async (files) => new Map(await Promise.all([...files].map(async ([file, code]) => [file, await parseFile(file, code)])));
  const report = await buildImpactReport({ baseSha: 'base', headSha: 'head', baseFacts: await parse(before), headFacts: await parse(after), baseFiles: before, headFiles: after, changedPaths: ['a.js'], hops: 2 });
  const caller = report.affectedCallers.find((item) => item.file === 'b.js');
  assert.equal(caller.hops, 2);
  assert.equal(caller.path.length, 2);
});

test('changing an existing parameter default value is a contract change', async () => {
  const { detectContractChanges } = await import('../analysis/contracts.js');
  for (const file of ['a.js', 'a.ts']) {
    const before = await parseFile(file, 'export function f(x=1){}');
    const after = await parseFile(file, 'export function f(x=2){}');
    assert.ok(detectContractChanges(before, after).some((change) => change.kind === 'parameter_default'));
  }
});

test('an export alias change appears as export_changed on the local symbol', async () => {
  const before = await parseFile('a.js', 'function f(){} export {f as oldName};');
  const after = await parseFile('a.js', 'function f(){} export {f as newName};');
  assert.ok(detectChangedSymbols(before, after).some((change) => change.changeTypes.includes('export_changed')));
});

test('arrow async and changed throw expressions retain contract evidence', async () => {
  const { detectContractChanges } = await import('../analysis/contracts.js');
  const before = await parseFile('a.js', 'export const f = x => {throw new TypeError();};');
  const after = await parseFile('a.js', 'export const f = async x => {throw new RangeError();};');
  const kinds = detectContractChanges(before, after).map((change) => change.kind);
  assert.ok(kinds.includes('async'));
  assert.ok(kinds.includes('throw_statements'));
});

test('missing candidate facts reduce neighborhood coverage without inventing callers', async () => {
  const { buildImpactReport } = await import('../analysis/impact.js');
  const facts = new Map([['a.js', await parseFile('a.js', 'function f(){}')]]);
  const files = new Map([['a.js', 'function f(){}'], ['missing.js', 'function missing(){}']]);
  const report = await buildImpactReport({ baseSha: 'base', headSha: 'head', baseFacts: facts, headFacts: facts, baseFiles: files, headFiles: files, changedPaths: ['missing.js'] });
  assert.ok(report.neighborhoodCoverage.unresolvedFiles >= 1);
  assert.ok(report.unresolved.some((lead) => lead.file === 'missing.js' && lead.reason === 'unindexed_target'));
  assert.equal(report.affectedCallers.length, 0);
});
