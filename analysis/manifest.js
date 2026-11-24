import zlib from 'node:zlib';
import path from 'node:path';
import { Readable } from 'node:stream';
import { isSupportedLanguageFile, parseFile } from './parser.js';
import { PARSER_VERSION } from './types.js';

const EXCLUDED_REGEX = /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx|lock)|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|node_modules|dist|build|coverage|vendor|\.git)(\/|$)|\.(?:png|jpe?g|gif|webp|ico|pdf|svg|woff2?|ttf|eot|zip|gz|tar|wasm|min\.js|map)$/i;

export function isConfigFile(filePath) {
  const base = path.basename(filePath);
  return base === 'package.json' || /^tsconfig(?:\..*)?\.json$/i.test(base);
}

export function isEligibleManifestFile(filePath) {
  if (typeof filePath !== 'string') return false;
  if (EXCLUDED_REGEX.test(filePath)) return false;
  return isSupportedLanguageFile(filePath) || isConfigFile(filePath);
}

function parsePaxHeader(paxContent) {
  const records = {};
  let offset = 0;
  const str = paxContent.toString('utf8');

  while (offset < str.length) {
    const spaceIdx = str.indexOf(' ', offset);
    if (spaceIdx === -1) break;
    const len = parseInt(str.substring(offset, spaceIdx), 10);
    if (isNaN(len) || len <= 0) break;
    const record = str.substring(offset, offset + len);
    offset += len;

    const eqIdx = record.indexOf('=');
    if (eqIdx !== -1) {
      const key = record.substring(spaceIdx - (offset - len) + 1, eqIdx);
      const val = record.substring(eqIdx + 1).replace(/\n$/, '');
      records[key] = val;
    }
  }

  return records;
}

/**
 * Streams and extracts uncompressed or gzip-compressed tar archives.
 * Supports PAX extended headers, GNU long-name entries, path traversal security,
 * size ceilings, and gracefully flags truncated or corrupt archives.
 */
