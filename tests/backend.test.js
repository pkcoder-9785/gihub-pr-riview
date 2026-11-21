import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../app.js';
import { createWebhookHandler, REVIEW_EVENT, CANCEL_REVIEW_EVENT, optedOut, pullRequestKey } from '../github/webhook.js';
import { anchors, changedLines, collectContext, parsePatch } from '../review/context.js';
import { estimateReviewInputTokens, reviewAI } from '../review/ai.js';
import { redact, sanitize, sameSnapshot, classify } from '../review/safety.js';
import { render, publish, recoverPublication } from '../review/publish.js';
import { Store } from '../review/store.js';
import { loadConfig } from '../config.js';
import { createReviewFunction } from '../inngest/function/review-pr.js';
import { createPublicationRecoveryFunction } from '../inngest/function/recover-publications.js';

const webhookSecret = 'synthetic-webhook-secret';
const basePayload = {
  action: 'opened',
  installation: { id: 1 },
  repository: { id: 2, full_name: 'owner/repo', name: 'repo', owner: { login: 'owner' } },
  pull_request: {
    number: 3,
    state: 'open',
    draft: false,
    user: { type: 'User', login: 'author' },
    title: 'fix comparison',
    body: 'Changes a comparison.',
    labels: [],
    base: { sha: 'base-sha' },
    head: { sha: 'event-sha' },
  },
};

function livePR(overrides = {}) {
  return {
    ...basePayload.pull_request,
    base: { sha: 'base-sha' },
    head: { sha: 'live-sha' },
    ...overrides,
  };
}

function signedPost(app, body, { signed = true, event = 'pull_request', delivery = 'delivery-1' } = {}) {
  const raw = JSON.stringify(body);
  const req = request(app).post('/api/github/webhooks')
    .set('Content-Type', 'application/json')
    .set('x-github-event', event)
    .set('x-github-delivery', delivery);
  if (signed) {
    req.set('x-hub-signature-256', `sha256=${createHmac('sha256', webhookSecret).update(raw).digest('hex')}`);
  }
  return req.send(raw);
}

function webhookApp({ send = async () => {}, fetchPullRequest = async () => livePR(), botAuthorAllowlist = [] } = {}) {
  return createApp({
    githubWebhookHandler: createWebhookHandler({
      secret: webhookSecret,
      repositories: ['owner/repo'],
      botAuthorAllowlist,
      send,
      fetchPullRequest,
    }),
  });
}

test('health route reports liveness; invalid webhook signature is rejected before lookup', async () => {
  let lookups = 0;
  const app = webhookApp({ fetchPullRequest: async () => { lookups++; return livePR(); } });
  assert.deepEqual((await request(app).get('/health')).body, { status: 'ok', service: 'github-pr-review' });
  assert.equal((await signedPost(app, basePayload, { signed: false })).status, 401);
  assert.equal(lookups, 0);
});

test('eligible webhook uses live snapshot and delivery identity', async () => {
  const events = [];
  const app = webhookApp({
    send: async (event) => events.push(event),
    fetchPullRequest: async () => livePR(),
  });
  const response = await signedPost(app, basePayload);
  assert.equal(response.status, 202);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 'delivery-1');
  assert.equal(events[0].name, REVIEW_EVENT);
  assert.equal(events[0].data.observedHeadSha, 'live-sha');
  assert.equal(events[0].data.observedBaseSha, 'base-sha');
  assert.equal(events[0].data.prKey, '1:2:3');
});

test('title and skip-label transitions are checked against current GitHub state', async () => {
  const events = [];
  const app = webhookApp({ send: async (event) => events.push(event) });
  const titleEdit = { ...basePayload, action: 'edited', changes: { title: { from: 'old' } } };
  assert.equal((await signedPost(app, titleEdit)).status, 202);
  assert.equal(events[0].name, REVIEW_EVENT);

  const labeled = { ...basePayload, action: 'labeled', label: { name: 'skip-ai-review' } };
  const cancelApp = webhookApp({
    send: async (event) => events.push(event),
    fetchPullRequest: async () => livePR({ labels: [{ name: 'skip-ai-review' }] }),
  });
  assert.equal((await signedPost(cancelApp, labeled, { delivery: 'delivery-2' })).status, 202);
  assert.equal(events[1].name, CANCEL_REVIEW_EVENT);
  assert.equal(events[1].id, 'delivery-2:cancel');

  const unlabeled = { ...basePayload, action: 'unlabeled', label: { name: 'skip-ai-review' } };
  assert.equal((await signedPost(app, unlabeled, { delivery: 'delivery-3' })).status, 202);
  assert.equal(events[2].name, REVIEW_EVENT);
});

