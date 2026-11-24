import path from 'node:path';
import Parser from 'web-tree-sitter';
import { Worker } from 'node:worker_threads';
import { extractFileFacts } from './queries.js';
import { ParseResultV3 } from './types.js';

let parserInstance = null;
let parserInitPromise = null;
const loadedLanguages = new Map();
const languageLoadingPromises = new Map();

const EXTENSION_MAP = {
  '.js': { lang: 'javascript', wasm: 'tree-sitter-javascript.wasm' },
  '.cjs': { lang: 'javascript', wasm: 'tree-sitter-javascript.wasm' },
  '.mjs': { lang: 'javascript', wasm: 'tree-sitter-javascript.wasm' },
  '.jsx': { lang: 'jsx', wasm: 'tree-sitter-javascript.wasm' },
  '.ts': { lang: 'typescript', wasm: 'tree-sitter-typescript.wasm' },
  '.cts': { lang: 'typescript', wasm: 'tree-sitter-typescript.wasm' },
  '.mts': { lang: 'typescript', wasm: 'tree-sitter-typescript.wasm' },
  '.tsx': { lang: 'tsx', wasm: 'tree-sitter-tsx.wasm' },
};

export const SUPPORTED_EXTENSIONS = Object.keys(EXTENSION_MAP);

export function isSupportedLanguageFile(filePath) {
  if (typeof filePath !== 'string') return false;
  const ext = path.extname(filePath).toLowerCase();
  return Boolean(EXTENSION_MAP[ext]);
}

export function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_MAP[ext]?.lang || null;
}

export function isMinified(content) {
  if (typeof content !== 'string') return false;
  const lines = content.split(/\r?\n/);
  if (lines.some((line) => line.length > 1000)) return true;
  if (lines.length > 5) {
    const avgLen = content.length / lines.length;
    if (avgLen > 250) return true;
  }
  return false;
}

async function getParser() {
  if (parserInstance) return parserInstance;
  if (!parserInitPromise) {
    parserInitPromise = (async () => {
      await Parser.init();
      parserInstance = new Parser();
      return parserInstance;
    })();
  }
  return parserInitPromise;
}

async function getLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const config = EXTENSION_MAP[ext];
  if (!config) {
    throw new Error(`Unsupported file type: ${ext} for ${filePath}`);
  }

  if (loadedLanguages.has(config.wasm)) {
    return { lang: config.lang, languageObj: loadedLanguages.get(config.wasm) };
  }

  if (!languageLoadingPromises.has(config.wasm)) {
    const loadPromise = (async () => {
      const wasmPath = path.resolve('node_modules/tree-sitter-wasms/out', config.wasm);
      const languageObj = await Parser.Language.load(wasmPath);
      loadedLanguages.set(config.wasm, languageObj);
      languageLoadingPromises.delete(config.wasm);
      return languageObj;
    })();
    languageLoadingPromises.set(config.wasm, loadPromise);
  }

  const languageObj = await languageLoadingPromises.get(config.wasm);
  return { lang: config.lang, languageObj };
}

/**
 * Parses a single file and extracts deterministic AST facts.
 * Enforces file size limits, minified file heuristics, and parse timeout.
 */
export async function parseFile(filePath, content, { maxSize = 500 * 1024, timeoutMs = 3000, inWorker = false } = {}) {
  const language = detectLanguage(filePath);
  if (!language) {
    throw new Error(`Cannot parse unsupported file format: ${filePath}`);
  }

  if (typeof content !== 'string') {
    content = String(content || '');
  }

  if (Buffer.byteLength(content, 'utf8') > maxSize) {
    return ParseResultV3.parse({
      path: filePath,
      language,
      symbols: [],
      imports: [],
      exports: [],
      callSites: [],
      jsxUsages: [],
      valueReferences: [],
      extendsImplements: [],
      usedIdentifiers: [],
      diagnostics: [{
        level: 'warning',
        message: `File exceeds maximum parseable size of ${maxSize} bytes; skipped`,
        range: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
      }],
      parseStatus: 'partial',
    });
  }

  if (isMinified(content)) {
    return ParseResultV3.parse({
      path: filePath,
      language,
      symbols: [],
      imports: [],
      exports: [],
      callSites: [],
      jsxUsages: [],
      valueReferences: [],
      extendsImplements: [],
      usedIdentifiers: [],
      diagnostics: [{
        level: 'warning',
        message: 'Minified file detected (line length > 1000); skipped',
        range: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
      }],
      parseStatus: 'partial',
    });
  }

  let timer;
  try {
    let facts;
    if (inWorker) {
      const parser = await getParser();
      const { languageObj } = await getLanguage(filePath);
      parser.setLanguage(languageObj);
      const tree = parser.parse(content);
      const query = languageObj.query(`[(import_statement) (export_statement) (call_expression)] @structural`);
      try {
        const captures = new Set(query.captures(tree.rootNode).map(({ node }) => `${node.type}:${node.startIndex}:${node.endIndex}`));
        facts = extractFileFacts(tree.rootNode, filePath, language, captures);
      }
      finally { query.delete(); tree.delete(); }
    } else {
      facts = await new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./parser-worker.js', import.meta.url), {
          workerData: { filePath, content, maxSize },
          execArgv: [],
        });
        timer = setTimeout(() => { worker.terminate(); reject(new Error(`Parse timed out after ${timeoutMs}ms`)); }, timeoutMs);
        worker.once('message', (message) => { clearTimeout(timer); worker.terminate(); message.error ? reject(new Error(message.error)) : resolve(message.facts); });
        worker.once('error', (error) => { clearTimeout(timer); reject(error); });
        worker.once('exit', (code) => { if (code !== 0) { clearTimeout(timer); reject(new Error('Parser worker exited')); } });
      });
    }
    return ParseResultV3.parse(facts);
  } catch (error) {
    clearTimeout(timer);
    return ParseResultV3.parse({
      path: filePath,
      language,
      symbols: [],
      imports: [],
      exports: [],
      callSites: [],
      jsxUsages: [],
      valueReferences: [],
      extendsImplements: [],
      usedIdentifiers: [],
      diagnostics: [{
        level: 'error',
        message: error.message.startsWith('Parse timed out') ? error.message : 'Parser failed',
        range: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
      }],
      parseStatus: 'partial',
    });
  }
}
