import test from 'node:test';
import assert from 'node:assert/strict';
import { createModuleResolver } from '../analysis/resolver.js';
import { parseFile } from '../analysis/parser.js';

test('module resolution uses only the supplied manifest and tsconfig paths', () => {
  const files = new Map([['tsconfig.json', '{"compilerOptions":{"baseUrl":".","paths":{"@app/*":["src/*"]}}}'], ['src/main.ts', ''], ['src/service.ts', '']]);
  const resolver = createModuleResolver(files);
  assert.deepEqual(resolver.resolve('src/main.ts', '@app/service'), { status: 'resolved', file: 'src/service.ts' });
  assert.equal(resolver.resolve('src/main.ts', 'outside-package').reason, 'external_package');
  assert.equal(resolver.resolve('src/main.ts', './missing').reason, 'unindexed_target');
});

test('parser records receiver, computed call and containing symbol identity', async () => {
  const facts = await parseFile('src/a.js', 'function f() { obj.run(); obj[key](); }');
  assert.equal(facts.callSites[0].receiver, 'obj');
  assert.equal(facts.callSites[1].computed, true);
  assert.equal(facts.callSites[0].enclosingSymbolKey, facts.symbols[0].symbolKey);
  assert.ok(Number.isInteger(facts.callSites[0].byteOffset));
});

test('graph callers exclude import edges and retain separate site evidence', async () => {
  const { createGraph } = await import('../analysis/graph.js');
  const edges = [
    { type: 'direct_call', file: 'a.js', callerSymbolKey: 'caller', targetSymbolKey: 'target', byteOffset: 3, resolution: 'confirmed' },
    { type: 'direct_call', file: 'a.js', callerSymbolKey: 'caller', targetSymbolKey: 'target', byteOffset: 8, resolution: 'confirmed' },
    { type: 'import', file: 'a.js', callerSymbolKey: null, targetSymbolKey: 'target', byteOffset: 0, resolution: 'confirmed' },
  ];
  const graph = createGraph(edges);
  const result = graph.getCallers('target');
  assert.equal(result.confirmed.length, 2);
  assert.notEqual(result.confirmed[0].edge_key, result.confirmed[1].edge_key);
  assert.ok(result.confirmed.every((edge) => edge.type !== 'import'));
  assert.equal(graph.getImporters('target').length, 1);
  assert.equal(graph.getCallers('target', { cap: 1 }).truncated, true);
});

test('symbol resolver does not confirm parameter-shadowed calls', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const facts = await parseFile('a.js', 'function run() {} function call(run) { run(); }');
  const resolver = createSymbolResolver({ facts: new Map([['a.js', facts]]), moduleResolver: createModuleResolver(new Map([['a.js', '']])) });
  assert.notEqual(resolver.resolve('a.js', facts.callSites[0]).resolution, 'confirmed');
});

test('destructured bindings and arrow parameters cannot be guessed as global calls', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  for (const code of ['function run() {} function call(x) { const {run} = x; run(); }', 'function run() {} const call = run => run();']) {
    const facts = await parseFile('a.js', code);
    const resolver = createSymbolResolver({ facts: new Map([['a.js', facts]]), moduleResolver: createModuleResolver(new Map([['a.js', '']])) });
    assert.notEqual(resolver.resolve('a.js', facts.callSites.at(-1)).resolution, 'confirmed');
  }
});

test('unique local and aliased imports resolve with explicit evidence', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const code = new Map([['a.js', 'export function validateUser() {}'], ['b.js', "import { validateUser as check } from './a'; function local() {} function f(){ local(); check(); }"]]);
  const facts = new Map(await Promise.all([...code].map(async ([file, text]) => [file, await parseFile(file, text)])));
  const resolver = createSymbolResolver({ facts, moduleResolver: createModuleResolver(code) });
  const calls = facts.get('b.js').callSites.map((site) => resolver.resolve('b.js', site));
  assert.deepEqual(calls.map((x) => x.resolution), ['confirmed', 'confirmed']);
  for (const result of calls) { assert.equal(result.candidates.length, 1); assert.ok(result.explanation.includes(result.target.symbol.symbolKey)); }
});