test('draft, closed and disallowed bot PRs cancel matching pending review work', async () => {
  for (const current of [
    livePR({ draft: true }),
    livePR({ state: 'closed' }),
    livePR({ user: { type: 'Bot', login: 'other-bot[bot]' } }),
  ]) {
    const events = [];
    const app = webhookApp({ send: async (event) => events.push(event), fetchPullRequest: async () => current });
    const response = await signedPost(app, basePayload);
    assert.equal(response.status, 202);
    assert.equal(events[0].name, CANCEL_REVIEW_EVENT);
  }
});

test('configured bot author exception is honored, but unrelated bot is skipped', () => {
  assert.equal(optedOut(livePR({ user: { type: 'Bot', login: 'renovate[bot]' } }), ['renovate[bot]']), false);
  assert.equal(optedOut(livePR({ user: { type: 'Bot', login: 'other[bot]' } }), ['renovate[bot]']), true);
});

test('unsupported webhook actions and repositories are ignored without a GitHub lookup', async () => {
  let lookups = 0;
  const app = webhookApp({ fetchPullRequest: async () => { lookups++; return livePR(); } });
  assert.equal((await signedPost(app, { ...basePayload, action: 'synchronize' }, { event: 'issues' })).status, 202);
  assert.equal((await signedPost(app, { ...basePayload, action: 'edited', changes: { body: {} } })).status, 202);
  const otherRepo = {
    ...basePayload,
    repository: { ...basePayload.repository, full_name: 'elsewhere/repo', owner: { login: 'elsewhere' } },
  };
  assert.equal((await signedPost(app, otherRepo)).status, 202);
  assert.equal(lookups, 0);
});

test('GitHub lookup and queue failures return retryable non-success responses', async () => {
  const lookupFailure = webhookApp({ fetchPullRequest: async () => { throw new Error('private response'); } });
  assert.equal((await signedPost(lookupFailure, basePayload)).status, 503);
  const notFoundEvents = [];
  const notFound = webhookApp({
    send: async (event) => notFoundEvents.push(event),
    fetchPullRequest: async () => { throw { status: 404 }; },
  });
  assert.equal((await signedPost(notFound, basePayload)).status, 202);
  assert.equal(notFoundEvents.length, 0);
  const enqueueFailure = webhookApp({ send: async () => { throw new Error('private response'); } });
  assert.equal((await signedPost(enqueueFailure, basePayload)).status, 503);
  assert.equal((await signedPost(createApp(), basePayload)).status, 503);
});

test('raw-body parser rejects malformed JSON and unsupported routes remain JSON', async () => {
  const app = webhookApp();
  const raw = '{';
  const response = await request(app).post('/api/github/webhooks')
    .set('Content-Type', 'application/json')
    .set('x-hub-signature-256', `sha256=${createHmac('sha256', webhookSecret).update(raw).digest('hex')}`)
    .send(raw);
  assert.equal(response.status, 400);
  assert.deepEqual((await request(app).get('/missing')).body, { error: 'Not found' });
});

test('repository author allowlist and per-PR token limit load from synthetic config', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    GITHUB_APP_ID: '123',
    GITHUB_PRIVATE_KEY: 'synthetic\\nkey',
    GITHUB_WEBHOOK_SECRET: 'synthetic-secret',
    GITHUB_REPOSITORY_ALLOWLIST: 'Owner/Repo',
    GITHUB_BOT_AUTHOR_ALLOWLIST: 'Renovate[bot]',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
    OPENAI_API_KEY: 'synthetic-key',
    OPENAI_MODEL: 'gpt-4o',
    REVIEW_PR_DAILY_TOKEN_LIMIT: '32100',
  });
  assert.deepEqual(config.github.repositoryAllowlist, ['owner/repo']);
  assert.deepEqual(config.github.botAuthorAllowlist, ['renovate[bot]']);
  assert.equal(config.review.prDailyTokenLimit, 32100);
  assert.equal(config.github.privateKey, 'synthetic\nkey');
});

