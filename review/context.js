import { createTwoFilesPatch } from 'diff';
import { redact } from './safety.js';
import { estimateReviewInputTokens } from './ai.js';

const excluded = /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx|lock)|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|node_modules|dist|build|coverage|vendor|\.git)(\/|$)|\.(?:png|jpe?g|gif|webp|ico|pdf|svg|woff2?|ttf|eot|zip|gz|tar|wasm|min\.js|map)$/i;
const MAX_REVIEWABLE_FILES = 3000;
const MAX_PATH_LENGTH = 1024;

export function parsePatch(patch) {
  const lines = String(patch || '').split(/\r?\n/);
  const header = [];
  const hunks = [];
  let current = null;

  for (const line of lines) {
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
      if (current) hunks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    } else if (line) {
      header.push(line);
    }
  }
  if (current) hunks.push(current);
  return { header, hunks };
}

export function changedLineEntries(patch) {
  const result = [];
  let left = 0;
  let right = 0;
  let inHunk = false;
  for (const line of String(patch || '').split(/\r?\n/)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      left = Number(hunk[1]);
      right = Number(hunk[2]);
      inHunk = true;
    } else if (!inHunk || line.startsWith('\\')) {
      continue;
    } else if (line.startsWith('+')) {
      result.push({ line: right++, side: 'RIGHT', text: line.slice(1) });
    } else if (line.startsWith('-')) {
      result.push({ line: left++, side: 'LEFT', text: line.slice(1) });
    } else if (line.startsWith(' ')) {
      left++;
      right++;
    }
  }
  return result;
}

export function anchors(patch) {
  return changedLineEntries(patch).map(({ line, side }) => ({ line, side }));
}

export function changedLines(patch) {
  const added = [];
  const deleted = [];
  for (const entry of changedLineEntries(patch)) {
    if (entry.side === 'RIGHT') added.push(entry.text);
    else deleted.push(entry.text);
  }
  return { added, deleted };
}

function isReviewablePath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= MAX_PATH_LENGTH &&
    !/[\r\n\0]/.test(path) && !excluded.test(path);
}

async function getFileData(client, args, path, ref, maxChars) {
  if (!path || !ref) return null;
  try {
    const { data } = await client.rest.repos.getContent({ ...args, path, ref });
    if (data.type === 'symlink' || data.type === 'submodule') return { excludedType: data.type };
    if (data.type !== 'file' || data.encoding !== 'base64' || data.size > maxChars) return null;
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return content.includes('\0') ? { excludedType: 'binary' } : { content };
  } catch {
    return null;
  }
}

async function getTextFile(client, args, path, ref, maxChars) {
  return (await getFileData(client, args, path, ref, maxChars))?.content ?? null;
}

async function recoverPatch(client, args, snapshot, file, maxChars, currentContent, mergeBase) {
  const currentPath = file.filename;
  const oldPath = file.previous_filename || currentPath;
  let before = '';
  let after = '';

  if (file.status !== 'added') {
    if (!mergeBase) return null;
    before = await getTextFile(client, args, oldPath, mergeBase, maxChars);
    if (before === null) return null;
  }
  if (file.status !== 'removed') {
    after = currentContent ?? await getTextFile(client, args, currentPath, snapshot.head, maxChars);
    if (after === null) return null;
  }

  const patch = createTwoFilesPatch(oldPath, currentPath, before, after, '', '', { context: 3 });
  return parsePatch(patch).hunks.length ? patch : null;
}

function makePatch(header, hunks) {
  return [...header, ...hunks.flat()].join('\n');
}

function countCharacters(value) {
  return Array.from(value).length;
}

function contextCharacters(context) {
  const files = context.files.map(({ path, previousPath, patch, context: fileContext }) => ({
    path, previousPath, patch, context: fileContext,
  }));
  return countCharacters(JSON.stringify({ pullRequest: context.pullRequest, files }));
}

function fits(context, config, model) {
  if (contextCharacters(context) > config.maxInputChars) return false;
  return estimateReviewInputTokens(model, config, context) <= config.maxInputTokens;
}

function redactPath(path) {
  return redact(path).slice(0, MAX_PATH_LENGTH);
}

