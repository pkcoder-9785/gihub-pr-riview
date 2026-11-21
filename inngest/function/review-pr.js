import { NonRetriableError, RetryAfterError } from 'inngest';
import { installationClient } from '../../github/client.js';
import { CANCEL_REVIEW_EVENT, REVIEW_EVENT, optedOut, pullRequestKey } from '../../github/webhook.js';
import { collectContext } from '../../review/context.js';
import { aiClient, reviewAI } from '../../review/ai.js';
import { UnsupportedTokenizerError } from '../../review/tokenizer.js';
import { identity, sameSnapshot, classify } from '../../review/safety.js';
import { findReview, publish } from '../../review/publish.js';

function retryDelay(error) {
  const headers = error.response?.headers || {};
  const retryAfter = headers['retry-after'];
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(1000, at - Date.now());
  }
  const reset = Number(headers['x-ratelimit-reset']);
  return Number.isFinite(reset) && reset > 0 ? Math.max(1000, reset * 1000 - Date.now()) : 60000;
}

function explicitlyRejected(error) {
  return Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && error.status !== 408;
}

function eventDataValid(data) {
  return data && Number.isSafeInteger(data.installationId) && Number.isSafeInteger(data.repositoryId) &&
    Number.isSafeInteger(data.prNumber) && typeof data.owner === 'string' && typeof data.repo === 'string' &&
    typeof data.deliveryId === 'string' && typeof data.observedAt === 'string' && data.prKey === pullRequestKey(data);
}