test('patch parsing preserves whole hunks and maps added/deleted anchors', () => {
  const patch = '--- a/a.js\n+++ b/a.js\n@@ -4,2 +4,2 @@\n-old\n+new\n context\n@@ -8 +8 @@\n-old2\n+new2';
  assert.equal(parsePatch(patch).hunks.length, 2);
  assert.deepEqual(anchors(patch), [
    { line: 4, side: 'LEFT' },
    { line: 4, side: 'RIGHT' },
    { line: 8, side: 'LEFT' },
    { line: 8, side: 'RIGHT' },
  ]);
  assert.deepEqual(changedLines(patch), { added: ['new', 'new2'], deleted: ['old', 'old2'] });
});

test('diff lines beginning with header-like prefixes remain changed lines', () => {
  const patch = '@@ -1,1 +1,1 @@\n---old\n+++new';
  assert.deepEqual(anchors(patch), [{ line: 1, side: 'LEFT' }, { line: 1, side: 'RIGHT' }]);
  assert.deepEqual(changedLines(patch), { added: ['++new'], deleted: ['--old'] });
});

function pagedClient(files, contentByRef = {}, mergeBase = 'base-sha') {
  return {
    paginate: {
      iterator: async function* () { yield { data: files }; },
    },
    rest: {
      pulls: { listFiles() {} },
      repos: {
        compareCommits: async () => ({ data: { merge_base_commit: mergeBase ? { sha: mergeBase } : null } }),
        getContent: async ({ path, ref }) => {
          const content = contentByRef[`${ref}:${path}`];
          if (!content) throw { status: 404 };
          return { data: { type: 'file', encoding: 'base64', size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64') } };
        },
      },
    },
  };
}

const contextConfig = {
  maxFiles: 30,
  maxInputChars: 80000,
  maxInputTokens: 24000,
  maxOutputTokens: 1000,
  maxFindings: 5,
};
const snapshot = { base: 'base-sha', head: 'head-sha' };
const args = { owner: 'owner', repo: 'repo', pull_number: 3 };

test('missing patch is recovered from merge-base/head content and renamed paths use both revisions', async () => {
  const client = pagedClient([
    { filename: 'new.js', previous_filename: 'old.js', status: 'renamed' },
  ], {
    'base-sha:old.js': 'const value = 1;\n',
    'head-sha:new.js': 'const value = 2;\n',
  });
  const context = await collectContext(client, args, snapshot, contextConfig, {
    model: 'gpt-4o',
    pullRequest: livePR(),
  });
  assert.equal(context.files.length, 1);
  assert.equal(context.files[0].previousPath, 'old.js');
  assert.match(context.files[0].patch, /\+const value = 2;/);
  assert.equal(context.files[0].anchors.some((anchor) => anchor.side === 'RIGHT'), true);
});

test('patch recovery uses the PR merge base, excluding base-only changes', async () => {
  const client = pagedClient([{ filename: 'src/a.js', status: 'modified' }], {
    'common-sha:src/a.js': 'const value = 1;\n',
    'base-sha:src/a.js': 'const value = 99;\n',
    'head-sha:src/a.js': 'const value = 2;\n',
  }, 'common-sha');
  const context = await collectContext(client, args, snapshot, contextConfig, { model: 'gpt-4o' });
  assert.match(context.files[0].patch, /-const value = 1;/);
  assert.doesNotMatch(context.files[0].patch, /value = 99/);
});

test('missing merge-base lookup skips patch recovery safely', async () => {
  const client = pagedClient([{ filename: 'src/a.js', status: 'modified' }], {
    'base-sha:src/a.js': 'const value = 1;\n',
    'head-sha:src/a.js': 'const value = 2;\n',
  });
  client.rest.repos.compareCommits = async () => { throw new Error('compare unavailable'); };
  const context = await collectContext(client, args, snapshot, contextConfig, { model: 'gpt-4o' });
  assert.equal(context.files.length, 0);
  assert.deepEqual(context.skipped.map((file) => file.reason), ['missing_patch_unrecoverable']);
});

test('deleted file recovery maps changed lines to the old LEFT side', async () => {
  const client = pagedClient([{ filename: 'old.js', status: 'removed' }], {
    'base-sha:old.js': 'const obsolete = true;\n',
  });
  const context = await collectContext(client, args, snapshot, contextConfig, { model: 'gpt-4o' });
  assert.equal(context.files.length, 1);
  assert.equal(context.files[0].anchors.some((anchor) => anchor.side === 'LEFT'), true);
  assert.deepEqual(context.files[0].changedLines.deleted, ['const obsolete = true;']);
});

test('unrecoverable missing patches and secret paths are disclosed as skipped coverage', async () => {
  const client = pagedClient([
    { filename: 'src/unknown.js', status: 'modified' },
    { filename: '.env.production', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
  ]);
  const context = await collectContext(client, args, snapshot, contextConfig, { model: 'gpt-4o' });
  assert.equal(context.files.length, 0);
  assert.deepEqual(context.skipped.map((file) => file.reason), ['missing_patch_unrecoverable', 'excluded_or_invalid_path']);
  assert.equal(context.partial, true);
});

test('context selection includes complete hunks within tokenizer and character ceilings', async () => {
  const firstHunk = '@@ -1,1 +1,1 @@\n-return oldValue\n+return newValue';
  const secondHunk = `@@ -100,1 +100,1 @@\n-${'old'.repeat(120)}\n+${'new'.repeat(120)}`;
  const patch = `${firstHunk}\n${secondHunk}`;
  const oneHunkTokens = estimateReviewInputTokens('gpt-4o', contextConfig, {
    pullRequest: { title: '', body: '', author: '' },
    files: [{ path: 'src/a.js', previousPath: null, patch: firstHunk, context: '' }],
  });
  const client = pagedClient([{ filename: 'src/a.js', status: 'modified', patch }], { 'head-sha:src/a.js': '' });
  const context = await collectContext(client, args, snapshot, {
    ...contextConfig,
    maxInputTokens: oneHunkTokens + 1,
    maxInputChars: 5000,
  }, { model: 'gpt-4o' });
  assert.equal(context.files.length, 1);
  assert.match(context.files[0].patch, /newValue/);
  assert.doesNotMatch(context.files[0].patch, /oldoldold/);
  assert.equal(context.files[0].omittedHunks, 1);
  assert.equal(context.partial, true);
});

const aiConfig = {
  openai: { apiKey: 'synthetic-key', model: 'gpt-4o' },
  review: {
    maxOutputTokens: 1000,
    maxInputTokens: 24000,
    maxInputChars: 80000,
    maxFindings: 5,
    owner: 'owner',
    killSwitch: false,
  },
  github: { botAuthorAllowlist: [] },
};

const aiContext = {
  pullRequest: { title: 'fix comparison', body: 'Author description', author: 'author' },
  files: [{
    path: 'src/a.js',
    previousPath: null,
    patch: '@@ -1 +1 @@\n-return oldValue\n+if (value === undefined) return 0;',
    context: 'function compare(value) { return value; }',
    anchors: [{ line: 1, side: 'RIGHT' }],
    changedLines: { added: ['if (value === undefined) return 0;'], deleted: ['return oldValue'] },
  }],
};

function completedAIOutput(overrides = {}) {
  return {
    summary: 'The author adds a guard for undefined input.',
    fileChanges: [{
      path: 'src/a.js',
      change: 'Adds an undefined guard.',
      behavior: 'Undefined input returns zero.',
      evidence: 'if (value === undefined) return 0;',
    }],
    findings: [{
      path: 'src/a.js',
      line: 1,
      side: 'RIGHT',
      severity: 'high',
      confidence: 0.96,
      title: 'Guard changes comparison semantics',
      explanation: 'The new branch returns before comparison.',
      failureScenario: 'A caller passing undefined receives a default result.',
      suggestedFix: null,
      evidence: 'if (value === undefined) return 0;',
    }],
    ...overrides,
  };
}

test('AI request is strict, token-bounded, redacted and findings require exact changed-line evidence', async () => {
  const context = structuredClone(aiContext);
  context.files[0].patch += '\n+// token=ghp_12345678901234567890';
  context.files[0].changedLines.added.push('// token=ghp_12345678901234567890');
  let requestBody;
  const client = { responses: { create: async (body) => {
    requestBody = body;
    return { status: 'completed', output_text: JSON.stringify(completedAIOutput()), usage: { total_tokens: 42 } };
  } } };
  const result = await reviewAI(client, aiConfig, context);
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.text.format.strict, true);
  assert.equal(requestBody.max_output_tokens, 1000);
  assert.doesNotMatch(requestBody.input, /ghp_12345678901234567890/);
  assert.equal(result.usage, 42);
  assert.equal(result.fileChanges.length, 1);
  assert.equal(result.findings[0].anchorValid, true);
  assert.ok(estimateReviewInputTokens('gpt-4o', aiConfig.review, context) < aiConfig.review.maxInputTokens);

  const unsupported = completedAIOutput({ findings: [{ ...completedAIOutput().findings[0], evidence: 'This text is not in the diff.' }] });
  const rejected = await reviewAI({ responses: { create: async () => ({ status: 'completed', output_text: JSON.stringify(unsupported) }) } }, aiConfig, aiContext);
  assert.equal(rejected.findings.length, 0);
});

test('AI refusal, incomplete output and unsupported tokenizer do not produce clean reviews', async () => {
  const responses = [
    { status: 'incomplete', usage: { total_tokens: 10 } },
    { status: 'completed', output: [{ content: [{ type: 'refusal' }] }], usage: { total_tokens: 10 } },
    { status: 'completed', output_text: '{}' },
  ];
  for (const response of responses) {
    const result = await reviewAI({ responses: { create: async () => response } }, aiConfig, aiContext);
    assert.notEqual(result.status, 'complete');
  }
  assert.throws(() => estimateReviewInputTokens('unknown-model-name', aiConfig.review, aiContext), /tokenizer/i);
});

test('inline finding anchor must point to its quoted changed line', async () => {
  const context = structuredClone(aiContext);
  context.files[0].patch += '\n+const unrelated = true;';
  const wrongLine = completedAIOutput({ findings: [{ ...completedAIOutput().findings[0], line: 2 }] });
  const result = await reviewAI({ responses: { create: async () => ({
    status: 'completed', output_text: JSON.stringify(wrongLine), usage: { total_tokens: 20 },
  }) } }, aiConfig, context);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].anchorValid, false);
});