test('namespace import shadowed by a local object is not confirmed', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const files = new Map([['a.js', 'export function run() {}'], ['b.js', "import * as api from './a'; function f(){ const api = {}; api.run(); }"]]);
  const facts = new Map(await Promise.all([...files].map(async ([file, text]) => [file, await parseFile(file, text)])));
  const resolver = createSymbolResolver({ facts, moduleResolver: createModuleResolver(files) });
  assert.notEqual(resolver.resolve('b.js', facts.get('b.js').callSites[0]).resolution, 'confirmed');
});

test('type-only imports never confirm runtime bindings', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const files = new Map([['a.ts', 'export function run() {}'], ['b.ts', "import type {run} from './a'; function f(){ run(); }"]]);
  const facts = new Map(await Promise.all([...files].map(async ([file, text]) => [file, await parseFile(file, text)])));
  const resolver = createSymbolResolver({ facts, moduleResolver: createModuleResolver(files) });
  assert.notEqual(resolver.resolve('b.ts', facts.get('b.ts').callSites[0]).resolution, 'confirmed');
});

test('nested lexical scope resolves a closure and rejects out-of-scope declarations', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const code = 'function outer(){ function helper(){} function inner(){ helper(); } } function other(){ helper(); }';
  const facts = await parseFile('a.js', code);
  const resolver = createSymbolResolver({ facts: new Map([['a.js', facts]]), moduleResolver: createModuleResolver(new Map([['a.js', code]])) });
  assert.equal(resolver.resolve('a.js', facts.callSites[0]).resolution, 'confirmed');
  assert.notEqual(resolver.resolve('a.js', facts.callSites[1]).resolution, 'confirmed');
});

test('class method name alone cannot establish a direct global binding', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const code = 'class A { run() {} } function f(){ run(); }';
  const facts = await parseFile('a.js', code);
  const resolver = createSymbolResolver({ facts: new Map([['a.js', facts]]), moduleResolver: createModuleResolver(new Map([['a.js', code]])) });
  assert.notEqual(resolver.resolve('a.js', facts.callSites[0]).resolution, 'confirmed');
});

test('CommonJS destructuring, namespace and direct require resolve static exports', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const files = new Map([['a.js', 'function run() {} module.exports = {run};'], ['b.js', "const {run: check} = require('./a'); const api = require('./a'); function f(){ check(); api.run(); require('./a').run(); }"]]);
  const facts = new Map(await Promise.all([...files].map(async ([file, text]) => [file, await parseFile(file, text)])));
  const resolver = createSymbolResolver({ facts, moduleResolver: createModuleResolver(files) });
  const resolved = facts.get('b.js').callSites.map((site) => resolver.resolve('b.js', site));
  assert.deepEqual(resolved.map((x) => x.resolution), ['confirmed', 'confirmed', 'confirmed']);
  assert.ok(resolved.every((x) => x.candidates.length === 1 && x.explanation.includes('a.js')));
});

test('nested CommonJS destructuring cannot create a global confirmed binding', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const files = new Map([['a.js', 'function run(){} module.exports={run};'], ['b.js', "if (condition) { const {run} = require('./a'); } function use(){run();}"]]);
  const facts = new Map(await Promise.all([...files].map(async ([file, text]) => [file, await parseFile(file, text)])));
  const resolver = createSymbolResolver({ facts, moduleResolver: createModuleResolver(files) });
  assert.notEqual(resolver.resolve('b.js', facts.get('b.js').callSites.at(-1)).resolution, 'confirmed');
});

test('unique this method, inherited method and exact local instance are grounded', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const code = 'class A { run(){} execute(){this.run();} } class B extends A {go(){this.run();}} const x = new B(); function caller(){x.run();}';
  const facts = await parseFile('a.ts', code);
  const resolver = createSymbolResolver({ facts: new Map([['a.ts', facts]]), moduleResolver: createModuleResolver(new Map([['a.ts', code]])) });
  const results = facts.callSites.filter((site) => site.calleeName === 'run').map((site) => resolver.resolve('a.ts', site));
  assert.deepEqual(results.map((item) => item.resolution), ['confirmed', 'confirmed', 'confirmed']);
  assert.ok(results.every((item) => item.target.symbol.name === 'run'));
});

