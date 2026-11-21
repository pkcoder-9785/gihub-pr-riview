import { randomUUID } from 'node:crypto';
import { optedOut } from '../github/webhook.js';
import { sameSnapshot, sanitize, classify } from './safety.js';

const RECOVERY_TTL_MINUTES = 15;
const reportText = (value, limit) => sanitize(value).slice(0, limit);

function findingText(finding) {
  const parts = [
    `**${reportText(finding.severity, 16)}: ${reportText(finding.title, 160)}**`,
    reportText(finding.explanation, 900),
    `Failure scenario: ${reportText(finding.failureScenario, 500)}`,
  ];
  if (finding.suggestedFix) parts.push(`Suggested fix: ${reportText(finding.suggestedFix, 400)}`);
  return parts.join('\n\n');
}

export function render(result, snapshot, owner, marker, { summaryOnly = false } = {}) {
  const comments = [];
  const fallback = [];
  const findings = result.findings.slice(0, 5);
  for (const finding of findings) {
    const text = findingText(finding);
    if (!summaryOnly && finding.anchorValid) {
      comments.push({ path: finding.path, line: finding.line, side: finding.side, body: text });
    } else {
      fallback.push(`${reportText(finding.path, 160)} — ${text}`);
    }
  }

  const fileChanges = result.fileChanges?.length
    ? result.fileChanges.slice(0, 30).map((file) => `- **${reportText(file.path, 120)}:** ${reportText(file.change, 240)} Behavior: ${reportText(file.behavior, 320)}`).join('\n')
    : 'Per-file behavior summary unavailable; see the reviewed diff and coverage below.';
  const coverage = result.coverage || { files: [], skipped: [], partial: true };
  const reviewedCount = coverage.files.length;
  const skippedCount = coverage.skippedCount ?? coverage.skipped.length;
  const reviewed = coverage.files.slice(0, 25).map((file) => reportText(file.path, 120));
  const skipped = coverage.skipped.slice(0, 25).map((file) => `${reportText(file.path, 120)} (${reportText(file.reason, 40)})`);
  if (reviewedCount > reviewed.length) reviewed.push(`...and ${reviewedCount - reviewed.length} more reviewed files`);
  if (skippedCount > skipped.length) skipped.push(`...and ${skippedCount - skipped.length} more skipped files`);
  const report = [
    marker,
    '## AI-generated report',
    owner ? `@${owner}` : '',
    `Reviewed commit: ${snapshot.head}`,
    '',
    '### PR author changes',
    reportText(result.summary, 1600),
    '',
    '### File-by-file changes',
    fileChanges,
    '',
    '### Bot findings',
    findings.length
      ? `${findings.length} advisory finding(s); bot made no code changes.`
      : 'No actionable issues found in reviewed scope.',
    fallback.join('\n\n'),
    '',
    '### Coverage',
    coverage.partial ? 'Partial review; some files or context were skipped.' : 'Reviewed available diff.',
    `Reviewed (${reviewedCount}): ${reviewed.join(', ') || 'none'}`,
    `Skipped (${skippedCount}): ${skipped.join(', ') || 'none'}`,
    comments.length === 0 ? 'Summary-only review.' : '',
  ].filter(Boolean).join('\n');

  return { body: report, comments };
}

export async function findReview(client, args, marker, botId) {
  for await (const page of client.paginate.iterator(client.rest.pulls.listReviews, { ...args, per_page: 100 })) {
    const review = page.data.find((item) => item.user?.id === botId && item.body?.includes(marker));
    if (review) return { id: review.id };
  }
  return null;
}

function isLocationError(error) {
  return error.status === 422 && error.response?.data?.errors?.some((item) =>
    ['line', 'side', 'path', 'position'].includes(item.field),
  );
}

async function freshPR(client, args, snapshot, config) {
  const { data: pr } = await client.rest.pulls.get(args);
  return !optedOut(pr, config.github.botAuthorAllowlist) && !config.review.killSwitch && sameSnapshot(pr, snapshot);
}

async function waitForWriteSlot(store, operationId, installationId, pause) {
  const scheduledAt = await store.reserveWriteSlot(operationId, installationId);
  const delay = Math.max(0, new Date(scheduledAt).getTime() - Date.now());
  if (delay > 0) await pause(delay);
}

async function attemptSummaryFallback({ client, args, snapshot, store, id, botId, installationId, summaryOutput, config, pause, operationId }) {
  await waitForWriteSlot(store, `${operationId}:summary:${randomUUID()}`, installationId, pause);
  const marker = `<!-- ai-review:${id} -->`;
  const existing = await findReview(client, args, marker, botId);
  if (existing) return { status: 'published', reviewId: existing.id };
  if (!await freshPR(client, args, snapshot, config)) return { status: 'skipped_stale' };
  const response = await client.rest.pulls.createReview({
    ...args,
    event: 'COMMENT',
    commit_id: snapshot.head,
    ...summaryOutput,
  });
  return { status: 'published', reviewId: response.data?.id ?? null };
}

function publicationPayload({ data, snapshot, botId, output, summaryOutput }) {
  return {
    installationId: data.installationId,
    repositoryId: data.repositoryId,
    owner: data.owner,
    repo: data.repo,
    prNumber: data.prNumber,
    snapshot,
    botId,
    output,
    summaryOutput,
  };
}