test('sanitization removes secrets, HTML, URLs, mentions and issue references', () => {
  assert.ok(!redact('token=ghp_12345678901234567890').includes('ghp_'));
  const safe = sanitize('@owner #42 https://bad.test <img src=x>');
  assert.ok(!safe.includes('@owner'));
  assert.ok(!safe.includes('#42'));
  assert.ok(!safe.includes('bad.test'));
  assert.ok(!safe.includes('<img'));
  assert.equal(sameSnapshot({ base: { sha: 'a' }, head: { sha: 'c' } }, { base: 'a', head: 'b' }), false);
  assert.equal(classify({ status: 422 }), 'permanent');
  assert.equal(classify({ status: 403, response: { headers: { 'retry-after': '2' } } }), 'rate_limit');
});

function reviewResult(overrides = {}) {
  return {
    summary: 'Author adds an undefined guard.',
    fileChanges: [{ path: 'src/a.js', change: 'Adds a guard.', behavior: 'Undefined returns zero.' }],
    findings: [{
      path: 'src/a.js', line: 999, side: 'RIGHT', anchorValid: false,
      severity: 'high', confidence: 0.96, title: 'Guard changes comparison semantics',
      explanation: 'The new branch returns before comparison.',
      failureScenario: 'A caller passing undefined receives a default result.',
      suggestedFix: null,
    }],
    coverage: {
      files: [{ path: 'src/a.js', previousPath: null, contextMissing: false, redacted: false }],
      skipped: [],
      partial: false,
    },
    ...overrides,
  };
}