test('method overrides and typed but non-exact receivers stay probable', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const code = 'class A { run(){} execute(){this.run();} } class B extends A {run(){}} let x: A; function f(){x.run();}';
  const facts = await parseFile('a.ts', code);
  const resolver = createSymbolResolver({ facts: new Map([['a.ts', facts]]), moduleResolver: createModuleResolver(new Map([['a.ts', code]])) });
  const results = facts.callSites.filter((site) => site.calleeName === 'run').map((site) => resolver.resolve('a.ts', site));
  assert.ok(results.every((item) => item.resolution !== 'confirmed'));
});

test('instance resolution refuses shadowed and out-of-scope receiver bindings', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const code = 'class A { run(){} } function outer(){ const x = new A(); x.run(); } function other(){ x.run(); }';
  const facts = await parseFile('a.js', code);
  const resolver = createSymbolResolver({ facts: new Map([['a.js', facts]]), moduleResolver: createModuleResolver(new Map([['a.js', code]])) });
  const calls = facts.callSites.filter((site) => site.calleeName === 'run');
  assert.equal(resolver.resolve('a.js', calls[0]).resolution, 'confirmed');
  assert.notEqual(resolver.resolve('a.js', calls[1]).resolution, 'confirmed');
});

test('typed class field and constructor parameter property yield probable method leads', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const code = 'class Service { run(){} } class Client { field: Service; constructor(private dep: Service){} go(){this.field.run(); this.dep.run();} }';
  const facts = await parseFile('a.ts', code);
  const resolver = createSymbolResolver({ facts: new Map([['a.ts', facts]]), moduleResolver: createModuleResolver(new Map([['a.ts', code]])) });
  const calls = facts.callSites.filter((site) => site.calleeName === 'run');
  const results = calls.map((site) => resolver.resolve('a.ts', site));
  assert.deepEqual(results.map((x) => x.resolution), ['probable', 'probable']);
  assert.ok(results.every((x) => x.target.symbol.name === 'run'));
});

test('workspace package exports resolve using the virtual TypeScript host', () => {
  const files = new Map([['package.json', '{"private":true,"workspaces":["packages/*"]}'], ['packages/lib/package.json', '{"name":"@work/lib","exports":{".":"./src/index.js"}}'], ['packages/lib/src/index.ts', 'export function run(){}'], ['app/main.ts', '']]);
  const resolver = createModuleResolver(files);
  assert.deepEqual(resolver.resolve('app/main.ts', '@work/lib'), { status: 'resolved', file: 'packages/lib/src/index.ts' });
});

test('shadowing a constructor cannot confirm the class method binding', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const code = 'class A {run(){}} function f(A){const x = new A(); x.run();}';
  const facts = await parseFile('a.js', code);
  const resolver = createSymbolResolver({ facts: new Map([['a.js', facts]]), moduleResolver: createModuleResolver(new Map([['a.js', code]])) });
  assert.notEqual(resolver.resolve('a.js', facts.callSites.find((site) => site.calleeName === 'run')).resolution, 'confirmed');
});

test('replaced CommonJS exports cannot confirm stale export bindings', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const files = new Map([['a.js', 'function first(){} function second(){} module.exports={first}; module.exports={second};'], ['b.js', "const {first} = require('./a'); function f(){first();}"]]);
  const facts = new Map(await Promise.all([...files].map(async ([file, code]) => [file, await parseFile(file, code)])));
  const resolver = createSymbolResolver({ facts, moduleResolver: createModuleResolver(files) });
  assert.notEqual(resolver.resolve('b.js', facts.get('b.js').callSites[0]).resolution, 'confirmed');
});

test('import and reexport edges are separate from confirmed caller results', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const { buildGraph } = await import('../analysis/graph.js');
  const files = new Map([['a.js', 'export function run(){}'], ['barrel.js', "export {run} from './a';"], ['b.js', "import {run} from './barrel'; function f(){run();}"]]);
  const facts = new Map(await Promise.all([...files].map(async ([file, code]) => [file, await parseFile(file, code)])));
  const resolver = createSymbolResolver({ facts, moduleResolver: createModuleResolver(files) });
  const graph = await buildGraph({ files: [...files.keys()], loadFacts: async (file) => facts.get(file), resolver });
  const key = facts.get('a.js').symbols[0].symbolKey;
  assert.deepEqual(new Set(graph.getImporters(key).map((edge) => edge.type)), new Set(['import', 'reexport']));
  assert.ok(graph.getCallers(key).confirmed.every((edge) => !['import', 'reexport'].includes(edge.type)));
});

