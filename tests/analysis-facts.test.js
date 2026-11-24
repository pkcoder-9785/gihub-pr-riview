import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import Parser from 'web-tree-sitter';

import { parseFile, isSupportedLanguageFile, detectLanguage, isMinified } from '../analysis/parser.js';
import {
  computeTokenFingerprint,
  computeSignatureFingerprint,
  computeStructureFingerprint,
} from '../analysis/fingerprint.js';
import {
  buildCommitManifest,
  extractTarFiles,
  extractTarStream,
  syncManifestFacts,
  isEligibleManifestFile,
  isConfigFile,
} from '../analysis/manifest.js';
import { PARSER_VERSION, ParseResultV3 } from '../analysis/types.js';

// ==========================================
// ITEM 2: Dependencies and Grammars
// ==========================================

test('Item 2: Exact versions are declared in package.json without carets', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  assert.equal(pkg.dependencies['zod'], '4.6.7', 'zod must be pinned to exact version 4.6.7');
  assert.equal(pkg.dependencies['web-tree-sitter'], '0.22.6', 'web-tree-sitter must be pinned to exact version 0.22.6');
  assert.equal(pkg.dependencies['tree-sitter-wasms'], '0.1.13', 'tree-sitter-wasms must be pinned to exact version 0.1.13');
});

test('Item 2: web-tree-sitter 0.22.6 loads tree-sitter-wasms 0.1.13 grammars (JS, TS, TSX)', async () => {
  await Parser.init();
  const parser = new Parser();

  // 1. tree-sitter-javascript.wasm
  const jsWasm = await Parser.Language.load(path.resolve('node_modules/tree-sitter-wasms/out/tree-sitter-javascript.wasm'));
  parser.setLanguage(jsWasm);
  const jsTree = parser.parse('function hello(name) { return "hello " + name; }');
  assert.equal(jsTree.rootNode.hasError, false);

  // 2. tree-sitter-javascript.wasm parsing JSX syntax
  // .jsx uses tree-sitter-javascript.wasm because it strictly parses JSX with JS semantics
  // without allowing TypeScript type annotations that would mask syntax errors in .jsx files.
  const jsxTree = parser.parse('const el = <button className="btn" onClick={onClick}><span>{label}</span></button>;');
  assert.equal(jsxTree.rootNode.hasError, false);
  assert.ok(jsxTree.rootNode.text.includes('<button className="btn"'));

  // 3. tree-sitter-typescript.wasm
  const tsWasm = await Parser.Language.load(path.resolve('node_modules/tree-sitter-wasms/out/tree-sitter-typescript.wasm'));
  parser.setLanguage(tsWasm);
  const tsTree = parser.parse('interface User<T> { id: string; data: T; }');
  assert.equal(tsTree.rootNode.hasError, false);

  // 4. tree-sitter-tsx.wasm
  const tsxWasm = await Parser.Language.load(path.resolve('node_modules/tree-sitter-wasms/out/tree-sitter-tsx.wasm'));
  parser.setLanguage(tsxWasm);
  const tsxTree = parser.parse('const Comp: React.FC<Props> = ({ title }) => <h1>{title}</h1>;');
  assert.equal(tsxTree.rootNode.hasError, false);
});

// ==========================================
// ITEM 3: Tarball Extractor
// ==========================================