test('valid finding with invalid anchor remains in summary-only report with owner and coverage', () => {
  const output = render(reviewResult(), { head: 'abc123' }, 'owner', 'marker');
  assert.equal(output.comments.length, 0);
  assert.match(output.body, /Guard changes comparison semantics/);
  assert.match(output.body, /@owner/);
  assert.match(output.body, /Summary-only review/);
  assert.match(output.body, /src\/a.js/);
});

test('maximum sized report retains skipped coverage instead of truncating its tail', () => {
  const finding = { ...reviewResult().findings[0], path: 'p'.repeat(1024), title: 't'.repeat(240),
    explanation: 'e'.repeat(1600), failureScenario: 'f'.repeat(800), suggestedFix: 's'.repeat(1000) };
  const result = reviewResult({
    summary: 'q'.repeat(1600),
    fileChanges: Array.from({ length: 30 }, () => ({ path: 'a'.repeat(200), change: 'c'.repeat(360), behavior: 'b'.repeat(500) })),
    findings: Array.from({ length: 5 }, () => finding),
    coverage: { files: Array.from({ length: 30 }, () => ({ path: 'r'.repeat(200) })),
      skipped: Array.from({ length: 25 }, () => ({ path: 'k'.repeat(200), reason: 'budget' })),
      skippedCount: 25, partial: true },
  });
  const output = render(result, { head: 'abc123' }, 'owner', 'marker');
  assert.ok(output.body.length <= 60000);
  assert.match(output.body, /Skipped \(25\):/);
  assert.match(output.body, /Summary-only review\.$/);
});