test('fixture invariant: confirmed edges carry one target and explicit evidence', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const { buildGraph } = await import('../analysis/graph.js');
  const fixtures = [
    new Map([['a.js', 'function run(){} function use(){run();}']]),
    new Map([['a.js', 'export function run(){}'], ['b.js', "import {run as go} from './a'; function use(){go();}"]]),
    new Map([['a.js', 'function run(){} module.exports={run};'], ['b.js', "const {run} = require('./a'); function use(){run();}"]]),
    new Map([['a.ts', 'class A { run(){} go(){this.run();}}']]),
    new Map([['a.js', 'function f(run){run();} function run(){}']]),
    new Map([['a.js', 'export default function run(){}'], ['b.js', "import go from './a'; function f(){go();}"]]),
    new Map([['a.js', 'export function run(){}'], ['b.js', "import * as api from './a'; function f(){api.run();}"]]),
    new Map([['a.js', 'export function run(){}'], ['c.js', "export * from './a';"], ['b.js', "import {run} from './c'; function f(){run();}"]]),
    new Map([['a.jsx', 'function Widget(){return null;} function f(){return <Widget/>;}']]),
    new Map([['a.js', 'function callback(){} function f(){ use(callback); }']]),
    new Map([['a.ts', 'class A { run(){} } class B extends A {go(){this.run();}}']]),
    new Map([['a.js', 'function f(obj,key){obj[key]();}']]),
    new Map([['a.js', 'function run(){} function f(run){run();}']]),
  ];
  let confirmedCount = 0;
  for (const files of fixtures) {
    const facts = new Map(await Promise.all([...files].map(async ([file, code]) => [file, await parseFile(file, code)])));
    const resolver = createSymbolResolver({ facts, moduleResolver: createModuleResolver(files) });
    const graph = await buildGraph({ files: [...files.keys()], loadFacts: async (file) => facts.get(file), resolver });
    for (const edge of graph.edges.filter((item) => item.resolution === 'confirmed')) {
      confirmedCount++;
      assert.equal(edge.candidates.length, 1);
      assert.equal(edge.targetSymbolKey, edge.candidates[0].symbol.symbolKey);
      assert.ok(edge.explanation.includes(edge.targetSymbolKey));
      assert.ok(graph.getCallers(edge.targetSymbolKey).confirmed.every((caller) => !['import', 'reexport'].includes(caller.type)));
    }
  }
  assert.ok(confirmedCount >= 4);
});

test('JSX and callback references have distinct site evidence and usable edges', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const { buildGraph } = await import('../analysis/graph.js');
  const code = 'function Widget(){return null;} function callback(){} function render(){ use(callback); return <Widget/>; }';
  const facts = await parseFile('a.jsx', code);
  const resolver = createSymbolResolver({ facts: new Map([['a.jsx', facts]]), moduleResolver: createModuleResolver(new Map([['a.jsx', code]])) });
  const graph = await buildGraph({ files: ['a.jsx'], loadFacts: async () => facts, resolver });
  assert.ok(graph.edges.some((edge) => edge.type === 'jsx_use' && edge.resolution === 'confirmed'));
  assert.ok(graph.edges.some((edge) => edge.type === 'value_ref' && edge.resolution === 'confirmed'));
});

test('conditional CommonJS exports cannot establish a confirmed binding', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const files = new Map([['a.js', 'function init(){ function run(){} module.exports={run}; }'], ['b.js', "const {run}=require('./a'); function f(){run();}"]]);
  const facts = new Map(await Promise.all([...files].map(async ([file, code]) => [file, await parseFile(file, code)])));
  const resolver = createSymbolResolver({ facts, moduleResolver: createModuleResolver(files) });
  assert.notEqual(resolver.resolve('b.js', facts.get('b.js').callSites[0]).resolution, 'confirmed');
});