export async function collectContext(client, args, snapshot, config, { model = 'gpt-4o', pullRequest = {} } = {}) {
  const files = [];
  const skipped = [];
  const safePR = {
    title: String(pullRequest.title || '').slice(0, 512),
    body: String(pullRequest.body || '').slice(0, Math.min(config.maxInputChars, 12000)),
    author: String(pullRequest.user?.login || '').slice(0, 128),
  };
  let total = 0;
  let totalHunksSkipped = 0;
  let mergeBasePromise;
  const mergeBase = () => {
    mergeBasePromise ??= client.rest.repos.compareCommits({
      owner: args.owner, repo: args.repo, base: snapshot.base, head: snapshot.head,
    }).then(({ data }) => data.merge_base_commit?.sha || null).catch(() => null);
    return mergeBasePromise;
  };

  for await (const page of client.paginate.iterator(client.rest.pulls.listFiles, { ...args, per_page: 100 })) {
    for (const file of page.data) {
      total++;
      if (total > MAX_REVIEWABLE_FILES) {
        skipped.push({ path: '[remaining files]', reason: 'file_limit' });
        break;
      }
      const oldPath = file.previous_filename || null;
      if (!isReviewablePath(file.filename) || (oldPath && !isReviewablePath(oldPath))) {
        skipped.push({ path: redactPath(file.filename || '[invalid path]'), reason: 'excluded_or_invalid_path' });
        continue;
      }
      if (files.length >= config.maxFiles) {
        skipped.push({ path: redactPath(file.filename), reason: 'file_limit' });
        continue;
      }

      const currentFile = file.status !== 'removed'
        ? await getFileData(client, args, file.filename, snapshot.head, config.maxInputChars)
        : null;
      if (currentFile?.excludedType) {
        skipped.push({ path: redactPath(file.filename), reason: currentFile.excludedType });
        continue;
      }

      let patch = typeof file.patch === 'string' && file.patch.length > 0 ? file.patch : null;
      if (!patch) patch = await recoverPatch(client, args, snapshot, file, config.maxInputChars,
        currentFile?.content, file.status === 'added' ? null : await mergeBase());
      if (!patch) {
        skipped.push({ path: redactPath(file.filename), reason: 'missing_patch_unrecoverable' });
        continue;
      }

      const { header, hunks } = parsePatch(patch);
      if (!hunks.length) {
        skipped.push({ path: redactPath(file.filename), reason: 'empty_patch' });
        continue;
      }

      let fullContext = '';
      let contextMissing = false;
      if (file.status !== 'removed') {
        fullContext = currentFile?.content ?? '';
        contextMissing = !currentFile;
      }

      const chosen = [];
      let selectedContext = fullContext || '';
      for (const hunk of hunks) {
        const candidatePatch = makePatch(header, [...chosen, hunk]);
        let candidate = {
          pullRequest: safePR,
          files: [...files, {
            path: file.filename,
            previousPath: oldPath,
            patch: candidatePatch,
            context: selectedContext,
          }],
        };
        if (!fits(candidate, config, model) && selectedContext) {
          selectedContext = '';
          contextMissing = true;
          candidate = {
            pullRequest: safePR,
            files: [...files, {
              path: file.filename,
              previousPath: oldPath,
              patch: candidatePatch,
              context: '',
            }],
          };
        }
        if (fits(candidate, config, model)) {
          chosen.push(hunk);
        } else {
          totalHunksSkipped++;
        }
      }

      if (!chosen.length) {
        skipped.push({ path: redactPath(file.filename), reason: 'input_budget' });
        continue;
      }

      const selectedPatch = makePatch(header, chosen);
      files.push({
        path: file.filename,
        previousPath: oldPath,
        patch: selectedPatch,
        context: selectedContext,
        anchors: anchors(selectedPatch),
        changedLines: changedLines(selectedPatch),
        changedLineEntries: changedLineEntries(selectedPatch),
        contextMissing,
        redacted: redact(selectedPatch) !== selectedPatch || redact(selectedContext) !== selectedContext,
        omittedHunks: hunks.length - chosen.length,
      });
      if (hunks.length > chosen.length) {
        skipped.push({ path: redactPath(file.filename), reason: 'hunk_budget', omittedHunks: hunks.length - chosen.length });
      }
    }
    if (total > MAX_REVIEWABLE_FILES) break;
  }

  return {
    pullRequest: safePR,
    files,
    skipped,
    partial: skipped.length > 0 || total > MAX_REVIEWABLE_FILES || totalHunksSkipped > 0 || files.some((file) => file.contextMissing || file.redacted),
  };
}