function fakeClient({ currentPR = livePR(), createReview = async () => ({ data: { id: 77 } }), reviews = [] } = {}) {
  return {
    paginate: {
      iterator: async function* () { yield { data: reviews }; },
    },
    rest: {
      pulls: {
        listReviews() {},
        get: async () => ({ data: currentPR }),
        createReview,
      },
    },
  };
}

function fakeStore(overrides = {}) {
  const state = { status: null, payload: null, marks: [], slots: [] };
  return {
    state,
    publication: async () => state.status ? { status: state.status } : null,
    claimPublication: async (id, payload) => {
      if (state.status && state.status !== 'retryable') return false;
      state.status = 'publishing';
      state.payload = payload;
      return true;
    },
    claimRecovery: async () => null,
    beginRecoveryWrite: async () => true,
    deferRecovery: async () => { state.status = 'publishing'; },
    releasePublication: async () => { state.status = 'retryable'; },
    mark: async (_id, status, reviewId = null) => { state.status = status; state.marks.push({ status, reviewId }); },
    reserveWriteSlot: async (operationId) => { state.slots.push(operationId); return new Date(); },
    ...overrides,
  };
}

const publishConfig = {
  github: { botAuthorAllowlist: [] },
  review: { maxFindings: 5, owner: 'owner', killSwitch: false },
};
const publishArgs = { owner: 'owner', repo: 'repo', pull_number: 3 };
const publishData = {
  installationId: 1, repositoryId: 2, owner: 'owner', repo: 'repo', prNumber: 3,
  prKey: '1:2:3', deliveryId: 'delivery-1',
};
const publishSnapshot = { base: 'base-sha', head: 'live-sha' };

test('ambiguous publication is reconciled and never blindly reposted', async () => {
  let writes = 0;
  const client = fakeClient({ createReview: async () => { writes++; throw new Error('socket timeout'); } });
  const store = fakeStore();
  const opts = {
    client, store, args: publishArgs, data: publishData, snapshot: publishSnapshot,
    result: reviewResult(), id: 'pub-id', botId: 5, config: publishConfig, pause: async () => {},
  };
  assert.equal(await publish(opts), 'publish_unknown');
  assert.equal(await publish(opts), 'publish_unknown');
  assert.equal(writes, 1);
});

test('stale publication performs no write', async () => {
  let writes = 0;
  const client = fakeClient({ currentPR: livePR({ head: { sha: 'new-sha' } }), createReview: async () => { writes++; } });
  const store = fakeStore();
  assert.equal(await publish({
    client, store, args: publishArgs, data: publishData, snapshot: { ...publishSnapshot, head: 'old-sha' },
    result: reviewResult(), id: 'stale-id', botId: 5, config: publishConfig, pause: async () => {},
  }), 'skipped_stale');
  assert.equal(writes, 0);
});

test('location 422 moves inline findings to one summary-only correction; generic 422 stops', async () => {
  for (const isLocationError of [true, false]) {
    let writes = 0;
    const client = fakeClient({ createReview: async (input) => {
      writes++;
      if (writes === 1) throw { status: 422, response: { data: { errors: [{ field: isLocationError ? 'line' : 'body' }] } } };
      assert.equal(input.comments.length, 0);
      return { data: { id: 88 } };
    } });
    const store = fakeStore();
    const status = await publish({
      client, store, args: publishArgs, data: publishData, snapshot: publishSnapshot,
      result: reviewResult({ findings: [{ ...reviewResult().findings[0], anchorValid: true, line: 1 }] }),
      id: `422-${isLocationError}`, botId: 5, config: publishConfig, pause: async () => {},
    });
    assert.equal(writes, isLocationError ? 2 : 1);
    assert.equal(status, isLocationError ? 'published' : 'failed');
  }
});

test('publication recovery checks marker, snapshot and performs at most one retry', async () => {
  const record = {
    id: 'recover-id', status: 'publish_unknown', installation_id: '1', owner: 'owner', repo: 'repo', pr_number: 3,
    base_sha: 'base-sha', head_sha: 'live-sha', bot_id: '5',
    output: { body: 'marker', comments: [] },
    summary_output: { body: 'marker summary-only', comments: [] },
  };
  const store = fakeStore({
    claimRecovery: async () => record,
    mark: async (_id, status, reviewId) => { store.state.status = status; store.state.marks.push({ status, reviewId }); },
  });
  let writes = 0;
  const client = fakeClient({ createReview: async () => { writes++; return { data: { id: 92 } }; } });
  assert.equal(await recoverPublication({ client, store, record, config: publishConfig, pause: async () => {} }), 'published');
  assert.equal(writes, 1);
  assert.equal(store.state.marks.at(-1).reviewId, 92);
});