test('default imports and export-star chains resolve without guessing through cycles', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const files = new Map([['base.js', 'export default function run(){}'], ['use.js', "import go from './base'; function f(){go();}"], ['a.js', "export * from './b';"], ['b.js', "export * from './a';"], ['cycle.js', "import {foo} from './a'; function f(){foo();}"]]);
  const facts = new Map(await Promise.all([...files].map(async ([file, code]) => [file, await parseFile(file, code)])));
  const resolver = createSymbolResolver({ facts, moduleResolver: createModuleResolver(files) });
  assert.equal(resolver.resolve('use.js', facts.get('use.js').callSites[0]).resolution, 'confirmed');
  const cycle = resolver.resolve('cycle.js', facts.get('cycle.js').callSites[0]);
  assert.notEqual(cycle.resolution, 'confirmed');
  assert.equal(cycle.reason, 'cycle_limit');
});

test('computed and Reflect.apply calls remain unresolved', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const code = 'function f(obj,key,fn){obj[key](); Reflect.apply(fn, obj, []);}';
  const facts = await parseFile('a.js', code);
  const resolver = createSymbolResolver({ facts: new Map([['a.js', facts]]), moduleResolver: createModuleResolver(new Map([['a.js', code]])) });
  const results = facts.callSites.map((site) => resolver.resolve('a.js', site));
  assert.deepEqual(results.map((result) => result.reason), ['computed_member', 'dynamic_call']);
  assert.ok(results.every((result) => result.resolution === 'unresolved'));
});

test('calls from syntax-error files never receive confirmed status', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const code = 'function target(){} function broken(){ target(); const x = ; }';
  const facts = await parseFile('a.js', code);
  const resolver = createSymbolResolver({ facts: new Map([['a.js', facts]]), moduleResolver: createModuleResolver(new Map([['a.js', code]])) });
  assert.equal(facts.parseStatus, 'partial');
  assert.notEqual(resolver.resolve('a.js', facts.callSites[0]).resolution, 'confirmed');
});

test('caller traversal ends on cycles and records complete two-hop evidence', async () => {
  const { createGraph } = await import('../analysis/graph.js');
  const edges = [{type:'direct_call', file:'a', callerSymbolKey:'A', targetSymbolKey:'B', byteOffset:1, resolution:'confirmed'}, {type:'direct_call', file:'b', callerSymbolKey:'B', targetSymbolKey:'A', byteOffset:2, resolution:'confirmed'}];
  const result = createGraph(edges).getCallers('A', {hops:2, cap:20});
  assert.equal(result.confirmed.length, 2);
  assert.equal(result.confirmed[1].path.length, 2);
});

test('tsconfig extends works and absent aliases never guess', () => {
  const files = new Map([['tsconfig.json', '{"extends":"./cfg/base.json"}'], ['cfg/base.json', '{"compilerOptions":{"baseUrl":"..","paths":{"@app/*":["src/*"]}}}'], ['src/a.ts', ''], ['src/b.ts', '']]);
  assert.deepEqual(createModuleResolver(files).resolve('src/a.ts', '@app/b'), { status: 'resolved', file: 'src/b.ts' });
  const missing = new Map([['src/a.ts', ''], ['src/b.ts', '']]);
  assert.notEqual(createModuleResolver(missing).resolve('src/a.ts', '@app/b').status, 'resolved');
});

test('CommonJS require property alias resolves and unknown receiver remains ambiguous', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const files = new Map([['a.js', 'function run(){} exports.run=run;'], ['b.js', "const invoke=require('./a').run; class X {m(){}} class Y {m(){}} function f(obj){invoke(); obj.m();}"]]);
  const facts = new Map(await Promise.all([...files].map(async ([file, code]) => [file, await parseFile(file, code)])));
  const resolver = createSymbolResolver({ facts, moduleResolver: createModuleResolver(files) });
  const calls = facts.get('b.js').callSites;
  assert.equal(resolver.resolve('b.js', calls.find((c) => c.calleeName === 'invoke')).resolution, 'confirmed');
  assert.notEqual(resolver.resolve('b.js', calls.find((c) => c.calleeName === 'm')).resolution, 'confirmed');
});