function createTarBlock(fileName, contentStr, { typeflag = '0', prefix = '', sizeOverride = null } = {}) {
  const header = Buffer.alloc(512);
  header.write(fileName.slice(0, 100), 0, 100, 'utf8');
  header.write('000644 \0', 100, 8, 'utf8'); // mode
  header.write('000000 \0', 108, 8, 'utf8'); // uid
  header.write('000000 \0', 116, 8, 'utf8'); // gid

  const contentBuf = Buffer.from(contentStr, 'utf8');
  const size = sizeOverride !== null ? sizeOverride : contentBuf.length;
  header.write(size.toString(8).padStart(11, '0') + ' ', 124, 12, 'utf8'); // size octal
  header.write('00000000000 ', 136, 12, 'utf8'); // mtime
  header.write(typeflag, 156, 1, 'utf8'); // typeflag
  header.write('ustar\0', 257, 6, 'utf8'); // magic
  header.write('00', 263, 2, 'utf8');
  if (prefix) header.write(prefix.slice(0, 155), 345, 155, 'utf8');

  // Calculate simple chksum
  header.write('        ', 148, 8, 'utf8');
  let chksum = 0;
  for (let i = 0; i < 512; i++) chksum += header[i];
  header.write(chksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');

  const paddedSize = Math.ceil(contentBuf.length / 512) * 512;
  const body = Buffer.alloc(paddedSize);
  contentBuf.copy(body, 0);

  return Buffer.concat([header, body]);
}

test('Item 3: Tarball extractor streams gzipped input, parses GNU LongLink, PAX headers, and skips links', async () => {
  const repoPrefix = 'pkcoder-9785-code-pr-review-77e1aaf';
  const longPath = `${repoPrefix}/src/modules/very/deeply/nested/directory/structure/that/exceeds/one/hundred/characters/handler.ts`;

  // 1. PAX global header
  const paxGlobal = createTarBlock('pax_global_header', 'comment=GitHub archive\n', { typeflag: 'g' });

  // 2. GNU LongLink for long path (> 100 chars)
  const gnuLink = createTarBlock('././@LongLink', longPath + '\0', { typeflag: 'L' });
  const longFile = createTarBlock('dummy-short-name.ts', 'export const longPathOk = true;', { typeflag: '0' });

  // 3. Symlink entry (should be skipped)
  const symlinkBlock = createTarBlock(`${repoPrefix}/src/link.js`, 'target.js', { typeflag: '2' });

  // 4. Hardlink entry (should be skipped)
  const hardlinkBlock = createTarBlock(`${repoPrefix}/src/hardlink.js`, 'orig.js', { typeflag: '1' });

  // 5. Normal TS and config files
  const tsconfigBlock = createTarBlock(`${repoPrefix}/tsconfig.json`, '{"compilerOptions":{}}', { typeflag: '0' });
  const indexBlock = createTarBlock(`${repoPrefix}/src/index.js`, 'console.log("hello");', { typeflag: '0' });

  // 6. Zero blocks (EOF)
  const eof = Buffer.alloc(1024);

  const rawTar = Buffer.concat([paxGlobal, gnuLink, longFile, symlinkBlock, hardlinkBlock, tsconfigBlock, indexBlock, eof]);
  const gzippedTar = zlib.gzipSync(rawTar);

  // Stream gzipped archive through extractTarStream
  const result = await extractTarStream(Readable.from([gzippedTar]));

  assert.equal(result.isPartial, false);
  assert.equal(result.files.has('tsconfig.json'), true, 'tsconfig.json must be preserved');
  assert.equal(result.files.has('src/index.js'), true, 'src/index.js must be preserved');

  // Verify GNU long path was resolved and prefix stripped
  const expectedLong = 'src/modules/very/deeply/nested/directory/structure/that/exceeds/one/hundred/characters/handler.ts';
  assert.equal(result.files.has(expectedLong), true, 'GNU LongLink path must be extracted with stripped prefix');
  assert.equal(result.files.get(expectedLong), 'export const longPathOk = true;');

  // Verify symlink and hardlink were skipped
  assert.equal(result.files.has('src/link.js'), false, 'Symlink must be skipped');
  assert.equal(result.files.has('src/hardlink.js'), false, 'Hardlink must be skipped');
  assert.equal(result.skippedFiles.length, 2);
});

test('Item 3: Tarball extractor rejects path traversal, enforces size limits, and flags truncated streams', async () => {
  const repoPrefix = 'repo-1';

  // 1. Path traversal attempt
  const evilBlock = createTarBlock(`${repoPrefix}/../etc/passwd`, 'malicious', { typeflag: '0' });
  const eof = Buffer.alloc(1024);
  const evilTar = Buffer.concat([evilBlock, eof]);

  const traversalResult = await extractTarStream(Readable.from([evilTar]));
  assert.equal(traversalResult.isPartial, true);
  assert.ok(traversalResult.diagnostics.some((d) => d.message.includes('Path traversal rejected')));

  // 2. File size limit enforcement
  const bigContent = 'x'.repeat(1000);
  const bigBlock = createTarBlock(`${repoPrefix}/src/big.js`, bigContent, { typeflag: '0' });
  const normalBlock = createTarBlock(`${repoPrefix}/src/normal.js`, 'export const ok = 1;', { typeflag: '0' });
  const sizeTar = Buffer.concat([bigBlock, normalBlock, eof]);

  const sizeResult = await extractTarStream(Readable.from([sizeTar]), { maxFileSize: 500 });
  assert.equal(sizeResult.files.has('src/big.js'), false, 'Oversized file must not be extracted');
  assert.equal(sizeResult.files.has('src/normal.js'), true, 'Normal file must be extracted');
  assert.ok(sizeResult.skippedFiles.some((s) => s.path === 'src/big.js' && s.reason === 'file_size_limit'));

  // 3. Truncated / corrupt stream (does not crash, returns isPartial)
  const brokenStream = Readable.from([Buffer.from('not a valid gzip or tar stream at all')]);
  const brokenResult = await extractTarStream(brokenStream);
  assert.equal(brokenResult.isPartial, true);
  assert.ok(brokenResult.diagnostics.length > 0, 'Corrupted stream must produce diagnostic');
});

// ==========================================
// ITEM 4: Truncated Tree Subtree Walk
// ==========================================

test('Item 4: Truncated tree walking non-recursively completes within cap', async () => {
  const calls = [];
  const mockClient = {
    rest: {
      git: {
        getTree: async ({ tree_sha, recursive }) => {
          calls.push(tree_sha);
          if (tree_sha === 'root-sha' && !recursive) return { data: { truncated: false, tree: [ { type: 'tree', path: 'src', sha: 't-src' } ] } };
          if (tree_sha === 't-src') return { data: { truncated: false, tree: [ { type: 'blob', path: 'index.js', sha: 'b-idx' }, { type: 'tree', path: 'utils', sha: 't-utils' } ] } };
          if (tree_sha === 'root-sha') {
            return {
              data: {
                truncated: true,
                tree: [
                  { type: 'blob', path: 'src/index.js', sha: 'b-idx' },
                  { type: 'tree', path: 'src/utils', sha: 't-utils' },
                ],
              },
            };
          }
          if (tree_sha === 't-utils') {
            return {
              data: {
                truncated: false,
                tree: [
                  { type: 'blob', path: 'math.js', sha: 'b-math' },
                ],
              },
            };
          }
          throw new Error('Unexpected tree sha: ' + tree_sha);
        },
      },
    },
  };

  const res = await buildCommitManifest(mockClient, {
    owner: 'o',
    repo: 'r',
    commitSha: 'root-sha',
    maxSubtreeRequests: 5,
  });

  assert.equal(res.isPartial, false, 'Manifest should be complete after successful subtree walk');
  assert.equal(res.manifest.get('src/index.js'), 'b-idx');
  assert.equal(res.manifest.get('src/utils/math.js'), 'b-math');
  assert.equal(calls.length, 4, 'Root and every subtree should be requested non-recursively');
});

test('Item 4: Truncated tree walking hits request cap and lists affected paths', async () => {
  const mockClient = {
    rest: {
      git: {
        getTree: async ({ tree_sha }) => {
          return {
            data: {
              truncated: true,
              tree: [
                { type: 'tree', path: 'dir1', sha: 't1' },
                { type: 'tree', path: 'dir2', sha: 't2' },
                { type: 'tree', path: 'dir3', sha: 't3' },
              ],
            },
          };
        },
      },
    },
  };

  const res = await buildCommitManifest(mockClient, {
    owner: 'o',
    repo: 'r',
    commitSha: 'root-sha',
    maxSubtreeRequests: 2, // Strict cap
  });

  assert.equal(res.isPartial, true, 'Should mark isPartial when cap is reached');
  assert.ok(res.diagnostics.some((d) => d.message.includes('reached request cap of 2')));
});

// ==========================================
// ITEM 5: Safety and Robustness of Parsing
// ==========================================

test('Item 5: Minified-file heuristic and secret filtering in facts', async () => {
  // 1. Minified file heuristic
  const minifiedLine = 'const x = 1;' + 'a'.repeat(1200);
  assert.equal(isMinified(minifiedLine), true);
  const minResult = await parseFile('bundle.js', minifiedLine);
  assert.equal(minResult.parseStatus, 'partial');
  assert.ok(minResult.diagnostics.some((d) => d.message.includes('Minified file detected')));

  // 2. Secret filtering in facts: fake API key should NOT leak into usedIdentifiers or persisted facts
  const fakeSecret = 'sk-live-123456789012345678901234567890';
  const codeWithSecret = `
    const API_KEY = "${fakeSecret}";
    export function fetchWeather() {
      return get(API_KEY);
    }
  `;
  const secretResult = await parseFile('src/api.js', codeWithSecret);
  assert.equal(secretResult.parseStatus, 'complete');
  assert.equal(secretResult.usedIdentifiers.includes(fakeSecret), false, 'Fake secret must not be in usedIdentifiers');
  const serialized = JSON.stringify(secretResult);
  assert.equal(serialized.includes(fakeSecret), false, 'Fake secret must not appear anywhere in persisted facts JSON');
});

test('Item 5: Concurrent parser initialization is safe and reused', async () => {
  const promises = [];
  for (let i = 0; i < 20; i++) {
    promises.push(parseFile(`src/file_${i}.js`, `export function fn_${i}() { return ${i}; }`));
  }
  const results = await Promise.all(promises);
  assert.equal(results.length, 20);
  assert.ok(results.every((r) => r.parseStatus === 'complete'));
});

// ==========================================
// ITEM 6: Symbol Key Stability and Uniqueness
// ==========================================

test('Item 6: Symbol key is unique for anonymous functions, overloads, getters/setters, conditional decls', async () => {
  const code = `
    // 1. Overloaded functions
    function handle(x: string): void;
    function handle(x: number): void;
    function handle(x: any): void {}

    // 2. Getters and setters
    class Account {
      get balance(): number { return 0; }
      set balance(v: number) {}
    }

    // 3. Conditional declarations with same name
    if (true) {
      function run() { return 1; }
    } else {
      function run() { return 2; }
    }

    // 4. Anonymous callbacks
    const list = [1, 2].map((x) => x * 2).filter((x) => x > 2);
  `;

  const result = await parseFile('src/complex.ts', code);
  const keys = result.symbols.map((s) => s.symbolKey);
  const uniqueKeys = new Set(keys);
  assert.equal(keys.length, uniqueKeys.size, 'All symbol keys within the file must be strictly unique');

  // Verify getters and setters have distinct kinds in their symbolKey
  const getter = result.symbols.find((s) => s.kind === 'getter');
  const setter = result.symbols.find((s) => s.kind === 'setter');
  assert.ok(getter && setter);
  assert.notEqual(getter.symbolKey, setter.symbolKey);
  assert.ok(getter.symbolKey.includes('getter:balance'));
  assert.ok(setter.symbolKey.includes('setter:balance'));
});

test('Item 6: Symbol keys are stable under line shifts and comment changes', async () => {
  const codeA = `
    export function compute(a, b) {
      return a + b;
    }
  `;
  const codeB = `
    // Line shift with 20 padding comment lines
    // 1
    // 2
    // 3


    export function compute(a, b) {
      // Internal comment
      return a + b;
    }
  `;

  const resA = await parseFile('src/calc.js', codeA);
  const resB = await parseFile('src/calc.js', codeB);

  assert.equal(
    resA.symbols[0].symbolKey,
    resB.symbols[0].symbolKey,
    'Symbol key must remain identical despite line shifts and comments',
  );
});

test('Item 6: PARSER_VERSION bump invalidates cache', () => {
  assert.equal(PARSER_VERSION, 'v10', 'PARSER_VERSION must invalidate older cached facts');
});

// ==========================================
// ITEM 7: Per-symbol and Per-call Parse Confidence
// ==========================================

test('Item 7: Individual symbols overlapping syntax errors are marked low-confidence', async () => {
  const code = `
    export function goodFunction() {
      return 42;
    }

    export function brokenFunction( { let = ;
  `;

  const result = await parseFile('src/mixed.js', code);
  assert.equal(result.parseStatus, 'partial');

  const goodSym = result.symbols.find((s) => s.name === 'goodFunction');
  const brokenSym = result.symbols.find((s) => s.name === 'brokenFunction');

  assert.ok(goodSym, 'goodFunction symbol must be extracted');
  assert.equal(goodSym.confidence, 'high', 'goodFunction should have high confidence');
  assert.equal(goodSym.hasParseError, false);

  if (brokenSym) {
    assert.equal(brokenSym.confidence, 'low', 'brokenFunction overlapping ERROR node must be marked low confidence');
    assert.equal(brokenSym.hasParseError, true);
  }
});

// ==========================================
// EXISTING PHASE 1 TESTS (Store & Fingerprints)
// ==========================================

test('Fingerprint invariance: line shifts and formatting do not change body fingerprint', async () => {
  const codeOriginal = `
    function processOrder(order) {
      if (!order.id) throw new Error('invalid');
      return order.total * 1.1;
    }
  `;
  const codeShifted = `
    // Extra top comments and padding lines
    function processOrder(order) {
      // Internal line comment
      if (!order.id) throw new Error('invalid');
      return order.total * 1.1;
    }
  `;
  const resOrig = await parseFile('src/order.js', codeOriginal);
  const resShift = await parseFile('src/order.js', codeShifted);
  assert.equal(resOrig.symbols[0].bodyFingerprint, resShift.symbols[0].bodyFingerprint);
});

test('Structure fingerprint detects rename when logic skeleton is preserved', async () => {
  const codeA = `
    function calculateDiscount(price, rate) {
      const discount = price * rate;
      return price - discount;
    }
  `;
  const codeB = `
    function applyDeduction(amount, pct) {
      const cut = amount * pct;
      return amount - cut;
    }
  `;
  const resA = await parseFile('a.js', codeA);
  const resB = await parseFile('b.js', codeB);
  assert.equal(resA.symbols[0].structureFingerprint, resB.symbols[0].structureFingerprint);
});

test('Store file facts and identifier methods execute expected queries', async () => {
  const { Store } = await import('../review/store.js');
  const queries = [];
  const fakePool = {
    async query(sql, params) {
      queries.push({ sql: sql.trim(), params });
      if (sql.includes('SELECT facts, parse_status, indexed_at\n       FROM file_facts')) {
        return { rows: [{ facts: { symbols: [] }, parse_status: 'complete', indexed_at: '2026-11-23' }] };
      }
      if (sql.includes('SELECT blob_sha, facts, parse_status, indexed_at')) {
        return { rows: [{ blob_sha: 'sha-1', facts: { symbols: [] }, parse_status: 'complete', indexed_at: '2026-11-23' }] };
      }
      if (sql.includes('SELECT identifier, blob_sha\n       FROM file_identifier_index')) {
        return { rows: [{ identifier: 'compute', blob_sha: 'sha-1' }] };
      }
      if (sql.includes('DELETE FROM file_facts')) {
        return { rowCount: 5 };
      }
      return { rows: [] };
    },
    async end() {},
  };

  const store = new Store('postgres://localhost/test');
  store.ready = Promise.resolve();
  store.pool = fakePool;

  await store.upsertFileFacts({
    repositoryId: 10,
    blobSha: 'sha-1',
    parserVersion: 'v2',
    facts: { symbols: [] },
    parseStatus: 'complete',
    identifiers: ['compute', 'validate'],
  });
  assert.ok(queries.some((q) => q.sql.includes('INSERT INTO file_facts')));
  assert.ok(queries.some((q) => q.sql.includes('INSERT INTO file_identifier_index')));

  const fact = await store.getFileFacts(10, 'sha-1', 'v2');
  assert.equal(fact.parseStatus, 'complete');

  const batch = await store.batchGetFileFacts(10, ['sha-1'], 'v2');
  assert.equal(batch.has('sha-1'), true);

  const ids = await store.findBlobShasWithIdentifiers(10, ['compute']);
  assert.ok(ids.has('compute'));

  const pruned = await store.pruneOldFacts(14);
  assert.equal(pruned, 5);
});

test('facts preserve enclosing symbol links, exported variables and literal whitespace', async () => {
  const a = await parseFile('src/file.js', "export const LIMIT = 10; function run() { return target(' hello '); }");
  const b = await parseFile('src/file.js', "export const LIMIT = 10; function run() { return target('hello'); }");
  assert.ok(a.exports.some((item) => item.name === 'LIMIT'));
  assert.ok(a.symbols.some((item) => item.name === 'LIMIT' && item.kind === 'variable'));
  assert.ok(a.symbols.some((item) => item.symbolKey === a.callSites[0].enclosingSymbolKey));
  assert.notEqual(a.symbols.find((item) => item.name === 'run').bodyFingerprint, b.symbols.find((item) => item.name === 'run').bodyFingerprint);
});

test('all persisted facts redact synthetic secrets including import sources and references', async () => {
  const secret = 'ghp_' + 'x'.repeat(20);
  const result = await parseFile('src/file.js', `import x from 'https://example.invalid/${secret}'; export function ${secret}() { send(${secret}); }`);
  assert.equal(result.parseStatus, 'complete');
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('facts sync handles config files and cached blobs with different paths and languages', async () => {
  const cached = await parseFile('old.jsx', 'const C = <Button/>;');
  const contents = { blob: 'const C = <Button/>;', config: '{"name":"x"}' };
  const client = { rest: { repos: { downloadTarballArchive: async () => { throw new Error('unavailable'); } }, git: { getBlob: async ({ file_sha }) => ({ data: { encoding: 'base64', content: Buffer.from(contents[file_sha]).toString('base64') } }) } } };
  const result = await syncManifestFacts({ client, store: { batchGetFileFacts: async () => new Map([['blob', { facts: cached }]]) }, repositoryId: 1, owner: 'o', repo: 'r', commitSha: 'c', manifest: new Map([['new.ts', 'blob'], ['package.json', 'config']]) });
  assert.equal(result.factsMap.get('new.ts').path, 'new.ts');
  assert.equal(result.factsMap.get('new.ts').language, 'typescript');
  assert.equal(result.stats.isPartial, true);
  assert.ok(result.diagnostics.some((item) => item.message.includes('Config file not parsed')));
});

test('truncated trees re-read directories even when some files were returned', async () => {
  const calls = [];
  const client = { rest: { git: { getTree: async (args) => {
    calls.push(args);
    if (args.recursive) return { data: { truncated: true, tree: [{ type: 'tree', path: 'src', sha: 'dir' }, { type: 'blob', path: 'src/a.js', sha: 'a' }] } };
    if (args.tree_sha === 'root') return { data: { truncated: false, tree: [{ type: 'tree', path: 'src', sha: 'dir' }] } };
    return { data: { truncated: false, tree: [{ type: 'blob', path: 'a.js', sha: 'a' }, { type: 'blob', path: 'b.js', sha: 'b' }] } };
  } } } };
  const result = await buildCommitManifest(client, { owner: 'o', repo: 'r', commitSha: 'root' });
  assert.equal(result.manifest.get('src/b.js'), 'b');
  assert.equal(result.isPartial, false);
  assert.ok(calls.slice(1).every((args) => !args.recursive));
});

test('parser returns a partial result when worker exceeds its deadline', async () => {
  const result = await parseFile('slow.js', 'function test(){return 1;}', { timeoutMs: 1 });
  assert.equal(result.parseStatus, 'partial');
  assert.ok(result.diagnostics.some((item) => item.message.includes('timed out')));
});

test('oversized tar payload is discarded and later files are still read', async () => {
  const big = createTarBlock('repo/big.js', 'x'.repeat(128 * 1024));
  const small = createTarBlock('repo/ok.js', 'const x = 1;');
  const data = Buffer.concat([big, small, Buffer.alloc(1024)]);
  async function* chunks() { for (let i = 0; i < data.length; i += 1024) yield data.subarray(i, i + 1024); }
  const result = await extractTarStream(Readable.from(chunks()), { maxFileSize: 100 });
  assert.equal(result.isPartial, true);
  assert.equal(result.files.get('ok.js'), 'const x = 1;');
  assert.ok(result.skippedFiles.some((item) => item.path === 'big.js'));
});