test('publication recovery does not retry a write when marker lookup fails', async () => {
  const record = {
    id: 'recover-lookup-error', status: 'publish_unknown', installation_id: '1', owner: 'owner', repo: 'repo', pr_number: 3,
    base_sha: 'base-sha', head_sha: 'live-sha', bot_id: '5',
    output: { body: 'marker', comments: [] },
    summary_output: { body: 'marker summary-only', comments: [] },
  };
  let claims = 0;
  let writes = 0;
  const store = fakeStore({ claimRecovery: async () => { claims++; return record; } });
  const client = fakeClient({ createReview: async () => { writes++; return { data: { id: 93 } }; } });
  client.paginate.iterator = async function* () { throw new Error('GitHub review lookup unavailable'); };

  await assert.rejects(recoverPublication({ client, store, record, config: publishConfig, pause: async () => {} }));
  assert.equal(claims, 0);
  assert.equal(writes, 0);
});

test('per-PR reservation prevents excess and release is safe to repeat', async () => {
  const store = Object.create(Store.prototype);
  let deleted = 0;
  let updated = 0;
  store.transaction = async (callback) => callback({ query: async (sql) => {
    if (sql.startsWith('DELETE')) { deleted++; return { rows: [{ day: '2026-11-22', repo: '2', pr_key: 'pr:2:3', amount: '100' }] }; }
    if (sql.startsWith('UPDATE')) updated++;
    return { rows: [] };
  } });
  assert.equal(await store.releaseReservation('run:review'), true);
  assert.equal(deleted, 1);
  assert.equal(updated, 1);
});

test('budget reservation checks global, repository and PR scopes atomically', async () => {
  const store = Object.create(Store.prototype);
  let writes = 0;
  store.transaction = async (callback) => callback({ query: async (sql, params) => {
    if (sql.startsWith('SELECT status')) return { rows: [] };
    if (sql.startsWith('SELECT scope')) return { rows: [
      { scope: 'global', used: '0' }, { scope: '2', used: '0' }, { scope: 'pr:2:3', used: '95' },
    ] };
    if (sql.startsWith('UPDATE') || sql.startsWith('INSERT INTO review_reservation')) writes++;
    return { rows: [] };
  } });
  const result = await store.reserve('run:review', '2', 'pr:2:3', 10, {
    globalDailyTokenLimit: 1000, dailyTokenLimit: 1000, prDailyTokenLimit: 100,
  });
  assert.deepEqual(result, { reserved: false, reason: 'limit' });
  assert.equal(writes, 0);
});

test('token reconciliation persists the safe model result and avoids duplicate accounting', async () => {
  const store = Object.create(Store.prototype);
  const calls = [];
  store.transaction = async (callback) => callback({ query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT *')) return { rows: [{ status: 'reserved', day: '2026-11-22', repo: '2', pr_key: 'pr:2:3', amount: '100' }] };
    return { rows: [] };
  } });
  const safeResult = { status: 'complete', summary: 'synthetic', findings: [] };
  assert.equal(await store.reconcile('run:review', 42, safeResult), true);
  assert.equal(calls.filter((call) => call.sql.startsWith('UPDATE review_budget')).length, 1);
  const persisted = calls.find((call) => call.sql.includes("SET status='accounted'"));
  assert.equal(JSON.parse(persisted.params[2]).summary, 'synthetic');

  store.transaction = async (callback) => callback({ query: async (sql) => {
    if (sql.startsWith('SELECT *')) return { rows: [{ status: 'accounted' }] };
    throw new Error('accounted reservation must not update counters');
  } });
  assert.equal(await store.reconcile('run:review', 42, safeResult), false);
});

test('review Inngest contract keeps debounce, retries, keyed concurrency and cancellation', () => {
  const config = {
    github: { repositoryAllowlist: ['owner/repo'], botAuthorAllowlist: [] },
    review: { globalConcurrency: 5, killSwitch: false },
  };
  let functionOptions;
  const fakeInngest = { createFunction: (options, handler) => { functionOptions = options; return { handler }; } };
  createReviewFunction(fakeInngest, config, {});
  assert.equal(functionOptions.retries, 3);
  assert.deepEqual(functionOptions.debounce, { period: '20s', timeout: '2m', key: 'event.data.prKey' });
  assert.equal(functionOptions.concurrency[1].key, 'event.data.prKey');
  assert.equal(functionOptions.cancelOn[0].event, CANCEL_REVIEW_EVENT);
  assert.match(functionOptions.cancelOn[0].if, /observedAt/);
});