test('star reexports appear in importer queries without appearing in caller queries', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const { buildGraph } = await import('../analysis/graph.js');
  const files = new Map([['a.js', 'export function run(){}'], ['barrel.js', "export * from './a';"], ['b.js', "import {run} from './barrel'; function f(){run();}"]]);
  const facts = new Map(await Promise.all([...files].map(async ([file, code]) => [file, await parseFile(file, code)])));
  const resolver = createSymbolResolver({ facts, moduleResolver: createModuleResolver(files) });
  const graph = await buildGraph({ files: [...files.keys()], loadFacts: async (file) => facts.get(file), resolver });
  const key = facts.get('a.js').symbols[0].symbolKey;
  assert.ok(graph.getImporters(key).some((edge) => edge.type === 'reexport'));
  assert.ok(graph.getCallers(key).confirmed.every((edge) => edge.type !== 'reexport'));
});

test('conditional bare CommonJS assignment cannot become confirmed', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const files = new Map([['a.js', 'function run(){} if (flag) module.exports={run};'], ['b.js', "const {run}=require('./a'); function f(){run();}"]]);
  const facts = new Map(await Promise.all([...files].map(async ([file, code]) => [file, await parseFile(file, code)])));
  const resolver = createSymbolResolver({ facts, moduleResolver: createModuleResolver(files) });
  assert.notEqual(resolver.resolve('b.js', facts.get('b.js').callSites[0]).resolution, 'confirmed');
});

test('unique cross-file inherited method retains the import evidence chain', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const files = new Map([['base.ts', 'export class Base {run(){}}'], ['child.ts', "import {Base as Parent} from './base'; class Child extends Parent {go(){this.run();}}"]]);
  const facts = new Map(await Promise.all([...files].map(async ([file, code]) => [file, await parseFile(file, code)])));
  const resolver = createSymbolResolver({ facts, moduleResolver: createModuleResolver(files) });
  const result = resolver.resolve('child.ts', facts.get('child.ts').callSites[0]);
  assert.equal(result.resolution, 'confirmed');
  assert.equal(result.target.file, 'base.ts');
  assert.ok(result.explanation.includes('./base'));
});

test('anonymous CommonJS function exports resolve only when uniquely bound', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const files = new Map([['a.js', 'module.exports = function(){return 1;};'], ['b.js', "const go = require('./a'); function f(){go();}"]]);
  const facts = new Map(await Promise.all([...files].map(async ([file, code]) => [file, await parseFile(file, code)])));
  const resolver = createSymbolResolver({ facts, moduleResolver: createModuleResolver(files) });
  const result = resolver.resolve('b.js', facts.get('b.js').callSites[0]);
  assert.equal(result.resolution, 'confirmed');
  assert.equal(result.target.symbol.name, 'anonymous');
});

test('graph refuses incorrectly confirmed edges lacking unique target evidence', async () => {
  const { buildGraph } = await import('../analysis/graph.js');
  const facts = await parseFile('a.js', 'function f(){unknown();}');
  const resolver = { resolve: () => ({ resolution: 'confirmed', candidates: [], target: { symbol: { symbolKey: 'guessed' } }, explanation: '' }) };
  const graph = await buildGraph({ files: ['a.js'], loadFacts: async () => facts, resolver });
  assert.equal(graph.edges[0].resolution, 'unresolved');
  assert.equal(graph.edges[0].targetSymbolKey, null);
});

test('same-file class inheritance resolves an extends dependency', async () => {
  const { createSymbolResolver } = await import('../analysis/resolver.js');
  const { buildGraph } = await import('../analysis/graph.js');
  const code = 'class Base{} class Child extends Base{}';
  const facts = await parseFile('a.ts', code);
  const resolver = createSymbolResolver({ facts: new Map([['a.ts', facts]]), moduleResolver: createModuleResolver(new Map([['a.ts', code]])) });
  const graph = await buildGraph({ files: ['a.ts'], loadFacts: async () => facts, resolver });
  assert.ok(graph.edges.some((edge) => edge.type === 'extends' && edge.resolution === 'confirmed'));
});