export function createReviewFunction(inngest, config, store, dependencies = {}) {
  const getClient = dependencies.installationClient || installationClient;
  const getAI = dependencies.aiClient || aiClient;

  return inngest.createFunction({
    id: 'review-pr',
    triggers: { event: REVIEW_EVENT },
    retries: 3,
    debounce: {
      period: '20s',
      timeout: '2m',
      key: 'event.data.prKey',
    },
    concurrency: [
      { limit: config.review.globalConcurrency },
      { limit: 1, key: 'event.data.prKey' },
    ],
    cancelOn: [{
      event: CANCEL_REVIEW_EVENT,
      if: 'async.data.prKey == event.data.prKey && async.data.observedAt > event.data.observedAt',
    }],
  }, async ({ event, step, runId }) => {
    const data = event.data;
    const startedAt = Date.now();
    let activeSnapshot = null;
    const logResult = (status, extra = {}) => {
      console.info(JSON.stringify({
        category: 'review_run',
        runId,
        repositoryId: data?.repositoryId,
        prNumber: data?.prNumber,
        status,
        durationMs: Date.now() - startedAt,
        snapshot: activeSnapshot,
        ...extra,
      }));
      return { status };
    };

    if (!eventDataValid(data)) throw new NonRetriableError('Invalid pull request event metadata');
    const repoName = `${data.owner}/${data.repo}`.toLowerCase();
    if (!config.github.repositoryAllowlist.includes(repoName) || config.review.killSwitch) {
      return logResult('skipped');
    }

    const client = getClient(config.github, data.installationId);
    const args = { owner: data.owner, repo: data.repo, pull_number: data.prNumber };

    try {
      const initial = await step.run('snapshot', async () => {
        const pr = (await client.rest.pulls.get(args)).data;
        if (optedOut(pr, config.github.botAuthorAllowlist) || config.review.killSwitch) return null;
        const app = (await client.rest.apps.getAuthenticated()).data;
        const botId = (await client.rest.users.getByUsername({ username: `${app.slug}[bot]` })).data.id;
        return { base: pr.base.sha, head: pr.head.sha, botId };
      });
      if (!initial) return logResult('skipped_ineligible');
      activeSnapshot = { base: initial.base, head: initial.head };

      const reviewId = identity(data, initial, config);
      const result = await step.run('review', async () => {
        const before = (await client.rest.pulls.get(args)).data;
        if (optedOut(before, config.github.botAuthorAllowlist) || config.review.killSwitch || !sameSnapshot(before, initial)) {
          return { status: 'skipped_stale' };
        }
        const marker = `<!-- ai-review:${reviewId} -->`;
        if (await findReview(client, args, marker, initial.botId)) return { status: 'already_published' };

        const context = await collectContext(client, args, initial, config.review, {
          model: config.openai.model,
          pullRequest: before,
        });
        const after = (await client.rest.pulls.get(args)).data;
        if (optedOut(after, config.github.botAuthorAllowlist) || config.review.killSwitch || !sameSnapshot(after, initial)) {
          return { status: 'skipped_stale' };
        }

        const coverage = {
          files: context.files.map(({ path, previousPath, contextMissing, redacted, omittedHunks }) => ({
            path: path.slice(0, 1024),
            previousPath: previousPath?.slice(0, 1024) ?? null,
            contextMissing,
            redacted,
            omittedHunks,
          })),
          skipped: context.skipped.slice(0, 300).map(({ path, reason, omittedHunks }) => ({
            path: String(path).slice(0, 1024),
            reason: String(reason).slice(0, 80),
            ...(omittedHunks ? { omittedHunks } : {}),
          })),
          skippedCount: context.skipped.length,
          partial: context.partial,
        };
        if (!context.files.length) {
          const summary = context.skipped.length
            ? 'No files fit the configured review limits; AI review was skipped.'
            : 'No reviewable diff was available; AI review was skipped.';
          return {
            status: 'complete',
            summary,
            fileChanges: [],
            findings: [],
            usage: 0,
            coverage,
          };
        }

        const reservationId = `${runId}:review`;
        const maximumTokens = config.review.maxInputTokens + config.review.maxOutputTokens;
        let reservation;
        try {
          reservation = await store.reserve(
            reservationId,
            String(data.repositoryId),
            `pr:${data.repositoryId}:${data.prNumber}`,
            maximumTokens,
            config.review,
          );
        } catch {
          return { status: 'budget_unavailable', coverage };
        }
        if (!reservation.reserved) {
          if (reservation.result) return reservation.result;
          const status = reservation.reason === 'limit' ? 'budget_limited' :
            reservation.reason === 'unknown' ? 'budget_unknown_prior_call' : 'budget_prior_attempt';
          return { status, coverage };
        }

        let reviewed;
        try {
          reviewed = await reviewAI(getAI(config.openai), config, context);
        } catch (error) {
          if (explicitlyRejected(error)) await store.releaseReservation(reservationId);
          else await store.markReservationUnknown(reservationId);
          throw error;
        }
        const billable = Number.isSafeInteger(reviewed.usage) ? reviewed.usage : maximumTokens;
        const durableResult = { ...reviewed, coverage };
        await store.reconcile(reservationId, billable, durableResult);
        return durableResult;
      });

      if (result.status === 'skipped_stale') {
        const latest = await step.run('read-latest-after-stale', async () => {
          if (config.review.killSwitch) return null;
          const pr = (await client.rest.pulls.get(args)).data;
          if (optedOut(pr, config.github.botAuthorAllowlist)) return null;
          return {
            ...data,
            observedHeadSha: pr.head.sha,
            observedBaseSha: pr.base.sha,
            observedAt: pr.updated_at,
          };
        });
        if (latest) {
          await step.sendEvent('enqueue-latest-snapshot', {
            id: `review-refresh:${data.prKey}:${latest.observedBaseSha}:${latest.observedHeadSha}:${latest.observedAt}`,
            name: REVIEW_EVENT,
            data: latest,
          });
        }
        return logResult('skipped_stale');
      }
      if (result.status !== 'complete') return logResult(result.status, { usage: result.usage ?? null });

      const status = await step.run('publish', () => publish({
        client,
        store,
        args,
        data,
        snapshot: initial,
        result,
        id: reviewId,
        botId: initial.botId,
        config,
      }));
      if (status === 'skipped_stale' && !config.review.killSwitch) {
        const latest = await step.run('read-latest-before-refresh', async () => {
          const pr = (await client.rest.pulls.get(args)).data;
          if (optedOut(pr, config.github.botAuthorAllowlist)) return null;
          return {
            ...data,
            observedHeadSha: pr.head.sha,
            observedBaseSha: pr.base.sha,
            observedAt: pr.updated_at,
          };
        });
        if (latest) {
          await step.sendEvent('enqueue-latest-after-publish', {
            id: `review-refresh:${data.prKey}:${latest.observedBaseSha}:${latest.observedHeadSha}:${latest.observedAt}`,
            name: REVIEW_EVENT,
            data: latest,
          });
        }
      }
      return logResult(status, {
        usage: result.usage ?? null,
        coverage: {
          reviewedFiles: result.coverage.files.length,
          skippedFiles: result.coverage.skipped.length,
          partial: result.coverage.partial,
        },
      });
    } catch (error) {
      if (error instanceof UnsupportedTokenizerError) {
        console.error(JSON.stringify({ category: 'review_configuration_error', runId, field: 'OPENAI_MODEL_TOKENIZER' }));
        throw new NonRetriableError('Configured OpenAI model has no supported tokenizer');
      }
      const category = classify(error);
      if (category === 'permanent') throw new NonRetriableError('Review failed: permanent provider error');
      if (category === 'rate_limit') throw new RetryAfterError('Review rate limited', retryDelay(error));
      console.warn(JSON.stringify({ category: 'review_provider_transient_failure', runId, status: error.status ?? null }));
      throw new Error('Review failed: transient provider error');
    }
  });
}