export async function extractTarStream(readableStream, {
  maxFileSize = 500 * 1024,
  maxTotalSize = 20 * 1024 * 1024,
} = {}) {
  const files = new Map();
  const skippedFiles = [];
  const diagnostics = [];
  let isPartial = false;
  let totalBytes = 0;

  return new Promise((resolve) => {
    let uncompressedStream;
    let isGzip = false;

    let buffer = Buffer.alloc(0);
    let nextOverridePath = null;
    let streamEnded = false;
    let discardBytes = 0;

    function cleanupAndResolve() {
      resolve({
        files,
        skippedFiles,
        diagnostics,
        isPartial: isPartial || diagnostics.length > 0,
        totalBytes,
      });
    }

    function processChunks() {
      while (discardBytes || buffer.length >= 512) {
        if (discardBytes) {
          const consumed = Math.min(discardBytes, buffer.length);
          discardBytes -= consumed;
          buffer = buffer.subarray(consumed);
          if (discardBytes) break;
          continue;
        }
        const header = buffer.subarray(0, 512);

        // Check for end-of-archive (two 512-byte zero blocks)
        let isZeroBlock = true;
        for (let i = 0; i < 512; i++) {
          if (header[i] !== 0) {
            isZeroBlock = false;
            break;
          }
        }

        if (isZeroBlock) {
          buffer = buffer.subarray(512);
          continue;
        }

        const sizeStr = header.subarray(124, 136).toString('utf8').trim().replace(/\0.*$/, '');
        const size = parseInt(sizeStr, 8) || 0;
        const paddedSize = Math.ceil(size / 512) * 512;

        const earlyType = String.fromCharCode(header[156]);
        if ((size > maxFileSize || size > maxTotalSize - totalBytes) && !['g', 'x', 'L'].includes(earlyType)) {
          const name = nextOverridePath || header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
          nextOverridePath = null;
          skippedFiles.push({ path: name.replace(/^[^/]+\//, ''), reason: size > maxFileSize ? 'file_size_limit' : 'total_size_limit', size });
          isPartial = true;
          buffer = buffer.subarray(512);
          discardBytes = paddedSize;
          continue;
        }
        if (size > Math.max(maxFileSize, 65536) && ['g', 'x', 'L'].includes(earlyType)) {
          isPartial = true;
          diagnostics.push({ level: 'error', message: 'Oversized tar metadata' });
          buffer = buffer.subarray(512);
          discardBytes = paddedSize;
          continue;
        }
        if (buffer.length < 512 + paddedSize) {
          // Wait for more data to complete file payload
          if (streamEnded) {
            isPartial = true;
            diagnostics.push({ level: 'error', message: 'Tar archive ended unexpectedly (truncated block)' });
            break;
          }
          return;
        }

        const payload = buffer.subarray(512, 512 + size);
        buffer = buffer.subarray(512 + paddedSize);

        const typeflag = String.fromCharCode(header[156]);

        // 1. PAX global header (GitHub archives start with this)
        if (typeflag === 'g' || header.subarray(0, 17).toString('utf8').startsWith('pax_global_header')) {
          continue;
        }

        // 2. GNU LongLink header for paths over 100 characters
        if (typeflag === 'L') {
          nextOverridePath = payload.toString('utf8').replace(/\0.*$/, '');
          continue;
        }

        // 3. PAX extended header
        if (typeflag === 'x') {
          const pax = parsePaxHeader(payload);
          if (pax.path) {
            nextOverridePath = pax.path;
          }
          continue;
        }

        // 4. Resolve path
        let rawPath;
        if (nextOverridePath) {
          rawPath = nextOverridePath;
          nextOverridePath = null;
        } else {
          const nameRaw = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
          const prefixRaw = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
          rawPath = prefixRaw ? `${prefixRaw}/${nameRaw}` : nameRaw;
        }

        // 5. Skip directories, symlinks, and hardlinks
        if (typeflag === '5' || rawPath.endsWith('/')) continue;
        if (typeflag === '1' || typeflag === '2' || typeflag === 's') {
          skippedFiles.push({ path: rawPath, reason: 'skipped_link_or_symlink' });
          continue;
        }

        // 6. Security: reject path traversal
        if (rawPath.startsWith('/') || rawPath.startsWith('\\') || rawPath.split(/[\\/]/).some((part) => part === '..')) {
          isPartial = true;
          diagnostics.push({ level: 'error', message: `Path traversal rejected: ${rawPath}` });
          continue;
        }

        const normalized = path.normalize(rawPath).replace(/\\/g, '/');
        if (normalized.startsWith('/') || normalized.startsWith('../') || normalized === '..') {
          isPartial = true;
          diagnostics.push({ level: 'error', message: `Path traversal rejected: ${rawPath}` });
          continue;
        }

        // 7. Strip top-level owner-repo-sha prefix
        const relativePath = normalized.replace(/^[^/]+\//, '');
        if (!relativePath) continue;

        // 8. Eligibility filter (only supported code or config files)
        if (!isEligibleManifestFile(relativePath)) {
          continue;
        }

        // 9. Enforce size limits
        if (size > maxFileSize) {
          skippedFiles.push({ path: relativePath, reason: 'file_size_limit', size });
          continue;
        }

        totalBytes += size;
        if (totalBytes > maxTotalSize) {
          isPartial = true;
          diagnostics.push({
            level: 'warning',
            message: `Total tarball extracted size exceeded limit of ${maxTotalSize} bytes; remaining files skipped`,
          });
          break;
        }

        // 10. Store extracted text content
        files.set(relativePath, payload.toString('utf8'));
      }

      if (streamEnded) {
        if (buffer.length > 0 || discardBytes) {
          isPartial = true;
          diagnostics.push({
            level: 'error',
            message: `Tar stream ended with incomplete data block of ${buffer.length} bytes (truncated archive)`,
          });
        }
        cleanupAndResolve();
      }
    }

    let initialChunks = [];
    let initialLen = 0;
    let streamSetupDone = false;

    readableStream.on('data', (chunk) => {
      if (!streamSetupDone) {
        initialChunks.push(chunk);
        initialLen += chunk.length;

        if (initialLen >= 2) {
          const firstBytes = Buffer.concat(initialChunks);
          isGzip = firstBytes[0] === 0x1f && firstBytes[1] === 0x8b;

          if (isGzip) {
            const gunzip = zlib.createGunzip();
            gunzip.on('data', (decompressed) => {
              buffer = Buffer.concat([buffer, decompressed]);
              processChunks();
            });
            gunzip.on('error', (err) => {
              isPartial = true;
              diagnostics.push({ level: 'error', message: `Gzip decompression error: ${err.message}` });
              streamEnded = true;
              cleanupAndResolve();
            });
            gunzip.on('end', () => {
              streamEnded = true;
              processChunks();
            });

            gunzip.write(firstBytes);
            uncompressedStream = gunzip;
          } else {
            buffer = Buffer.concat([buffer, firstBytes]);
            processChunks();
          }
          streamSetupDone = true;
        }
      } else if (isGzip && uncompressedStream) {
        uncompressedStream.write(chunk);
      } else {
        buffer = Buffer.concat([buffer, chunk]);
        processChunks();
      }
    });

    readableStream.on('error', (err) => {
      isPartial = true;
      diagnostics.push({ level: 'error', message: `Stream error: ${err.message}` });
      streamEnded = true;
      cleanupAndResolve();
    });

    readableStream.on('end', () => {
      if (isGzip && uncompressedStream) {
        uncompressedStream.end();
      } else {
        streamEnded = true;
        processChunks();
      }
    });
  });
}

/**
 * Extracts tar files from a Buffer or Readable stream.
 */
export async function extractTarFiles(tarBufferOrStream, options = {}) {
  let stream;
  if (Buffer.isBuffer(tarBufferOrStream)) {
    stream = Readable.from([tarBufferOrStream]);
  } else if (tarBufferOrStream && typeof tarBufferOrStream.on === 'function') {
    stream = tarBufferOrStream;
  } else {
    stream = Readable.from([Buffer.from(tarBufferOrStream || '')]);
  }

  const result = await extractTarStream(stream, options);
  return result.files;
}

/**
 * Builds the commit manifest (path -> git blob SHA) using GitHub Git Tree API.
 * When truncated is true, iteratively walks subtrees non-recursively with request caps.
 */
export async function buildCommitManifest(client, { owner, repo, commitSha, maxSubtreeRequests = 20 }) {
  const manifest = new Map();
  const diagnostics = [];
  let isPartial = false;
  let requestsMade = 0;
  const unsupportedPaths = new Set();

  try {
    const treeRes = await client.rest.git.getTree({
      owner,
      repo,
      tree_sha: commitSha,
      recursive: '1',
    });
    requestsMade++;

    const tree = treeRes.data.tree || [];
    const subtreeQueue = [];

    for (const entry of tree) {
      if (entry.type === 'blob' && entry.path && entry.sha) {
        if (isEligibleManifestFile(entry.path)) {
          manifest.set(entry.path, entry.sha);
        } else if (!EXCLUDED_REGEX.test(entry.path)) unsupportedPaths.add(entry.path);
      } else if (entry.type === 'tree' && entry.path && entry.sha) {
        subtreeQueue.push({ path: entry.path, sha: entry.sha });
      }
    }

    // Re-read the root non-recursively; recursive responses may omit entire directories.
    if (treeRes.data.truncated) {
      const pendingTrees = [{ path: '', sha: commitSha }];
      while (pendingTrees.length && requestsMade < maxSubtreeRequests) {
        const currentTree = pendingTrees.shift();
        requestsMade++;
        try {
          const subRes = await client.rest.git.getTree({ owner, repo, tree_sha: currentTree.sha });
          if (subRes.data.truncated) {
            isPartial = true;
            diagnostics.push({ level: 'warning', message: `Non-recursive tree truncated: ${currentTree.path || '/'} ` });
          }
          for (const entry of subRes.data.tree || []) {
            const fullPath = currentTree.path ? `${currentTree.path}/${entry.path}` : entry.path;
            if (entry.type === 'blob' && isEligibleManifestFile(fullPath)) manifest.set(fullPath, entry.sha);
            else if (entry.type === 'blob' && !EXCLUDED_REGEX.test(fullPath)) unsupportedPaths.add(fullPath);
            else if (entry.type === 'tree' && entry.sha) pendingTrees.push({ path: fullPath, sha: entry.sha });
          }
        } catch {
          isPartial = true;
          diagnostics.push({ level: 'error', message: `Failed walking subtree at ${currentTree.path || '/'}` });
        }
      }
      if (pendingTrees.length) {
        isPartial = true;
        diagnostics.push({ level: 'warning', message: `Tree truncated and subtree walk reached request cap of ${maxSubtreeRequests}` });
      }
    }

  } catch (error) {
    isPartial = true;
    diagnostics.push({
      level: 'error',
      message: `Failed to build commit manifest: ${error.message}`,
    });
  }

  return { manifest, isPartial, diagnostics, unsupportedFiles: unsupportedPaths.size };
}

/**
 * Syncs file facts for a commit manifest against PostgreSQL cache.
 * Downloads and parses only cache misses.
 * Reports path mismatches between tarball and manifest.
 */
export async function syncManifestFacts({
  client,
  store,
  repositoryId,
  owner,
  repo,
  commitSha,
  manifest,
  parserVersion = PARSER_VERSION,
}) {
  const factsMap = new Map();
  const allBlobShas = [];
  const diagnostics = [];

  for (const [filePath, blobSha] of manifest.entries()) {
    allBlobShas.push(blobSha);
  }

  // 1. Query store for cached facts
  const cachedFacts = store?.batchGetFileFacts
    ? await store.batchGetFileFacts(repositoryId, allBlobShas, parserVersion)
    : new Map();

  const missingShas = [];
  for (const [filePath, blobSha] of manifest.entries()) {
    if (cachedFacts.has(blobSha) && cachedFacts.get(blobSha).facts.path === filePath) {
      factsMap.set(filePath, cachedFacts.get(blobSha).facts);
    } else {
      missingShas.push(blobSha);
    }
  }

  const uniqueMissingShas = Array.from(new Set(missingShas));
  const cacheHitCount = factsMap.size;
  let isPartial = false;

  // 2. Fetch cache misses if any
  if (uniqueMissingShas.length > 0) {
    const fetchedContents = new Map();
    let tarballAttempted = false;

    try {
      const archiveRes = await client.rest.repos.downloadTarballArchive({
        owner,
        repo,
        ref: commitSha,
      });

      if (archiveRes?.data) {
        tarballAttempted = true;
        let archiveStream;
        if (Buffer.isBuffer(archiveRes.data)) {
          archiveStream = Readable.from([archiveRes.data]);
        } else if (archiveRes.data && typeof archiveRes.data.on === 'function') {
          archiveStream = archiveRes.data;
        } else {
          archiveStream = Readable.from([Buffer.from(archiveRes.data)]);
        }

        const tarResult = await extractTarStream(archiveStream);
        if (tarResult.isPartial) isPartial = true;

        for (const [filePath, content] of tarResult.files.entries()) {
          fetchedContents.set(filePath, content);
          if (!manifest.has(filePath) && isEligibleManifestFile(filePath)) {
            diagnostics.push({
              level: 'warning',
              message: `File found in tarball archive but missing from git tree manifest: ${filePath}`,
            });
          }
        }
      }
    } catch (tarErr) {
      tarballAttempted = false;
    }

    for (const [primaryPath, blobSha] of manifest.entries()) {
      if (factsMap.has(primaryPath)) continue;
      if (!isSupportedLanguageFile(primaryPath)) {
        diagnostics.push({ level: 'warning', message: `Config file not parsed: ${primaryPath}` });
        isPartial = true;
        continue;
      }

      let content = primaryPath ? fetchedContents.get(primaryPath) : null;
      if (typeof content !== 'string') {
        if (tarballAttempted && primaryPath) {
          diagnostics.push({
            level: 'warning',
            message: `File in manifest missing from tarball archive: ${primaryPath}; fetching via blob API`,
          });
        }
        try {
          const blobRes = await client.rest.git.getBlob({
            owner,
            repo,
            file_sha: blobSha,
          });
          if (blobRes?.data?.encoding === 'base64' && blobRes.data.content) {
            content = Buffer.from(blobRes.data.content, 'base64').toString('utf8');
          }
        } catch (blobErr) {
          isPartial = true;
          diagnostics.push({
            level: 'error',
            message: `Failed fetching blob ${blobSha} for path ${primaryPath}: ${blobErr.message}`,
          });
          continue;
        }
      }

      if (typeof content === 'string') {
        const parseResult = await parseFile(primaryPath || 'file.js', content);
        if (store?.upsertFileFacts && parseResult.parseStatus === 'complete') {
          await store.upsertFileFacts({
            repositoryId,
            blobSha,
            parserVersion,
            facts: parseResult,
            parseStatus: parseResult.parseStatus,
            identifiers: parseResult.usedIdentifiers,
          });
        }

        factsMap.set(primaryPath, parseResult);
        if (parseResult.parseStatus !== 'complete') isPartial = true;
      }
    }
  }

  return {
    factsMap,
    diagnostics,
    stats: {
      totalFiles: manifest.size,
      cacheHits: cacheHitCount,
      cacheMisses: manifest.size - cacheHitCount,
      isPartial: isPartial || factsMap.size < manifest.size,
    },
  };
}