export async function publish({ client, store, args, data, snapshot, result, id, botId, config, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const marker = `<!-- ai-review:${id} -->`;
  const existing = await findReview(client, args, marker, botId);
  if (existing) {
    await store.mark(id, 'published', existing.id);
    return 'published';
  }

  if (!await freshPR(client, args, snapshot, config)) {
    await store.mark(id, 'skipped_stale');
    return 'skipped_stale';
  }

  const output = render(result, snapshot, config.review.owner, marker);
  const summaryOutput = render(result, snapshot, config.review.owner, marker, { summaryOnly: true });
  let claimed;
  try {
    claimed = await store.claimPublication(id, publicationPayload({ data, snapshot, botId, output, summaryOutput }));
  } catch {
    return 'publish_unknown';
  }
  if (!claimed) return 'publish_unknown';

  let postStarted = false;
  try {
    await waitForWriteSlot(store, `${id}:primary:${randomUUID()}`, data.installationId, pause);
    const accepted = await findReview(client, args, marker, botId);
    if (accepted) {
      await store.mark(id, 'published', accepted.id);
      return 'published';
    }
    if (!await freshPR(client, args, snapshot, config)) {
      await store.mark(id, 'skipped_stale');
      return 'skipped_stale';
    }
    postStarted = true;
    const response = await client.rest.pulls.createReview({ ...args, event: 'COMMENT', commit_id: snapshot.head, ...output });
    await store.mark(id, 'published', response.data?.id ?? null);
    return 'published';
  } catch (error) {
    if (!postStarted) {
      await store.releasePublication(id).catch(() => {});
      throw error;
    }
    const reconciled = await findReview(client, args, marker, botId).catch(() => null);
    if (reconciled) {
      await store.mark(id, 'published', reconciled.id);
      return 'published';
    }
    if (isLocationError(error)) {
      try {
        const fallback = await attemptSummaryFallback({ client, args, snapshot, store, id, botId, installationId: data.installationId, summaryOutput, config, pause, operationId: id });
        await store.mark(id, fallback.status, fallback.reviewId ?? null);
        return fallback.status;
      } catch (fallbackError) {
        const accepted = await findReview(client, args, marker, botId).catch(() => null);
        if (accepted) {
          await store.mark(id, 'published', accepted.id);
          return 'published';
        }
        await store.mark(id, classify(fallbackError) === 'permanent' ? 'failed' : 'publish_unknown');
        return classify(fallbackError) === 'permanent' ? 'failed' : 'publish_unknown';
      }
    }
    if (classify(error) === 'rate_limit') {
      await store.releasePublication(id);
      throw error;
    }
    const status = classify(error) === 'permanent' ? 'failed' : 'publish_unknown';
    await store.mark(id, status);
    return status;
  }
}

export async function recoverPublication({ client, store, record, config, claimId = record.id, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const args = { owner: record.owner, repo: record.repo, pull_number: record.pr_number };
  const snapshot = { base: record.base_sha, head: record.head_sha };
  const marker = `<!-- ai-review:${record.id} -->`;
  const botId = Number(record.bot_id);
  // A failed lookup does not prove the marker is absent. Let the durable
  // workflow retry the read instead of risking a duplicate review write.
  const found = await findReview(client, args, marker, botId);
  if (found) {
    await store.mark(record.id, 'published', found.id);
    return 'published';
  }

  const claimed = await store.claimRecovery(record.id, RECOVERY_TTL_MINUTES, claimId);
  if (!claimed) return 'not_due';
  const output = claimed.output;
  const summaryOutput = claimed.summary_output;
  const installationId = claimed.installation_id;
  if (!output || !summaryOutput || !installationId) {
    await store.mark(record.id, 'failed');
    return 'failed';
  }

  let postStarted = false;
  try {
    if (!await freshPR(client, args, snapshot, config)) {
      await store.mark(record.id, 'skipped_stale');
      return 'skipped_stale';
    }
    await waitForWriteSlot(store, `${record.id}:recovery:${randomUUID()}`, installationId, pause);
    const again = await findReview(client, args, marker, botId);
    if (again) {
      await store.mark(record.id, 'published', again.id);
      return 'published';
    }
    if (!await freshPR(client, args, snapshot, config)) {
      await store.mark(record.id, 'skipped_stale');
      return 'skipped_stale';
    }
    if (!await store.beginRecoveryWrite(record.id, claimId)) return 'publish_unknown';
    postStarted = true;
    const response = await client.rest.pulls.createReview({ ...args, event: 'COMMENT', commit_id: snapshot.head, ...output });
    await store.mark(record.id, 'published', response.data?.id ?? null);
    return 'published';
  } catch (error) {
    if (!postStarted) {
      if (classify(error) === 'permanent') {
        await store.mark(record.id, 'failed');
        return 'failed';
      }
      await store.deferRecovery(record.id, claimId);
      return 'deferred';
    }
    const reconciled = postStarted ? await findReview(client, args, marker, botId).catch(() => null) : null;
    if (reconciled) {
      await store.mark(record.id, 'published', reconciled.id);
      return 'published';
    }
    if (postStarted && isLocationError(error)) {
      try {
        const fallback = await attemptSummaryFallback({ client, args, snapshot, store, id: record.id, botId, installationId, summaryOutput, config, pause, operationId: `${record.id}:recovery` });
        await store.mark(record.id, fallback.status, fallback.reviewId ?? null);
        return fallback.status;
      } catch (fallbackError) {
        const accepted = await findReview(client, args, marker, botId).catch(() => null);
        if (accepted) {
          await store.mark(record.id, 'published', accepted.id);
          return 'published';
        }
        await store.mark(record.id, classify(fallbackError) === 'permanent' ? 'failed' : 'publish_unknown');
        return classify(fallbackError) === 'permanent' ? 'failed' : 'publish_unknown';
      }
    }
    const status = classify(error) === 'permanent' ? 'failed' : 'publish_unknown';
    await store.mark(record.id, status);
    return status;
  }
}

export { RECOVERY_TTL_MINUTES };