test('review step persists only sanitized findings and bounded coverage, never raw source', async () => {
  const sourceSecret = 'ghp_12345678901234567890';
  const source = `const result = true;\n// token=${sourceSecret}`;
  const fileList = async function listFiles() {};
  const reviewList = async function listReviews() {};
  let createReviewCalls = 0;
  const client = {
    paginate: { iterator: async function* (endpoint) { yield { data: endpoint === fileList ? [{
      filename: 'src/a.js', status: 'modified', patch: '@@ -0,0 +1,1 @@\n+const result = true;',
    }] : [] }; } },
    rest: {
      pulls: {
        listFiles: fileList,
        listReviews: reviewList,
        get: async () => ({ data: livePR({ updated_at: '2026-11-22T00:00:00Z' }) }),
        createReview: async () => { createReviewCalls++; return { data: { id: 101 } }; },
      },
      repos: {
        getContent: async () => ({ data: {
          type: 'file', encoding: 'base64', size: Buffer.byteLength(source),
          content: Buffer.from(source).toString('base64'),
        } }),
      },
      apps: { getAuthenticated: async () => ({ data: { id: 9, slug: 'review-bot' } }) },
      users: { getByUsername: async () => ({ data: { id: 5 } }) },
    },
  };
  let reconciledResult;
  const store = {
    reserve: async () => ({ reserved: true }),
    reconcile: async (_id, _usage, result) => { reconciledResult = result; },
    markReservationUnknown: async () => {},
    releaseReservation: async () => {},
    claimPublication: async () => true,
    reserveWriteSlot: async () => new Date(),
    mark: async () => {},
  };
  const config = {
    ...aiConfig,
    github: { repositoryAllowlist: ['owner/repo'], botAuthorAllowlist: [] },
    review: {
      ...aiConfig.review,
      maxFiles: 30,
      maxInputChars: 80000,
      maxInputTokens: 24000,
      globalConcurrency: 5,
      dailyTokenLimit: 100000,
      globalDailyTokenLimit: 500000,
      prDailyTokenLimit: 50000,
      killSwitch: false,
    },
  };
  const modelOutput = completedAIOutput();
  const fakeInngest = { createFunction: (_options, handler) => handler };
  const handler = createReviewFunction(fakeInngest, config, store, {
    installationClient: () => client,
    aiClient: () => ({ responses: { create: async (requestBody) => {
      assert.doesNotMatch(requestBody.input, new RegExp(sourceSecret));
      return { status: 'completed', output_text: JSON.stringify(modelOutput), usage: { total_tokens: 40 } };
    } } }),
  });
  const stepValues = {};
  const step = {
    run: async (name, fn) => { const value = await fn(); stepValues[name] = value; return value; },
    sendEvent: async () => {},
  };
  const data = {
    ...publishData,
    observedAt: '2026-11-22T00:00:00Z',
    observedHeadSha: 'live-sha',
    observedBaseSha: 'base-sha',
  };
  const output = await handler({ event: { data }, step, runId: 'run-synthetic' });
  assert.equal(output.status, 'published');
  assert.equal(createReviewCalls, 1);
  assert.ok(reconciledResult);
  assert.doesNotMatch(JSON.stringify(stepValues.review), new RegExp(sourceSecret));
  assert.doesNotMatch(JSON.stringify(reconciledResult), new RegExp(sourceSecret));
  assert.equal(stepValues.review.coverage.files[0].path, 'src/a.js');
});

test('publication recovery scheduler is a bounded once-per-minute Inngest function', () => {
  let options;
  const fakeInngest = { createFunction: (value) => { options = value; return {}; } };
  createPublicationRecoveryFunction(fakeInngest, {}, {});
  assert.equal(options.triggers.cron, '*/1 * * * *');
  assert.deepEqual(options.concurrency, { limit: 1 });
  assert.equal(options.retries, 3);
});

test('failed delivery uses the same delivery ID when GitHub redelivers', async () => {
  const events = [];
  const app = webhookApp({ send: async (event) => events.push(event) });
  await signedPost(app, basePayload, { delivery: 'stable-guid' });
  await signedPost(app, basePayload, { delivery: 'stable-guid' });
  assert.equal(events[0].id, events[1].id);
  assert.equal(pullRequestKey(events[0].data), '1:2:3');
});
